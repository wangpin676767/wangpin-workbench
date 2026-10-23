'use strict';
const fs = require('fs/promises'); const path = require('path'); const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Private auth + databases; session directories stay shared so existing threads can resume.
function create({ dir, identify, readJson, readSecret, upsert, writeAtomic }) {
  const root = path.resolve(dir, 'runtime-homes'); const index = path.join(root, 'index.json');
  let entries;
  async function load() {
    if (!entries) entries = (await readJson(index) || []).filter(e => typeof e.home === 'string' && path.resolve(e.home).startsWith(root + path.sep));
    return entries;
  }
  const save = () => writeAtomic(index, JSON.stringify(entries));
  async function sync() {
    for (const e of await load()) {
      const auth = await readJson(path.join(e.home, 'auth.json'));
      if (identify(auth)?.id !== e.id) continue;
      const saved = await readSecret(e.id);
      // A new login or a removed account must never be replaced by an old process.
      if (!saved || hash(saved) !== e.secretHash) continue;
      if (hash(auth) !== e.secretHash) { await upsert(auth); e.secretHash = hash(auth); }
      const current = await readJson(path.join(e.base, 'auth.json'));
      if (current && hash(current) === e.rootHash) {
        if (hash(auth) !== e.rootHash) await writeAtomic(path.join(e.base, 'auth.json'), JSON.stringify(auth, null, 2));
        e.rootHash = hash(auth);
      }
    }
    await save();
  }
  async function configure(base, home) {
    await fs.mkdir(base, { recursive: true }); await fs.mkdir(home, { recursive: true });
    for (const name of ['sessions', 'archived_sessions']) await fs.mkdir(path.join(base, name), { recursive: true });
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      const source = path.join(base, entry.name), dest = path.join(home, entry.name);
      if (entry.isDirectory()) {
        if (path.resolve(source) === root || root.startsWith(path.resolve(source) + path.sep)) continue;
        try { await fs.lstat(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir'); }
      } else if (entry.isFile() && !/^auth(?:\.|$)/i.test(entry.name) && !/\.(?:sqlite|db)(?:-|$)|\.lock$|\.log$|\.jsonl$/i.test(entry.name)) {
        await fs.copyFile(source, dest);
      }
    }
  }
  async function capture(base) {
    base = path.resolve(base); await sync();
    const inherited = (await load()).find(e => e.home === base);
    if (inherited) return { home: inherited.home, accountId: inherited.id };
    const auth = await readJson(path.join(base, 'auth.json')); const who = identify(auth);
    if (!who) throw new Error('Codex 登入資料無法隔離，請先在帳號選單重新登入。');
    await upsert(auth); const fingerprint = hash(auth);
    let e = (await load()).find(e => e.base === base && e.id === who.id && e.secretHash === fingerprint);
    if (e) {
      const current = await readJson(path.join(e.home, 'auth.json'));
      if (!current || hash(current) !== fingerprint) e = null;
    }
    if (!e) {
      const home = path.join(root, crypto.randomBytes(12).toString('hex'));
      await configure(base, home);
      await writeAtomic(path.join(home, 'auth.json'), JSON.stringify(auth, null, 2));
      e = { base, id: who.id, home, rootHash: fingerprint, secretHash: fingerprint }; entries.push(e);
    } else { await configure(base, e.home); e.rootHash = fingerprint; }
    await save(); return { home: e.home, accountId: who.id };
  }
  async function forget(id) {
    for (const e of await load()) if (e.id === id) await fs.unlink(path.join(e.home, 'auth.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    entries = entries.filter(e => e.id !== id); await save();
  }
  return { sync, capture, forget };
}
module.exports = { create };
