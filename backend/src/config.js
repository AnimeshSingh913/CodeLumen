const path = require('path');

// Load backend/.env if present (Node's built-in loader; real environment
// variables take precedence).
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* no .env file */
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value) =>
  (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: int(process.env.PORT, 8000),

  // Number of reverse-proxy hops in front of the app (Render/Nginx = 1).
  // req.ip is derived from X-Forwarded-For only across these trusted hops,
  // so clients cannot spoof their IP to dodge quotas.
  trustProxy: int(process.env.TRUST_PROXY, 1),

  // Comma-separated list of allowed browser origins. Localhost is always
  // allowed outside production.
  corsOrigins: list(process.env.CORS_ORIGINS),

  mongoUri: process.env.MONGODB_URI || '',

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL_ID || 'llama-3.3-70b-versatile',
  },

  admin: {
    // Admin endpoints are disabled entirely unless a strong password is set.
    password: process.env.ADMIN_PASSWORD || '',
    // Secret used to sign admin session tokens. Falls back to a random
    // per-process secret (sessions then reset on restart).
    sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
    sessionTtlMs: int(process.env.ADMIN_SESSION_TTL_HOURS, 8) * 60 * 60 * 1000,
  },

  ai: {
    defaultLimit: int(process.env.AI_DEFAULT_LIMIT, 5),
    maxMessages: 20,
    maxMessageChars: 4000,
    maxCodeCharsInPrompt: 12000,
    maxToolCallsPerTurn: 2,
  },

  limits: {
    maxCodeChars: 64 * 1024,
    maxInputChars: 64 * 1024,
    maxTestCases: 20,
  },

  sandbox: {
    // 'hardened' (Linux + root inside container, drops to SANDBOX_UID per run)
    // or 'none' (local development only). 'auto' picks hardened when possible.
    mode: process.env.SANDBOX_MODE || 'auto',
    allowUnsafe: process.env.ALLOW_UNSAFE_EXECUTION === 'true',
    uid: int(process.env.SANDBOX_UID, 10001),
    gid: int(process.env.SANDBOX_GID, 10001),
    workRoot: process.env.SANDBOX_WORKDIR || '',
    runTimeoutMs: int(process.env.SANDBOX_RUN_TIMEOUT_MS, 5000),
    compileTimeoutMs: int(process.env.SANDBOX_COMPILE_TIMEOUT_MS, 15000),
    maxOutputBytes: int(process.env.SANDBOX_MAX_OUTPUT_BYTES, 256 * 1024),
    memoryLimitMb: int(process.env.SANDBOX_MEMORY_MB, 256),
    maxProcesses: int(process.env.SANDBOX_MAX_PROCESSES, 256),
    maxFileSizeMb: int(process.env.SANDBOX_MAX_FILE_MB, 16),
    maxConcurrency: int(process.env.SANDBOX_MAX_CONCURRENCY, 4),
    maxQueue: int(process.env.SANDBOX_MAX_QUEUE, 32),
    pythonBin: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  },
};

module.exports = config;
