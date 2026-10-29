'use strict';
// Optional Node-API addon. Missing/incompatible binaries preserve the JS path.
let binding;
let checked = false;
let failure = '';
function getNative() {
  if (process.env.CODEX_MULTI_NATIVE_DISABLED === '1') return null;
  if (!checked) {
    checked = true;
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') return null;
      binding = require('./native/chat-accelerator.win32-x64.node');
      if (typeof binding.SearchIndex !== 'function' || typeof binding.readRollout !== 'function')
        throw new Error('Incomplete native accelerator');
    } catch (e) { failure = String(e.message || e); binding = null; }
  }
  return binding || null;
}
function status() { return { available: Boolean(getNative()), failure }; }
module.exports = { getNative, status };
