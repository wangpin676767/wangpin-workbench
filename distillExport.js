'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function formatOf(value = 'messages') {
  if (!['messages', 'alpaca'].includes(value)) throw new Error('不支援的樣本格式');
  return value;
}

// Text-only training examples. Never read attachment files, reasoning, tool payloads or App settings.
function build(messages, { format = 'messages', includeAttachmentText = false } = {}) {
  formatOf(format);
  const segments = [];
  const stats = { samples: 0, turns: 0, ignoredProgress: 0, excludedResponses: 0, excludedAttachmentMessages: 0, attachmentTurns: 0, unanswered: 0, orphanAnswers: 0 };
  let turns = [], users = [], answers = [], system = '', blocked = false;
  const commit = () => {
    if (users.length && answers.length) {
      turns.push([users.join('\n\n'), answers.join('\n\n')]); stats.turns++;
      users = []; answers = [];
    }
  };
  const flush = () => {
    commit();
    if (turns.length) segments.push({ system, turns });
    if (users.length) stats.unanswered++;
    turns = []; users = []; answers = [];
  };
  const interrupt = () => { users = []; answers = []; flush(); };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.text === 'string' ? m.text : '';
    if (m.role === 'user' && m.attachments?.length) {
      stats.attachmentTurns++;
      if (!includeAttachmentText) { flush(); blocked = true; }
      else if (!text.trim()) flush(); // A pure image is a new question boundary, not part of the preceding answer.
    }
    if (blocked) { if (['user', 'assistant'].includes(m.role)) stats.excludedAttachmentMessages++; continue; }
    if (m.role === 'note') {
      if (/^（這一輪 Codex 沒有完成/.test(text)) interrupt();
      else if (/^（Codex 已壓縮/.test(text)) flush();
      continue;
    }
    if (m.role === 'system' && text.trim()) { flush(); system = text; continue; }
    if (!['user', 'assistant'].includes(m.role)) continue;
    if (m.partial || m.error || m.isApiErrorMessage || ['failed', 'error', 'cancelled', 'in_progress'].includes(m.status)) {
      stats.excludedResponses++; interrupt(); continue;
    }
    if (m.role === 'assistant' && ['analysis', 'commentary', 'reasoning'].includes(m.phase || m.channel)) { stats.ignoredProgress++; continue; }
    if (!text.trim()) continue; // Tool-only assistant records do not break the pending question.
    if (m.role === 'user') { commit(); users.push(text); }
    else if (users.length) answers.push(text);
    else stats.orphanAnswers++;
  }
  flush();
  const rows = [];
  for (const segment of segments) {
    if (format === 'messages') {
      const messages = segment.system ? [{ role: 'system', content: segment.system }] : [];
      for (const [question, answer] of segment.turns) messages.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      rows.push({ messages });
    } else {
      const history = [];
      for (const [instruction, output] of segment.turns) {
        rows.push({ instruction, input: '', output, history: history.map(pair => [...pair]), ...(segment.system ? { system: segment.system } : {}) });
        history.push([instruction, output]);
      }
    }
  }
  stats.samples = rows.length;
  return { rows, stats };
}

function fileTitle(title) {
  const safe = String(title || '對話').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 60);
  return safe || '對話';
}

// Recover markers AND missing boundary records that legacy imports discarded. Never add unimported later turns.
function restoreImportMarkers(messages, original) {
  const signature = m => JSON.stringify([m.role, m.text, m.ts]);
  const indexed = new Map(original.map((m, index) => [signature(m), { m, index }]));
  const fields = ['partial', 'error', 'isApiErrorMessage', 'status', 'phase', 'channel', 'attachments'];
  const saved = messages.map(m => {
    const native = indexed.get(signature(m))?.m;
    return native ? { ...m, ...Object.fromEntries(fields.filter(field => native[field] != null).map(field => [field, native[field]])) } : { ...m };
  });
  const covered = saved.reduce((max, m) => Math.max(max, indexed.get(signature(m))?.index ?? -1), -1);
  const present = new Set(saved.map(signature));
  const boundary = m => m.attachments?.length || m.partial || m.error || m.isApiErrorMessage || ['failed', 'error', 'cancelled', 'in_progress'].includes(m.status);
  if (covered < 0 && original.some(boundary)) throw new Error('無法對齊原始 Claude 的附件／中斷標記，請重新匯入原始紀錄');
  for (let i = 0; i <= covered; i++) {
    const native = original[i];
    if (!boundary(native) || present.has(signature(native))) continue;
    const next = saved.findIndex(m => (indexed.get(signature(m))?.index ?? Infinity) > i);
    saved.splice(next < 0 ? saved.length : next, 0, { ...native });
  }
  return saved;
}

async function write(folder, title, dataset, format = 'messages') {
  formatOf(format);
  if (!dataset.rows.length) throw new Error('沒有可匯出的完整文字問答');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('請選擇完整的輸出資料夾路徑');
  let stat;
  try { stat = await fs.stat(folder); } catch { throw new Error('輸出資料夾不存在，請重新選擇'); }
  if (!stat.isDirectory()) throw new Error('輸出位置必須是資料夾');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `蒸餾_${fileTitle(title)}_${format}_${stamp}`;
  const data = dataset.rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  for (let retry = 0; retry < 5; retry++) {
    const file = path.join(folder, `${base}_${crypto.randomBytes(3).toString('hex')}.jsonl`);
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') continue; throw new Error(`無法寫入輸出資料夾：${e.message}`); }
    try { await handle.writeFile(data, 'utf8'); await handle.close(); }
    catch (e) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw new Error(`匯出失敗：${e.message}`); }
    return { file, stats: dataset.stats, bytes: Buffer.byteLength(data, 'utf8') };
  }
  throw new Error('無法建立新的樣本檔案，請重試');
}

module.exports = { build, write, formatOf, restoreImportMarkers };
