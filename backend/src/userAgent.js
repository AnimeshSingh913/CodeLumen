// Minimal browser/OS detection for analytics labels. Avoids pulling in
// ua-parser-js v2, which is AGPL-licensed.

const BROWSERS = [
  ['Edge', /Edg(?:e|A|iOS)?\//],
  ['Opera', /OPR\/|Opera/],
  ['Samsung Internet', /SamsungBrowser\//],
  ['Chrome', /Chrome\/|CriOS\//],
  ['Firefox', /Firefox\/|FxiOS\//],
  ['Safari', /Version\/.*Safari\//],
];

const SYSTEMS = [
  ['iOS', /iPhone|iPad|iPod/],
  ['Android', /Android/],
  ['Windows', /Windows/],
  ['macOS', /Mac OS X|Macintosh/],
  ['ChromeOS', /CrOS/],
  ['Linux', /Linux/],
];

const match = (table, ua) => (table.find(([, re]) => re.test(ua)) || ['Unknown'])[0];

const parseUserAgent = (ua = '') => ({
  browser: match(BROWSERS, String(ua)),
  os: match(SYSTEMS, String(ua)),
});

module.exports = { parseUserAgent };
