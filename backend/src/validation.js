const config = require('./config');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const SUPPORTED = new Set(['cpp', 'java', 'py', 'python']);

const requireCode = (code) => {
  if (typeof code !== 'string' || !code.trim()) throw new ValidationError('Code is required.');
  if (code.length > config.limits.maxCodeChars) {
    throw new ValidationError(`Code is too long (max ${config.limits.maxCodeChars / 1024} KB).`);
  }
  return code;
};

const optionalCode = (code) => (code === undefined || code === null || code === '' ? '' : requireCode(code));

const requireLanguage = (language) => {
  if (!SUPPORTED.has(language)) throw new ValidationError('Language must be one of: cpp, java, py.');
  return language === 'python' ? 'py' : language;
};

const optionalLanguage = (language) => (SUPPORTED.has(language) ? requireLanguage(language) : '');

const inputString = (value, label = 'Input') => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string.`);
  if (value.length > config.limits.maxInputChars) {
    throw new ValidationError(`${label} is too long (max ${config.limits.maxInputChars / 1024} KB).`);
  }
  return value;
};

const testCaseList = (testCases) => {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new ValidationError('testCases must be a non-empty array.');
  }
  if (testCases.length > config.limits.maxTestCases) {
    throw new ValidationError(`Too many test cases (max ${config.limits.maxTestCases}).`);
  }
  return testCases.map((tc, i) => {
    if (!tc || typeof tc !== 'object') throw new ValidationError(`Test case ${i + 1} is invalid.`);
    return {
      input: inputString(tc.input, `Test case ${i + 1} input`),
      expectedOutput: inputString(tc.expectedOutput, `Test case ${i + 1} expected output`),
    };
  });
};

/**
 * Keep only user/assistant turns with string content, clipped in size and
 * count. Clients can't inject `system` messages or blow up token usage.
 */
const chatMessages = (messages) => {
  if (!Array.isArray(messages)) throw new ValidationError('messages must be an array.');
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, config.ai.maxMessageChars) }))
    .slice(-config.ai.maxMessages);

  // Most chat APIs expect the conversation to start with a user turn.
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    throw new ValidationError('The last message must be from the user.');
  }
  return clean;
};

/** Compare program output, ignoring trailing whitespace and CRLF vs LF. */
const normalizeOutput = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

module.exports = {
  ValidationError,
  requireCode,
  optionalCode,
  requireLanguage,
  optionalLanguage,
  inputString,
  testCaseList,
  chatMessages,
  normalizeOutput,
};
