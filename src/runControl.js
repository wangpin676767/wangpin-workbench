// Register before asynchronous setup so a stop click can never miss a starting run.
function registerRun(registry, id) {
  let handle = null; let cancelled = false; let finished = false;
  const control = {
    get cancelled() { return cancelled; },
    get finished() { return finished; },
    cancel() { if (finished || cancelled) return; cancelled = true; if (handle) handle.cancel(); },
    attach(next) { if (finished) { try { next?.cancel(); } catch { /* 已完成回合的舊 handle 不可重新註冊或阻擋清理 */ } return; } handle = next; if (cancelled && handle) handle.cancel(); },
    complete() { if (finished) return false; finished = true; registry.delete(id); return true; },
  };
  registry.set(id, control);
  return control;
}
module.exports = { registerRun };
