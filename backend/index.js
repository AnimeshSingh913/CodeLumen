const mongoose = require('mongoose');
const config = require('./src/config');
const { createApp } = require('./src/app');
const { assertSandboxReady } = require('./src/executeCode');
const { describeAdminStatus } = require('./src/adminAuth');

try {
  assertSandboxReady();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(describeAdminStatus());
if (!config.groq.apiKey) console.warn('GROQ_API_KEY is not set. AI features will be unavailable.');

if (config.mongoUri) {
  mongoose
    .connect(config.mongoUri)
    .then(() => console.log('Connected to MongoDB.'))
    .catch((err) => console.error('MongoDB connection error (falling back to in-memory limits):', err.message));
} else {
  console.log('MONGODB_URI not set. Usage limits are kept in memory and analytics are not saved.');
}

const server = createApp().listen(config.port, () => {
  console.log(`CodeLumen API listening on port ${config.port}`);
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
