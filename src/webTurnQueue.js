'use strict';

// A single logged-in ChatGPT web profile is shared by every workbench chat.
// Run one submitted turn at a time so switching chats/models cannot make the
// site cancel or redirect another in-flight web response.
function createWebTurnQueue() {
  let running = false;
  const waiting = [];

  function drain() {
    if (running || !waiting.length) return;
    const job = waiting.shift();
    job.signal?.removeEventListener('abort', job.abort);
    if (job.signal?.aborted) {
      job.resolve({ text: '', cancelled: true });
      drain();
      return;
    }

    running = true;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      running = false;
      drain();
    });
  }

  function run(fn, { signal, onQueued } = {}) {
    if (signal?.aborted) return Promise.resolve({ text: '', cancelled: true });
    return new Promise((resolve, reject) => {
      const job = { run: fn, resolve, reject, signal, abort: null };
      job.abort = () => {
        const at = waiting.indexOf(job);
        if (at < 0) return;
        waiting.splice(at, 1);
        signal?.removeEventListener('abort', job.abort);
        resolve({ text: '', cancelled: true });
        drain();
      };
      if (running || waiting.length) onQueued?.(waiting.length + (running ? 1 : 0));
      waiting.push(job);
      signal?.addEventListener('abort', job.abort, { once: true });
      drain();
    });
  }

  return { run, get waiting() { return waiting.length; }, get running() { return running; } };
}

module.exports = { createWebTurnQueue };
