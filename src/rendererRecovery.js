'use strict';
// Defer navigation until Chromium has finished tearing down the crashed process.
function bind(window, file, { onCrash = () => {}, onFailure = () => {}, onRecovered = () => {}, delay = 50, retryDelay = 250 } = {}) {
  let closed = false, pending = false, timer = null, recoveries = 0;
  const valid = () => !closed && !window.isDestroyed();
  const fail = error => { pending = false; try { onFailure(error); } catch {} };
  const load = async attempt => {
    if (!valid()) { pending = false; return; }
    try { await window.loadFile(file); pending = false; if (valid()) { try { onRecovered(); } catch {} } }
    catch (error) {
      if (attempt === 0 && valid()) timer = setTimeout(() => load(1), retryDelay);
      else fail(error);
    }
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    try { onCrash(details); } catch {}
    if (details.reason === 'clean-exit' || !valid() || pending) return;
    // A deterministic boot crash must not create an endless automatic reload loop.
    if (++recoveries > 2) { fail(Object.assign(new Error('Renderer recovery limit reached'), { code:'ERECOVERYLIMIT' })); return; }
    pending = true; timer = setTimeout(() => load(0), delay);
  });
  window.on('closed', () => { closed = true; clearTimeout(timer); pending = false; });
}
module.exports = { bind };
