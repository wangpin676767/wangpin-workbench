'use strict';
const fs=require('fs'),fsp=fs.promises,path=require('path');
let SQL=null;
function normPath(p){return !p?'':String(p).replace(/^\\\\\?\\/,'').replace(/^\/\/\?\//,'');}
async function loadSql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const wasmBinary = fs.readFileSync(fs.existsSync(wasmPath) ? wasmPath : require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ wasmBinary });
  return SQL;
}

async function findStateDb(home) {
  try {
    const files = (await fsp.readdir(home)).filter((f) => /^state_\d+\.sqlite$/.test(f));
    files.sort((a, b) => parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10));
    return files.length ? path.join(home, files[0]) : null;
  } catch { return null; }
}

// Codex 用 WAL 模式，大部分最新資料在 -wal 檔裡；這裡把已提交的 WAL 頁面疊回主檔再交給 sql.js
async function readDbWithWal(dbPath) {
  const native = require('./nativeAccelerator').getNative();
  if (typeof native?.readDbWithWal === 'function') { try { return Buffer.from(await native.readDbWithWal(dbPath)); } catch {} }
  const db = await fsp.readFile(dbPath);
  let wal = null;
  try { wal = await fsp.readFile(dbPath + '-wal'); } catch { /* 沒有 WAL */ }
  let out = db;
  if (wal && wal.length >= 32) {
    const magic = wal.readUInt32BE(0);
    const pageSize = wal.readUInt32BE(8);
    if ((magic === 0x377f0682 || magic === 0x377f0683) && pageSize >= 512 && pageSize <= 65536) {
      const salt1 = wal.readUInt32BE(16);
      const salt2 = wal.readUInt32BE(20);
      const frameSize = 24 + pageSize;
      const pages = new Map();
      let pending = [];
      let dbPages = Math.floor(db.length / pageSize);
      for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
        if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
        pending.push([wal.readUInt32BE(off), off + 24]);
        const commit = wal.readUInt32BE(off + 4);
        if (commit) { for (const [pg, o] of pending) pages.set(pg, o); pending = []; dbPages = commit; }
      }
      if (pages.size) {
        out = Buffer.alloc(dbPages * pageSize);
        db.copy(out, 0, 0, Math.min(db.length, out.length));
        for (const [pg, o] of pages) if (pg >= 1 && pg <= dbPages) wal.copy(out, (pg - 1) * pageSize, o, o + pageSize);
      }
    }
  }
  if (out.length >= 100 && out[18] === 2) { out = Buffer.from(out); out[18] = 1; out[19] = 1; } // 標成非 WAL，讓 sql.js 直接讀
  return out;
}

async function readStateDb(home) {
  const dbPath = await findStateDb(home);
  if (!dbPath) return null;
  try {
    const SQLlib = await loadSql();
    const buf = await readDbWithWal(dbPath);
    const db = new SQLlib.Database(new Uint8Array(buf));
    const cols = new Set();
    const ti = db.exec('PRAGMA table_info(threads)');
    if (!ti.length) { db.close(); return null; }
    for (const row of ti[0].values) cols.add(row[1]);
    const want = ['id', 'rollout_path', 'cwd', 'title', 'name', 'preview', 'first_user_message', 'archived', 'updated_at', 'updated_at_ms',
      'created_at', 'created_at_ms', 'recency_at_ms', 'is_pinned', 'thread_section_id', 'project_id', 'source', 'thread_source',
      'agent_nickname', 'agent_path', 'has_user_event', 'model'];
    const sel = want.filter((c) => cols.has(c));
    const res = db.exec(`SELECT ${sel.join(',')} FROM threads`);
    const threads = [];
    if (res.length) {
      for (const v of res[0].values) {
        const r = {};
        sel.forEach((c, i) => { r[c] = v[i]; });
        threads.push(r);
      }
    }
    const projects = new Map();
    try {
      const pr = db.exec('SELECT p.id, p.name, p.position, r.path FROM projects p LEFT JOIN project_roots r ON r.project_id = p.id AND r.position = 0');
      if (pr.length) for (const [id, name, position, root] of pr[0].values) projects.set(id, { id, name, position, root: normPath(root) });
    } catch { /* 舊版沒有 projects 表 */ }
    const spawnEdges=[];
    try {const edgeRows=db.exec('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges');if(edgeRows.length)for(const [parent,child]of edgeRows[0].values)spawnEdges.push({parent,child});}catch{}
    db.close();
    return { threads, projects, dbPath, spawnEdges };
  } catch (err) {
    return { error: String(err && err.message || err), threads: [], projects: new Map() };
  }
}

module.exports={readStateDb,findStateDb,readDbWithWal};
