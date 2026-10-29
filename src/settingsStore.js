'use strict';
const fs = require('node:fs');
const path = require('node:path');
function read(file) {
  let first;
  for (const candidate of [file, `${file}.backup`]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings object');
      return { value, recovered: candidate !== file };
    } catch (error) { first ||= error; }
  }
  if (fs.existsSync(file) || fs.existsSync(`${file}.backup`)) throw first;
  return { value: null, recovered: false };
}
function rename(from, to) {
  for (let attempt = 0;; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 6) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (2 ** attempt));
    }
  }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  // Preserve only a valid last-known-good settings snapshot.
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (old === text) {
      // Repeated UI refreshes may save the same settings. Preserve recovery
      // behavior, but leave both valid files untouched when nothing changed.
      let backupValid = false;
      try { const backup = JSON.parse(fs.readFileSync(`${file}.backup`, 'utf8')); backupValid = !!backup && !Array.isArray(backup) && typeof backup === 'object'; } catch {}
      if (!backupValid) { fs.writeFileSync(`${file}.backup.tmp`, text, 'utf8'); rename(`${file}.backup.tmp`, `${file}.backup`); }
      return;
    }
    let valid = false;
    try { const parsed = JSON.parse(old); valid = !!parsed && !Array.isArray(parsed) && typeof parsed === 'object'; } catch {}
    if (valid) { fs.writeFileSync(`${file}.backup.tmp`, old, 'utf8'); rename(`${file}.backup.tmp`, `${file}.backup`); }
  }
  fs.writeFileSync(`${file}.tmp`, text, 'utf8'); rename(`${file}.tmp`, file);
  if (!fs.existsSync(`${file}.backup`)) { fs.writeFileSync(`${file}.backup.tmp`, text, 'utf8'); rename(`${file}.backup.tmp`, `${file}.backup`); }
}
module.exports = { read, write };
