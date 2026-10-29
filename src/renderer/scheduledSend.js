(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduledSend = factory();
})(globalThis, function () {
  'use strict';
  function create(key, text, when, now) {
    if (!key || typeof key !== 'string') throw new Error('請先選擇一段對話。');
    if (!text || !text.trim()) throw new Error('請先輸入要定時送出的文字。');
    if (!Number.isFinite(when) || when <= now + 1000) throw new Error('請選擇未來的送出時間。');
    return { version: 1, key, text: text.trim(), when, status: 'pending' };
  }
  function restore(raw, now) {
    if (!raw) return null;
    let job;
    try { job = JSON.parse(raw); } catch { return null; }
    if (!job || job.version !== 1 || typeof job.key !== 'string' || typeof job.text !== 'string' || !Number.isFinite(job.when)) return null;
    if (job.status === 'dispatching') { job.status = 'uncertain'; job.reason = '上次送出時工作台中斷，請檢查對話是否已送出。'; }
    else if (job.status === 'pending' && now - job.when > 60000) { job.status = 'missed'; job.reason = '已錯過排程時間，沒有自動補送。'; }
    return job;
  }
  return { create, restore };
});
