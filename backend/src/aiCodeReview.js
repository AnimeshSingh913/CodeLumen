const Groq = require('groq-sdk');
const config = require('./config');
const { ragAiChat, retriever } = require('./langchainRag');
const { buildTutorPrompt, clipCode, languageName } = require('./prompts');

let client = null;
const groq = () => {
  if (!client) client = new Groq({ apiKey: config.groq.apiKey });
  return client;
};

const complete = async (messages, temperature = 0.3) => {
  const completion = await groq().chat.completions.create({
    messages,
    model: config.groq.model,
    temperature,
  });
  return completion.choices[0]?.message?.content || '';
};

/**
 * Tutor chat. Tries the RAG + tool-calling agent first and falls back to a
 * plain completion with the same guardrails if the agent fails.
 * `messages` must already be sanitized to user/assistant roles.
 */
const aiChat = async (messages, code, language) => {
  try {
    return await ragAiChat(messages, code, language);
  } catch (ragError) {
    if (ragError?.status === 429) throw ragError;
    console.warn('RAG pipeline failed, using plain completion:', ragError?.message);

    const reply = await complete([
      { role: 'system', content: buildTutorPrompt({ code, language }) },
      ...messages,
    ]);
    return { reply, sources: [], toolCalls: [], ragEnabled: false };
  }
};

const getComplexityAnalysis = async (code) =>
  complete(
    [
      {
        role: 'system',
        content:
          'You analyze algorithmic complexity. Reply with ONLY these two lines and nothing else:\nTime Complexity: <Big-O>\nSpace Complexity: <Big-O>',
      },
      { role: 'user', content: clipCode(code) },
    ],
    0
  );

const explainError = async (errorMessage, code = '', language = '') => {
  let reference = '';
  const docs = retriever.retrieve(`${errorMessage} ${code.slice(0, 500)}`, language || 'general', 1);
  if (docs.length > 0) reference = `\n\nRelevant reference documentation:\n${docs[0].pageContent}`;

  return complete([
    { role: 'system', content: 'You are an expert programming tutor specializing in error analysis and debugging.' },
    {
      role: 'user',
      content: `Explain the following error message in a clear, educational way.

Error message:
${errorMessage.slice(0, 4000)}
Programming language: ${languageName(language)}${code ? `\n\nCode context:\n${clipCode(code)}` : ''}${reference}

Please cover:
1. **What the error means**, in simple terms
2. **Why it occurred**: the root cause
3. **How to fix it**: specific steps
4. **Prevention tips**: brief advice to avoid it in future

Keep it concise and beginner-friendly.`,
    },
  ]);
};

module.exports = {
  aiChat,
  getComplexityAnalysis,
  explainError,
};
