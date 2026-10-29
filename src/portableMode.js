'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Presence of this opt-in marker is the only difference from an installed build.
// Do not redirect HOME: external CLIs keep their existing account behavior.
function configure(app, { execPath = process.execPath, smokeData = '', io = fs } = {}) {
  if (smokeData) return null;
  const base = path.dirname(execPath);
  const marker = path.join(base, 'portable.json');
  let raw;
  try { raw = io.readFileSync(marker, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (Buffer.byteLength(raw, 'utf8') > 4096) throw Error('Portable 設定檔過大。');
  const config = JSON.parse(raw);
  // Version 2 shares the installed build's profile (same conversations/settings/sessions).
  // Do not run it together with an installed copy: both use the same single-instance lock.
  if (config && config.version === 2 && config.storage === 'system') return Object.freeze({ directory: base, dataDirectory: '', shared: true });
  if (!config || config.version !== 1 || typeof config.dataDirectory !== 'string') throw Error('Portable 設定檔格式不正確。');
  const relative = config.dataDirectory;
  const data = path.resolve(base, relative);
  const inside = path.relative(base, data);
  if (!relative || path.isAbsolute(relative) || !inside || inside.startsWith('..' + path.sep) || inside === '..') {
    throw Error('Portable 資料目錄必須位於程式資料夾內。');
  }
  try {
    io.mkdirSync(data, { recursive: true });
    const actual = path.relative(io.realpathSync(base), io.realpathSync(data));
    if (!actual || actual === '..' || actual.startsWith('..' + path.sep) || path.isAbsolute(actual)) throw Error('Portable directory escapes application folder');
    const probe = path.join(data, '.write-test-' + crypto.randomBytes(8).toString('hex'));
    let fd;
    try { fd = io.openSync(probe, 'wx'); io.writeSync(fd, 'portable'); io.fsyncSync(fd); }
    finally { if (fd !== undefined) io.closeSync(fd); try { io.unlinkSync(probe); } catch {} }
    const session = path.join(data, 'session');
    io.mkdirSync(session, { recursive: true });
    app.setPath('userData', data);
    app.setPath('sessionData', session);
  } catch (error) {
    throw Error('Portable 資料目錄無法寫入，請將完整資料夾移到可寫入的位置。' + (error.code ? ' (' + error.code + ')' : ''));
  }
  return Object.freeze({ directory: base, dataDirectory: data });
}

module.exports = { configure };
