const mongoose = require('mongoose');
const { parseUserAgent } = require('./userAgent');

const analyticsSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  browser: { type: String, default: 'Unknown' },
  os: { type: String, default: 'Unknown' },
  endpoint: { type: String, required: true },
  language: { type: String, default: 'unknown' },
  status: { type: String, default: 'success' },
  // Records expire after 90 days so the collection doesn't grow forever.
  timestamp: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
});

const Analytics = mongoose.models.Analytics || mongoose.model('Analytics', analyticsSchema);

const KNOWN_LANGUAGES = new Set(['cpp', 'java', 'py', 'python']);

async function getStats() {
  if (mongoose.connection.readyState !== 1) return { usage: [], databaseConnected: false };
  try {
    const usage = await Analytics.find().sort({ timestamp: -1 }).limit(1000).lean();
    return { usage, databaseConnected: true };
  } catch (err) {
    console.error('Error fetching stats from MongoDB:', err.message);
    return { usage: [], databaseConnected: true };
  }
}

/** Fire-and-forget usage log; never throws and never blocks a response. */
function logUsage(ip, endpoint, language, status = 'success', userAgentString = '') {
  if (mongoose.connection.readyState !== 1) return;
  const { browser, os } = parseUserAgent(userAgentString);
  Analytics.create({
    ip,
    browser,
    os,
    endpoint,
    // Only store known values so arbitrary client input can't pollute stats.
    language: KNOWN_LANGUAGES.has(language) ? language : 'unknown',
    status,
  }).catch((err) => console.error('Error saving stats to MongoDB:', err.message));
}

module.exports = {
  logUsage,
  getStats,
};
