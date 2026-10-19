const { ChatGroq } = require('@langchain/groq');
const { tool } = require('@langchain/core/tools');
const { ToolMessage, AIMessage, HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { z } = require('zod');
const config = require('./config');
const { KNOWLEDGE_DOCS } = require('./ragKnowledgeBase');
const { executeCode, normalizeLanguage } = require('./executeCode');
const { buildTutorPrompt, isRefusal, languageName } = require('./prompts');

/**
 * TF-IDF retriever over the curated knowledge base. Scores documents by
 * cosine similarity, boosts the active language and excludes other
 * languages. Small and dependency-free; swap for an embedding store if the
 * knowledge base grows beyond a few hundred documents.
 */
class TfIdfRetriever {
  constructor(docs) {
    this.documents = docs.map((d) => ({
      pageContent: `${d.topic}\n${d.content}\nKeywords: ${d.keywords.join(' ')}`,
      metadata: { id: d.id, topic: d.topic, language: d.language },
    }));
    this.idf = {};
    this.docVectors = [];
    this._buildIndex();
  }

  _tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_#]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  _vectorize(tokens) {
    const tf = {};
    tokens.forEach((t) => { tf[t] = (tf[t] || 0) + 1; });
    const vector = {};
    let magnitudeSq = 0;
    for (const t in tf) {
      const weight = (tf[t] / tokens.length) * (this.idf[t] || 1);
      vector[t] = weight;
      magnitudeSq += weight * weight;
    }
    return { vector, magnitude: Math.sqrt(magnitudeSq) || 1 };
  }

  _buildIndex() {
    const N = this.documents.length;
    const tokenized = this.documents.map((doc) => this._tokenize(doc.pageContent));

    for (const tokens of tokenized) {
      new Set(tokens).forEach((t) => { this.idf[t] = (this.idf[t] || 0) + 1; });
    }
    for (const t in this.idf) {
      this.idf[t] = Math.log(1 + N / this.idf[t]);
    }
    this.docVectors = tokenized.map((tokens) => this._vectorize(tokens));
  }

  /**
   * Top-k documents for the query, restricted to `language` + general docs.
   */
  retrieve(query, language = 'general', topK = 2) {
    const tokens = this._tokenize(query);
    if (tokens.length === 0) return [];
    const { vector: qv, magnitude: qm } = this._vectorize(tokens);

    return this.documents
      .map((doc, idx) => {
        const { vector, magnitude } = this.docVectors[idx];
        let dot = 0;
        for (const t in qv) if (vector[t]) dot += qv[t] * vector[t];
        let score = dot / (qm * magnitude);
        if (doc.metadata.language === language) score *= 1.5;
        else if (doc.metadata.language !== 'general') score = 0;
        return { doc, score };
      })
      .filter((item) => item.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ doc, score }) => ({ ...doc, relevanceScore: Math.min(0.99, Number(score.toFixed(3))) }));
  }
}

const retriever = new TfIdfRetriever(KNOWLEDGE_DOCS);

const getGroqLlm = (temperature = 0.3) =>
  new ChatGroq({ apiKey: config.groq.apiKey, model: config.groq.model, temperature });

// LangChain message content can be a string or an array of content parts.
const contentToText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
};

const executeCodeTool = tool(
  async ({ language, code, input }) => {
    try {
      const stdout = await executeCode(language, code, input || '');
      return `Execution Successful.\nSTDOUT:\n${stdout.slice(0, 4000)}`;
    } catch (err) {
      return `Execution Failed.\nError:\n${String(err.message).slice(0, 4000)}`;
    }
  },
  {
    name: 'executeCodeTool',
    description:
      "Executes code in Python ('py'), C++ ('cpp'), or Java ('java') with optional standard input inside the sandbox. Returns stdout or the compiler/runtime error. Use it when the user asks whether their code works, asks to test an input, or when you need to verify that a bug actually triggers.",
    schema: z.object({
      language: z.enum(['py', 'cpp', 'java', 'python']).describe("Programming language: 'py', 'cpp', or 'java'"),
      code: z.string().describe('The source code to compile and run'),
      input: z.string().optional().default('').describe('Optional standard input for the program'),
    }),
  }
);

const searchDocsTool = tool(
  async ({ query, language }) => {
    const docs = retriever.retrieve(query, language || 'general', 2);
    if (docs.length === 0) return 'No specific documentation found for this query in the local knowledge base.';
    return docs.map((d) => `[${d.metadata.topic}]\n${d.pageContent}`).join('\n\n');
  },
  {
    name: 'searchDocsTool',
    description:
      'Searches the curated knowledge base of language references, standard libraries (STL, Collections, itertools, heapq), and DSA patterns.',
    schema: z.object({
      query: z.string().describe('Concept, error message, or library function to search for'),
      language: z.string().optional().default('general').describe("Language context: 'cpp', 'py', 'java', or 'general'"),
    }),
  }
);

/**
 * Runs the tool calls the model requested, capped per turn. Code execution is
 * only allowed in the user's active language.
 */
const runToolCalls = async (toolCalls, activeLanguage) => {
  const messages = [];
  const record = [];

  for (const [index, tc] of toolCalls.entries()) {
    let output;
    if (index >= config.ai.maxToolCallsPerTurn) {
      output = 'Tool call skipped: per-turn tool limit reached.';
    } else if (tc.name === 'executeCodeTool') {
      let requested;
      try {
        requested = normalizeLanguage(tc.args?.language);
      } catch {
        requested = null;
      }
      if (requested !== activeLanguage) {
        output = `Tool call rejected: only ${languageName(activeLanguage)} code can be executed in this session.`;
      } else {
        output = await executeCodeTool.invoke(tc.args);
        record.push({ name: 'executeCode', args: { language: requested }, summary: 'Executed code to test behavior' });
      }
    } else if (tc.name === 'searchDocsTool') {
      output = await searchDocsTool.invoke(tc.args);
      record.push({ name: 'searchDocs', args: { query: String(tc.args?.query || '').slice(0, 200) }, summary: 'Searched documentation knowledge base' });
    } else {
      output = 'Tool not found.';
    }
    messages.push(new ToolMessage({ content: output, tool_call_id: tc.id }));
  }

  return { messages, record };
};

/**
 * RAG + tool-calling tutor:
 * 1. Retrieve relevant docs for the latest question.
 * 2. Let the model call executeCodeTool / searchDocsTool (one round, capped).
 * 3. Return a grounded, hint-style reply with its sources.
 *
 * `messages` must already be sanitized (user/assistant roles only).
 */
const ragAiChat = async (messages, code, language) => {
  const latestInquiry = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const retrievedDocs = retriever.retrieve(`${latestInquiry} ${language} ${code.slice(0, 500)}`, language, 2);

  const sources = retrievedDocs.map((doc) => ({
    topic: doc.metadata.topic,
    language: doc.metadata.language,
    relevance: doc.relevanceScore,
  }));
  const ragContext = retrievedDocs.length
    ? retrievedDocs.map((doc, idx) => `[DOCUMENT ${idx + 1}: ${doc.metadata.topic}]\n${doc.pageContent}`).join('\n\n')
    : null;

  const chatMessages = [
    new SystemMessage(buildTutorPrompt({ code, language, ragContext, withTools: true })),
    ...messages.map((m) => (m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content))),
  ];

  const llm = getGroqLlm(0.3);
  const aiResponse = await llm.bindTools([executeCodeTool, searchDocsTool]).invoke(chatMessages);

  let reply;
  let toolCalls = [];
  if (aiResponse.tool_calls?.length) {
    const { messages: toolMessages, record } = await runToolCalls(aiResponse.tool_calls, language);
    toolCalls = record;
    const finalResponse = await llm.invoke([...chatMessages, aiResponse, ...toolMessages]);
    reply = contentToText(finalResponse.content);
  } else {
    reply = contentToText(aiResponse.content);
  }

  const refused = isRefusal(reply);
  return {
    reply,
    sources: refused ? [] : sources,
    toolCalls,
    ragEnabled: !refused && sources.length > 0,
  };
};

module.exports = {
  ragAiChat,
  retriever,
  TfIdfRetriever,
};
