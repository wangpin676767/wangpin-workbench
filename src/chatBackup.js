'use strict';
// 對話備份（.cmbak）與 Codex 連結解析。
// 備份檔是 JSONL：第一行是檔頭，之後每行一段對話；大量對話也能逐行讀寫，不必整份載入記憶體。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const FORMAT = 'codex-multi-backup';
const VERSION = 1;
const MAX_EMBED = 10 * 1024 * 1024;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
MIME['.jpeg'] = 'image/jpeg';

// codex://threads/<uuid>、codex:<uuid>、紀錄檔名或單純的 uuid 都接受
function parseThreadLink(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 2000) return null;
  const m = /codex:\/\/threads\/([0-9a-f-]{36})/i.exec(s) || /^codex:([0-9a-f-]{36})$/i.exec(s) || (/^[0-9a-f-]{36}$/i.test(s) ? [s, s] : null) || /rollout-[^\\/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

// 把附件的本機檔案內嵌進備份，換電腦也能還原
async function embedAttachment(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  if (!out.data && !out.text && typeof out.path === 'string') {
    try {
      const st = await fsp.stat(out.path);
      if (st.isFile() && st.size <= MAX_EMBED) {
        out.mime = out.mime || MIME[path.extname(out.path).toLowerCase()] || 'application/octet-stream';
        out.data = (await fsp.readFile(out.path)).toString('base64');
      }
    } catch { out.missing = true; }
  }
  if (out.path) { out.originalPath = out.path; delete out.path; }
  delete out.id;
  return out;
}

async function packEntry(chat, { sourceKey, sourceThreadId = null, messages } = {}) {
  const msgs = [];
  for (const m of messages || chat.messages || []) {
    const { _order, ...rest } = m;
    if (Array.isArray(rest.attachments)) rest.attachments = await Promise.all(rest.attachments.map(embedAttachment));
    msgs.push(rest);
  }
  const { codexThreadId, codexActiveThreadId, paused, localSource, restoredFrom, ...keep } = chat;
  return {
    ...keep,
    source: { key: sourceKey || (chat.id ? `app:${chat.id}` : ''), threadId: sourceThreadId || codexThreadId || null, localSource: localSource || null, updatedAt: chat.updatedAt || null },
    messages: msgs,
  };
}

function header(extra = {}) {
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), ...extra };
}

// entries 可以是陣列或 async iterator；逐行寫入，寫完才改名，避免留下半份備份
async function writeBackup(file, entries, extra = {}) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  const write = (line) => new Promise((resolve, reject) => {
    stream.write(line + '\n', (err) => (err ? reject(err) : resolve()));
  });
  let count = 0;
  try {
    await write(JSON.stringify(header(extra)));
    for await (const entry of entries) {
      if (!entry) continue;
      await write(JSON.stringify(entry));
      count++;
    }
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    await fsp.rename(tmp, file);
  } catch (err) {
    stream.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return { count };
}

async function isBackupFile(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(200);
    const { bytesRead } = await fh.read(buf, 0, 200, 0);
    return buf.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '').replace(/\s+/g, '').startsWith(`{"format":"${FORMAT}"`);
  } finally { await fh.close(); }
}

async function* readBackup(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let first = true;
  let lineNo = 0;
  try {
    for await (const raw of rl) {
      lineNo++;
      const line = first ? raw.replace(/^﻿/, '') : raw;
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { throw new Error(`備份檔第 ${lineNo} 行損壞`); }
      if (first) {
        first = false;
        if (obj.format !== FORMAT) throw new Error('不是 Codex Multi 備份檔');
        if (obj.version > VERSION) throw new Error('這個備份檔來自較新版本的 app，請先更新');
        continue;
      }
      yield obj;
    }
    if (first) throw new Error('備份檔是空的');
  } finally {
    // 中途出錯或提早結束時也要釋放檔案，Windows 才不會鎖住備份檔
    rl.close();
    if (!input.closed) await new Promise((resolve) => { input.once('close', resolve); input.destroy(); });
  }
}

// 把備份中的一段對話轉回可存檔的對話；附件寫回 app 的附件資料夾
function restoreAttachment(a, attachmentsDir, createdFiles) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a, id: crypto.randomUUID() };
  if (out.data) {
    const bytes = Buffer.from(out.data, 'base64');
    const ext = EXT[out.mime] || path.extname(out.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    fs.mkdirSync(attachmentsDir, { recursive: true });
    out.path = path.join(attachmentsDir, out.id + ext);
    fs.writeFileSync(out.path, bytes, {flag:'wx'});
    createdFiles?.push(out.path);
    out.size = bytes.length;
  }
  return out;
}

function unpackEntry(entry, { newId, attachmentsDir, createdFiles }) {
  if (!entry || !Array.isArray(entry.messages)) throw new Error('備份中的對話格式不正確');
  const { source, id: _oldId, cwd, ...rest } = entry;
  // Imported history belongs to a new App conversation; it must not resume a
  // website or CLI thread owned by the original conversation.
  for(const field of ['antigravityCli','gptWeb','gptWebAgent','gptWebByAccount','gptWebAgentByAccount','claudeSessionId','claudeSession','claudeThreadId'])delete rest[field];
  const messages = entry.messages.map((m) => {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') return null;
    const msg = { ...m, id: newId('m') };
    if (Array.isArray(msg.attachments)) msg.attachments = msg.attachments.map((a) => restoreAttachment(a, attachmentsDir, createdFiles));
    return msg;
  }).filter(Boolean);
  return {
    ...rest,
    id: newId('restore'),
    origin: 'app',
    // 還原的內容是資料，不代表授權操作原本的專案；原資料夾另外記著，由使用者自己選回
    cwd: '',
    importedCwd: cwd || entry.importedCwd || '',
    codexThreadId: null,
    codexActiveThreadId: null,
    restoredFrom: { key: source?.key || '', threadId: source?.threadId || null, updatedAt: source?.updatedAt || null },
    localSource: source?.localSource || undefined,
    createdAt: entry.createdAt || new Date().toISOString(),
    messages,
  };
}

// 同一個來源、同一個版本已經還原過（或原對話還在）就跳過
function findDuplicate(entry, existing) {
  const src = entry.source || {};
  return existing.find((c) => {
    if (src.key && c.restoredFrom && c.restoredFrom.key === src.key && c.restoredFrom.updatedAt === src.updatedAt) return true;
    return src.key === `app:${c.id}` && src.updatedAt && c.updatedAt === src.updatedAt;
  }) || null;
}
function isDuplicate(entry, existing) { return !!findDuplicate(entry, existing); }

module.exports = { FORMAT, parseThreadLink, packEntry, writeBackup, isBackupFile, readBackup, unpackEntry, isDuplicate, findDuplicate, embedAttachment };
