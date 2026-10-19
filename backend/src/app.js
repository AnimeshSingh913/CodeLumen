const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { executeCode, executeTests, sandboxMode } = require('./executeCode');
const { aiChat, getComplexityAnalysis, explainError } = require('./aiCodeReview');
const { logUsage, getStats } = require('./analytics');
const adminAuth = require('./adminAuth');
const v = require('./validation');
const {
  getClientIp,
  getStatus,
  reserveAiUsage,
  releaseAiUsage,
  getAllLimits,
  updateIpLimit,
  resetIpUsage,
  updateGlobalLimit,
} = require('./aiLimiter');

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const limiter = (windowMs, limit, error, extra = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error },
    ...extra,
  });

const usageOf = (q) => ({ used: q.used, limit: q.limit, remaining: q.remaining, limitReached: q.limitReached });

const isProviderRateLimit = (err) => err?.status === 429 || err?.error?.error?.code === 'rate_limit_exceeded';

function createApp() {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        const allowed =
          !origin ||
          config.corsOrigins.includes('*') ||
          config.corsOrigins.includes(origin) ||
          (!config.isProduction && LOCAL_ORIGIN.test(origin));
        callback(null, allowed);
      },
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: '256kb' }));

  app.use(limiter(15 * 60 * 1000, 300, 'Too many requests from this IP, please try again in a few minutes.'));
  const executionLimiter = limiter(60 * 1000, 30, 'You are running code too quickly. Please wait a minute.');
  const loginLimiter = limiter(15 * 60 * 1000, 5, 'Too many login attempts. Try again in 15 minutes.', {
    skipSuccessfulRequests: true,
  });

  const track = (req, endpoint, language, status) =>
    logUsage(getClientIp(req), endpoint, language, status, req.headers['user-agent']);

  /* ---------------------------- Public ---------------------------- */

  app.get('/', (req, res) => {
    res.json({ name: 'CodeLumen API', status: 'ok' });
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      sandbox: sandboxMode(),
      aiConfigured: Boolean(config.groq.apiKey),
      databaseConnected: mongoose.connection.readyState === 1,
      adminEnabled: adminAuth.adminEnabled(),
    });
  });

  app.get('/ai-limit-status', async (req, res) => {
    const status = await getStatus(getClientIp(req));
    res.json({ success: true, used: status.used, limit: status.limit, remaining: status.remaining, limitReached: status.limitReached });
  });

  /* --------------------------- Execution -------------------------- */

  app.post('/run', executionLimiter, async (req, res) => {
    const code = v.requireCode(req.body?.code);
    const language = v.requireLanguage(req.body?.language);
    const input = v.inputString(req.body?.input);

    const startedAt = Date.now();
    try {
      const output = await executeCode(language, code, input);
      track(req, '/run', language, 'success');
      res.json({ success: true, output, executionTimeMs: Date.now() - startedAt });
    } catch (err) {
      track(req, '/run', language, 'error');
      throw err;
    }
  });

  app.post('/run-tests', executionLimiter, async (req, res) => {
    const code = v.requireCode(req.body?.code);
    const language = v.requireLanguage(req.body?.language);
    const testCases = v.testCaseList(req.body?.testCases);

    try {
      const results = await executeTests(language, code, testCases.map((tc) => tc.input));
      track(req, '/run-tests', language, 'success');
      res.json({
        success: true,
        results: results.map((result, i) => {
          const expectedOutput = testCases[i].expectedOutput.trim();
          if (!result.success) return { passed: false, error: result.error, expectedOutput };
          const actualOutput = result.output.trim();
          return {
            passed: v.normalizeOutput(actualOutput) === v.normalizeOutput(expectedOutput),
            actualOutput,
            expectedOutput,
            durationMs: result.durationMs,
          };
        }),
      });
    } catch (err) {
      track(req, '/run-tests', language, 'error');
      throw err;
    }
  });

  /* ------------------------------ AI ------------------------------ */

  /**
   * Validates first, then atomically reserves one AI message for the client.
   * The reservation is refunded if the AI call fails.
   */
  const aiRoute = (endpoint, { validate, run }) => async (req, res) => {
    if (!config.groq.apiKey) {
      return res.status(503).json({ success: false, error: 'AI features are not configured on this server.' });
    }
    const args = validate(req.body || {});
    const ip = getClientIp(req);
    const quota = await reserveAiUsage(ip, req.headers['user-agent']);

    if (!quota.allowed) {
      track(req, endpoint, args.language, 'limit_exceeded');
      return res.status(429).json({
        success: false,
        limitReached: true,
        error: `AI message limit reached (${quota.used}/${quota.limit} used). Please contact the admin to increase your limit.`,
        usage: usageOf(quota),
      });
    }

    try {
      const body = await run(args);
      track(req, endpoint, args.language, 'success');
      res.json({ success: true, ...body, usage: usageOf(quota) });
    } catch (err) {
      await releaseAiUsage(ip);
      track(req, endpoint, args.language, 'error');
      console.error(`${endpoint} failed:`, err?.message);
      if (isProviderRateLimit(err)) {
        return res.status(429).json({ success: false, error: 'The AI provider is busy. Please wait a minute and try again.' });
      }
      res.status(502).json({ success: false, error: 'The AI request failed. Please try again.' });
    }
  };

  app.post(
    '/analyze',
    aiRoute('/analyze', {
      validate: (body) => ({ code: v.requireCode(body.code), language: v.optionalLanguage(body.language) }),
      run: async ({ code }) => ({ complexity: await getComplexityAnalysis(code) }),
    })
  );

  app.post(
    '/ai-review',
    aiRoute('/ai-review', {
      validate: (body) => ({
        messages: v.chatMessages(body.messages),
        code: v.optionalCode(body.code),
        language: v.requireLanguage(body.language),
      }),
      run: async ({ messages, code, language }) => {
        const result = await aiChat(messages, code, language);
        return {
          reply: result.reply,
          sources: result.sources || [],
          toolCalls: result.toolCalls || [],
          ragEnabled: Boolean(result.ragEnabled),
        };
      },
    })
  );

  app.post(
    '/explain-error',
    aiRoute('/explain-error', {
      validate: (body) => {
        const errorMessage = v.inputString(body.errorMessage, 'Error message');
        if (!errorMessage.trim()) throw new v.ValidationError('Error message is required.');
        return { errorMessage, code: v.optionalCode(body.code), language: v.optionalLanguage(body.language) };
      },
      run: async ({ errorMessage, code, language }) => ({ explanation: await explainError(errorMessage, code, language) }),
    })
  );

  /* ----------------------------- Admin ---------------------------- */

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    if (!adminAuth.adminEnabled()) {
      return res.status(503).json({ success: false, error: 'Admin dashboard is not configured on this server.' });
    }
    if (!adminAuth.checkPassword(req.body?.password)) {
      return res.status(401).json({ success: false, error: 'Incorrect admin password.' });
    }
    res.json({ success: true, token: adminAuth.issueToken(), expiresInMs: config.admin.sessionTtlMs });
  });

  const admin = express.Router();
  admin.use(adminAuth.requireAdmin);

  admin.get('/stats', async (req, res) => {
    res.json(await getStats());
  });

  admin.get('/ai-limits', async (req, res) => {
    res.json({ success: true, ...(await getAllLimits()) });
  });

  admin.post('/ai-limits/update', async (req, res) => {
    const { ip, newLimit, resetCount } = req.body || {};
    if (!ip || typeof ip !== 'string') throw new v.ValidationError('IP address is required.');
    res.json(await updateIpLimit(ip, newLimit, Boolean(resetCount)));
  });

  admin.post('/ai-limits/reset', async (req, res) => {
    const { ip } = req.body || {};
    if (!ip || typeof ip !== 'string') throw new v.ValidationError('IP address is required.');
    res.json(await resetIpUsage(ip));
  });

  admin.post('/ai-limits/global', async (req, res) => {
    res.json(await updateGlobalLimit(req.body?.defaultLimit));
  });

  app.use('/api/admin', admin);

  /* ------------------------- Error handling ----------------------- */

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Request body is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON body.' });

    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error('Unhandled error:', err);
    res.status(status).json({
      success: false,
      error: status >= 500 && !err.kind ? 'Internal server error.' : err.message,
      ...(err.kind ? { kind: err.kind } : {}),
    });
  });

  return app;
}

module.exports = { createApp };
