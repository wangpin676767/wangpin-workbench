'use strict';
// One observer and one bounded waiter per page. No transcript copies or timers
// that outlive collectReply. Sampling remains throttled during fast streams.
function install() {
  const key = '__wangpinReplyWatch';
  if (window[key]) return window[key].revision;
  const state = { revision: 0, wake: null };
  state.observer = new MutationObserver(() => {
    state.revision++;
    state.wake?.();
  });
  state.observer.observe(document.body || document.documentElement,
    { childList: true, subtree: true, characterData: true, attributes: true });
  window[key] = state;
  return state.revision;
}
function changed(revision, timeoutMs) {
  const state = window.__wangpinReplyWatch;
  if (!state || state.revision !== revision) return true;
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      if (state.wake === finish) state.wake = null;
      resolve(state.revision !== revision);
    };
    state.wake?.();
    state.wake = finish;
    timer = setTimeout(finish, timeoutMs);
    // Also catch changes between reading the snapshot and installing the waiter.
    if (state.revision !== revision) finish();
  });
}
function cleanup() {
  const state = window.__wangpinReplyWatch;
  if (!state) return;
  state.observer.disconnect();
  state.wake?.();
  delete window.__wangpinReplyWatch;
}
const start = `(${install.toString()})()`;
const wait = (revision, timeoutMs) => `(${changed.toString()})(${JSON.stringify(revision)},${JSON.stringify(timeoutMs)})`;
const stop = `(${cleanup.toString()})()`;
const wake = 'window.__wangpinReplyWatch?.wake?.()';
module.exports = { start, wait, stop, wake };
