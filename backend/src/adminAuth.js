const crypto = require('crypto');
const config = require('./config');

const MIN_PASSWORD_LENGTH = 12;
const WEAK_PASSWORDS = new Set(['admin123', 'password', 'changeme', 'admin', 'your_admin_password']);

const sessionSecret = config.admin.sessionSecret || crypto.randomBytes(32).toString('hex');

const adminEnabled = () => {
  const pw = config.admin.password;
  return pw.length >= MIN_PASSWORD_LENGTH && !WEAK_PASSWORDS.has(pw.toLowerCase());
};

const describeAdminStatus = () => {
  if (!config.admin.password) return 'Admin dashboard disabled: ADMIN_PASSWORD is not set.';
  if (!adminEnabled()) return `Admin dashboard disabled: ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters and not a common default.`;
  return 'Admin dashboard enabled.';
};

// Compare fixed-length digests so neither content nor length leaks via timing.
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const sign = (payload) => crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');

/** Short-lived signed token, so the browser never stores the password. */
const issueToken = () => {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + config.admin.sessionTtlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};

const verifyToken = (token) => {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  if (!safeEqual(sign(payload), signature)) return false;
  try {
    const { role, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return role === 'admin' && typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
};

const checkPassword = (password) => adminEnabled() && typeof password === 'string' && safeEqual(password, config.admin.password);

/** Express middleware: requires `Authorization: Bearer <token>`. */
const requireAdmin = (req, res, next) => {
  if (!adminEnabled()) {
    return res.status(503).json({ success: false, error: 'Admin dashboard is not configured on this server.' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ success: false, error: 'Admin authentication required.' });
  if (!verifyToken(token)) return res.status(401).json({ success: false, error: 'Session expired or invalid. Please log in again.' });
  next();
};

module.exports = { adminEnabled, describeAdminStatus, checkPassword, issueToken, verifyToken, requireAdmin };
