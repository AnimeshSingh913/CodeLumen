const mongoose = require('mongoose');
const config = require('./config');
const { parseUserAgent } = require('./userAgent');

// Schema for tracking IP-specific AI message usage and custom limits
const aiUsageLimitSchema = new mongoose.Schema({
  ip: { type: String, required: true, unique: true, index: true },
  usedCount: { type: Number, default: 0, min: 0 },
  customLimit: { type: Number, default: null }, // null means use global default limit
  lastUsed: { type: Date, default: Date.now },
  browser: { type: String, default: 'Unknown' },
  os: { type: String, default: 'Unknown' },
}, { timestamps: true });

// Schema for global AI configuration (e.g. global default limit)
const aiConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global_config' },
  defaultLimit: { type: Number, default: config.ai.defaultLimit, min: 0 },
}, { timestamps: true });

const AiUsageLimit = mongoose.models.AiUsageLimit || mongoose.model('AiUsageLimit', aiUsageLimitSchema);
const AiConfig = mongoose.models.AiConfig || mongoose.model('AiConfig', aiConfigSchema);

const AFTER = { upsert: true, returnDocument: 'after', lean: true };
const MAX_LIMIT = 100000;

// In-memory fallback in case MongoDB is offline or not configured
const memoryLimits = new Map();
let memoryDefaultLimit = config.ai.defaultLimit;

const dbReady = () => mongoose.connection.readyState === 1;

/**
 * Normalize an IP address (IPv4-mapped IPv6 and loopback variants).
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '127.0.0.1';
  let clean = ip.trim();
  if (clean.startsWith('::ffff:')) clean = clean.slice(7);
  if (clean === '::1') return '127.0.0.1';
  return clean;
}

/**
 * Client IP as resolved by Express. With `trust proxy` set to the real number
 * of proxy hops, req.ip ignores any X-Forwarded-For entries the client added
 * itself, so the value cannot be spoofed to reset a quota.
 */
function getClientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress);
}

/**
 * Parse an admin-supplied limit: null/'' clears it, otherwise a whole number.
 */
function parseLimit(value, { allowNull = true } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
    const err = new Error(`Limit must be a whole number between 0 and ${MAX_LIMIT}.`);
    err.status = 400;
    throw err;
  }
  return n;
}

const effectiveLimit = (customLimit, defaultLimit) =>
  customLimit !== null && customLimit !== undefined ? customLimit : defaultLimit;

const summarize = (ip, used, customLimit, defaultLimit) => {
  const limit = effectiveLimit(customLimit, defaultLimit);
  return {
    ip,
    used,
    limit,
    customLimit: customLimit ?? null,
    defaultLimit,
    remaining: Math.max(0, limit - used),
    limitReached: used >= limit,
  };
};

async function getGlobalDefaultLimit() {
  try {
    if (dbReady()) {
      const conf = await AiConfig.findOneAndUpdate(
        { key: 'global_config' },
        { $setOnInsert: { defaultLimit: memoryDefaultLimit } },
        AFTER
      );
      memoryDefaultLimit = conf.defaultLimit;
      return conf.defaultLimit;
    }
  } catch (err) {
    console.error('Error reading AiConfig from DB:', err.message);
  }
  return memoryDefaultLimit;
}

async function getStatus(ip) {
  const normIp = normalizeIp(ip);
  const defaultLimit = await getGlobalDefaultLimit();

  try {
    if (dbReady()) {
      const record = await AiUsageLimit.findOne({ ip: normIp }).lean();
      return summarize(normIp, record?.usedCount || 0, record?.customLimit, defaultLimit);
    }
  } catch (err) {
    console.error('Error fetching AI status from DB:', err.message);
  }

  const mem = memoryLimits.get(normIp) || { usedCount: 0, customLimit: null };
  return summarize(normIp, mem.usedCount, mem.customLimit, defaultLimit);
}

/**
 * Atomically reserve one AI message for this IP. The counter is incremented
 * first and rolled back if it went over the limit, so parallel requests
 * cannot overshoot the quota. Call releaseAiUsage() if the AI call fails.
 */
async function reserveAiUsage(ip, userAgentString = '') {
  const normIp = normalizeIp(ip);
  const defaultLimit = await getGlobalDefaultLimit();
  const { browser, os } = parseUserAgent(userAgentString);

  try {
    if (dbReady()) {
      const record = await AiUsageLimit.findOneAndUpdate(
        { ip: normIp },
        {
          $inc: { usedCount: 1 },
          $set: { lastUsed: new Date(), browser, os },
          $setOnInsert: { customLimit: null },
        },
        AFTER
      );
      const limit = effectiveLimit(record.customLimit, defaultLimit);
      if (record.usedCount > limit) {
        await AiUsageLimit.updateOne({ ip: normIp, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
        return { allowed: false, ...summarize(normIp, record.usedCount - 1, record.customLimit, defaultLimit) };
      }
      return { allowed: true, ...summarize(normIp, record.usedCount, record.customLimit, defaultLimit) };
    }
  } catch (err) {
    console.error('Error reserving AI usage in DB:', err.message);
  }

  const mem = memoryLimits.get(normIp) || { usedCount: 0, customLimit: null };
  const limit = effectiveLimit(mem.customLimit, defaultLimit);
  if (mem.usedCount >= limit) {
    return { allowed: false, ...summarize(normIp, mem.usedCount, mem.customLimit, defaultLimit) };
  }
  mem.usedCount += 1;
  Object.assign(mem, { lastUsed: new Date(), browser, os });
  memoryLimits.set(normIp, mem);
  return { allowed: true, ...summarize(normIp, mem.usedCount, mem.customLimit, defaultLimit) };
}

/** Refund a reservation after a failed AI call. */
async function releaseAiUsage(ip) {
  const normIp = normalizeIp(ip);
  try {
    if (dbReady()) {
      await AiUsageLimit.updateOne({ ip: normIp, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
      return;
    }
  } catch (err) {
    console.error('Error releasing AI usage in DB:', err.message);
  }
  const mem = memoryLimits.get(normIp);
  if (mem && mem.usedCount > 0) mem.usedCount -= 1;
}

const toAdminRow = (ip, data, defaultLimit) => {
  const used = data.usedCount || 0;
  const limit = effectiveLimit(data.customLimit, defaultLimit);
  return {
    ip,
    usedCount: used,
    customLimit: data.customLimit ?? null,
    effectiveLimit: limit,
    remaining: Math.max(0, limit - used),
    isLimitReached: used >= limit,
    hasCustomLimit: data.customLimit !== null && data.customLimit !== undefined,
    browser: data.browser || 'Unknown',
    os: data.os || 'Unknown',
    lastUsed: data.lastUsed || data.updatedAt || null,
  };
};

async function getAllLimits() {
  const defaultLimit = await getGlobalDefaultLimit();
  let ips;

  try {
    if (dbReady()) {
      const records = await AiUsageLimit.find().sort({ lastUsed: -1 }).limit(500).lean();
      ips = records.map((r) => toAdminRow(r.ip, r, defaultLimit));
    }
  } catch (err) {
    console.error('Error fetching all AI limits from DB:', err.message);
  }

  if (!ips) {
    ips = Array.from(memoryLimits.entries()).map(([ip, data]) => toAdminRow(ip, data, defaultLimit));
  }

  return { defaultLimit, totalTrackedIps: ips.length, ips };
}

async function updateIpLimit(ip, newLimit, resetCount = false) {
  const normIp = normalizeIp(ip);
  const customLimit = parseLimit(newLimit);
  const update = { customLimit };
  if (resetCount) update.usedCount = 0;

  if (dbReady()) {
    const record = await AiUsageLimit.findOneAndUpdate({ ip: normIp }, { $set: update }, AFTER);
    return { success: true, record };
  }

  const mem = memoryLimits.get(normIp) || { usedCount: 0, customLimit: null };
  Object.assign(mem, update);
  memoryLimits.set(normIp, mem);
  return { success: true, record: { ip: normIp, ...mem } };
}

async function resetIpUsage(ip) {
  const normIp = normalizeIp(ip);
  if (dbReady()) {
    const record = await AiUsageLimit.findOneAndUpdate({ ip: normIp }, { $set: { usedCount: 0 } }, AFTER);
    return { success: true, record };
  }
  const mem = memoryLimits.get(normIp) || { usedCount: 0, customLimit: null };
  mem.usedCount = 0;
  memoryLimits.set(normIp, mem);
  return { success: true, record: { ip: normIp, ...mem } };
}

async function updateGlobalLimit(newDefaultLimit) {
  const defaultLimit = parseLimit(newDefaultLimit, { allowNull: false });
  memoryDefaultLimit = defaultLimit;

  if (dbReady()) {
    const conf = await AiConfig.findOneAndUpdate({ key: 'global_config' }, { $set: { defaultLimit } }, AFTER);
    return { success: true, defaultLimit: conf.defaultLimit };
  }
  return { success: true, defaultLimit };
}

/** Test helper: clear in-memory state. */
function _resetMemory() {
  memoryLimits.clear();
  memoryDefaultLimit = config.ai.defaultLimit;
}

module.exports = {
  getClientIp,
  normalizeIp,
  getGlobalDefaultLimit,
  getStatus,
  reserveAiUsage,
  releaseAiUsage,
  getAllLimits,
  updateIpLimit,
  resetIpUsage,
  updateGlobalLimit,
  _resetMemory,
};
