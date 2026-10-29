'use strict';
// Window events outlive a closing BrowserWindow unless their timer is cancelled.
function bindBounds(window, persist, onError = () => {}, { delay = 800 } = {}) {
  let timer = null, closed = false;
  const save = () => {
    timer = null;
    try {
      if (closed || window.isDestroyed() || window.isMaximized() || window.isMinimized() || window.isFullScreen?.()) return;
      persist(window.getBounds());
    } catch (error) { try { onError(error); } catch {} }
  };
  const schedule = () => { if (closed) return; clearTimeout(timer); timer = setTimeout(save, delay); };
  const close = () => { closed = true; clearTimeout(timer); timer = null; };
  window.on('resize', schedule); window.on('move', schedule); window.on('closed', close);
  return { close };
}
// A hidden Electron default menu still installs F11's togglefullscreen role.
// Keep the normal native title bar/taskbar and maximize behavior, including
// when a document or a restored external state tries to enter fullscreen.
function bindWindowMode(window) {
  const contents = window.webContents;
  let closed = false;
  window.setFullScreenable(false);
  const restore = () => { if (!closed && !window.isDestroyed() && window.isFullScreen()) window.setFullScreen(false); };
  const input = (event, key) => {
    if (closed || window.isDestroyed()) return;
    if (key.type !== 'keyDown') return;
    if (key.key === 'F11') { event.preventDefault(); restore(); }
    else if (key.key === 'Escape' && window.isFullScreen()) { event.preventDefault(); restore(); }
  };
  window.on('enter-full-screen', restore);
  contents.on('before-input-event', input);
  // BrowserWindow.webContents is a native getter and throws after destruction.
  // Unsubscribe on the captured EventEmitter instead of querying the closed window.
  const close=()=>{if(closed)return;closed=true;window.removeListener('enter-full-screen',restore);contents.removeListener('before-input-event',input);window.removeListener('closed',close);};
  window.once('closed',close);
  restore();
  return {close};
}
module.exports = { bindBounds, bindWindowMode };
