//! Narrow live-SQLite deletion. Never reconstruct or export the database.
use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;

pub struct DeleteCodexThreads { path: String, ids: Vec<String> }
impl Task for DeleteCodexThreads {
  type Output = u32;
  type JsValue = u32;
  fn compute(&mut self) -> Result<u32> { platform::delete(&self.path, &self.ids) }
  fn resolve(&mut self, _env: Env, output: u32) -> Result<u32> { Ok(output) }
}

#[napi]
pub fn delete_codex_threads(path: String, ids: Vec<String>) -> Result<AsyncTask<DeleteCodexThreads>> {
  if path.contains('\0') || !std::path::Path::new(&path).is_absolute() || ids.is_empty() || ids.len() > 512 {
    return Err(Error::from_reason("Invalid database deletion arguments"));
  }
  for id in &ids {
    let bytes = id.as_bytes();
    if bytes.len() != 36 || !bytes.iter().enumerate().all(|(i, b)| {
      if [8,13,18,23].contains(&i) { *b == b'-' } else { b.is_ascii_hexdigit() }
    }) { return Err(Error::from_reason("Invalid thread UUID")); }
  }
  Ok(AsyncTask::new(DeleteCodexThreads { path, ids }))
}

#[cfg(not(windows))]
mod platform {
  use super::*;
  pub fn delete(_: &str, _: &[String]) -> Result<u32> { Err(Error::from_reason("Native SQLite deletion is unavailable on this platform")) }
}

#[cfg(windows)]
mod platform {
  use super::*;
  use std::{ffi::CString, os::raw::{c_char, c_int, c_void}, ptr};
  #[link(name = "winsqlite3")]
  extern "C" {
    fn sqlite3_open_v2(path: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_busy_timeout(db: *mut c_void, ms: c_int) -> c_int;
    fn sqlite3_exec(db: *mut c_void, sql: *const c_char, callback: *const c_void, arg: *mut c_void, error: *mut *mut c_char) -> c_int;
    fn sqlite3_prepare_v2(db: *mut c_void, sql: *const c_char, n: c_int, stmt: *mut *mut c_void, tail: *mut *const c_char) -> c_int;
    fn sqlite3_bind_text(stmt: *mut c_void, idx: c_int, value: *const c_char, n: c_int, destructor: Option<unsafe extern "C" fn(*mut c_void)>) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
    fn sqlite3_changes(db: *mut c_void) -> c_int;
  }
  struct Db(*mut c_void);
  impl Drop for Db { fn drop(&mut self) { unsafe { sqlite3_close(self.0); } } }
  struct Stmt(*mut c_void);
  impl Drop for Stmt { fn drop(&mut self) { unsafe { sqlite3_finalize(self.0); } } }
  fn check(code: c_int) -> Result<()> {
    if code == 0 { Ok(()) } else { Err(Error::from_reason(format!("Live SQLite deletion failed (code {})", code))) }
  }
  impl Db {
    fn exec(&self, sql: &str) -> Result<()> {
      let sql = CString::new(sql).unwrap();
      check(unsafe { sqlite3_exec(self.0, sql.as_ptr(), ptr::null(), ptr::null_mut(), ptr::null_mut()) })
    }
    fn prepare(&self, sql: &str) -> Result<Stmt> {
      let sql = CString::new(sql).unwrap();
      let mut raw = ptr::null_mut();
      let result = unsafe { sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut raw, ptr::null_mut()) };
      if result != 0 { if !raw.is_null() { unsafe { sqlite3_finalize(raw); } } check(result)?; }
      Ok(Stmt(raw))
    }
    fn exists(&self, table: &str) -> Result<bool> {
      // table names originate exclusively from the fixed internal allowlist.
      let stmt = self.prepare(&format!("SELECT 1 FROM sqlite_master WHERE type='table' AND name='{}'", table))?;
      match unsafe { sqlite3_step(stmt.0) } {
        100 => Ok(true), 101 => Ok(false), code => { check(code)?; Ok(false) }
      }
    }
    fn remove(&self, sql: &str, id: &str) -> Result<u32> {
      let stmt = self.prepare(sql)?;
      // SQLITE_STATIC is safe: the CString outlives sqlite3_step and finalize.
      let value = CString::new(id).unwrap();
      check(unsafe { sqlite3_bind_text(stmt.0, 1, value.as_ptr(), -1, None) })?;
      let code = unsafe { sqlite3_step(stmt.0) };
      let count = unsafe { sqlite3_changes(self.0) }.max(0) as u32;
      // Finalize before releasing the bound string, including error paths.
      drop(stmt);
      if code != 101 { check(code)?; }
      Ok(count)
    }
  }
  pub fn delete(path: &str, ids: &[String]) -> Result<u32> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Error::from_reason("Existing SQLite database required"))?;
    use std::os::windows::fs::MetadataExt;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
      return Err(Error::from_reason("Linked database paths are not allowed"));
    }
    let path = CString::new(path).unwrap();
    let mut raw = ptr::null_mut();
    // READWRITE | FULLMUTEX. Intentionally excludes CREATE and URI interpretation.
    let code = unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, 2 | 0x10000, ptr::null()) };
    if raw.is_null() { check(code)?; return Err(Error::from_reason("Unable to open SQLite database")); }
    let db = Db(raw);
    check(code)?;
    check(unsafe { sqlite3_busy_timeout(db.0, 5000) })?;
    db.exec("PRAGMA foreign_keys=ON")?;
    db.exec("BEGIN IMMEDIATE")?;
    let result = (|| {
      // CASCADE handles current declared children; explicit scoped cleanup also
      // supports historical schemas where these tables lacked foreign keys.
      let tables = [
        ("thread_spawn_edges", "DELETE FROM thread_spawn_edges WHERE parent_thread_id=?1 OR child_thread_id=?1"),
        ("thread_read_receipts", "DELETE FROM thread_read_receipts WHERE thread_id=?1"),
        ("thread_dynamic_tools", "DELETE FROM thread_dynamic_tools WHERE thread_id=?1"),
        ("thread_attachments", "DELETE FROM thread_attachments WHERE thread_id=?1"),
        ("guardian_review_feedback", "DELETE FROM guardian_review_feedback WHERE thread_id=?1"),
      ];
      let present: Vec<_> = tables.iter().map(|(name, sql)| db.exists(name).map(|yes| (yes, *sql))).collect::<Result<_>>()?;
      let mut count = 0;
      for id in ids {
        for (yes, sql) in &present { if *yes { db.remove(sql, id)?; } }
        count += db.remove("DELETE FROM threads WHERE id=?1", id)?;
      }
      db.exec("COMMIT")?;
      Ok(count)
    })();
    if result.is_err() { let _ = db.exec("ROLLBACK"); }
    result
  }
}
