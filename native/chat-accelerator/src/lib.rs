use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;
mod io_tasks;
mod codex_delete;
use std::{fs::File, io::{BufRead, BufReader, Read}};

#[napi(object)]
pub struct Matches { pub indices: Vec<u32>, pub total: u32 }

#[napi]
pub struct SearchIndex { bodies: Vec<Buffer> }

#[napi]
impl SearchIndex {
  #[napi(constructor)]
  pub fn new(bodies: Vec<Buffer>) -> Self { Self { bodies } }

  #[napi]
  pub fn search(&self, terms: Vec<Buffer>, limit: u32) -> Matches {
    let finders: Vec<_> = terms.iter().map(|t| memchr::memmem::Finder::new(t.as_ref())).collect();
    let mut indices = Vec::new();
    let mut total = 0;
    for (i, body) in self.bodies.iter().enumerate() {
      if !body.is_empty() && finders.iter().all(|f| contains_utf16(f, body)) {
        total += 1;
        if indices.len() < limit as usize { indices.push(i as u32); }
      }
    }
    Matches { indices, total }
  }
}

fn contains_utf16(finder: &memchr::memmem::Finder<'_>, body: &[u8]) -> bool {
  let mut start = 0;
  while let Some(at) = finder.find(&body[start..]) {
    if (start + at) % 2 == 0 { return true; }
    start += at + 1;
  }
  false
}

#[derive(serde::Deserialize)]
struct Record {
  #[serde(rename = "type", default)]
  kind: serde_json::Value,
  #[serde(default)]
  timestamp: Option<Box<serde_json::value::RawValue>>,
  #[serde(default)]
  payload: Option<Box<serde_json::value::RawValue>>,
}
#[derive(serde::Deserialize)]
struct Payload {
  #[serde(rename = "type", default)]
  kind: serde_json::Value,
}

pub struct RolloutTask { path: String }
impl Task for RolloutTask {
  type Output = Vec<String>;
  type JsValue = Vec<String>;
  fn compute(&mut self) -> Result<Self::Output> {
    let file = File::open(&self.path).map_err(|e| Error::from_reason(e.to_string()))?;
    let input: Box<dyn Read + Send> = if self.path.ends_with(".zst") {
      Box::new(zstd::stream::read::Decoder::new(file).map_err(|e| Error::from_reason(e.to_string()))?)
    } else { Box::new(file) };
    let mut reader = BufReader::with_capacity(64 * 1024, input);
    let mut bytes = Vec::new();
    let mut lines = Vec::new();
    let mut retained = 0usize;
    loop {
      bytes.clear();
      // A bounded reader prevents a single hostile line allocating indefinitely.
      let n = reader.by_ref().take(96_000_001).read_until(b'\n', &mut bytes)
        .map_err(|e| Error::from_reason(e.to_string()))?;
      if n == 0 { break; }
      if n >= 96_000_001 { return Err(Error::from_reason("Use JS for oversized record")); }
      if bytes.last() == Some(&b'\n') { bytes.pop(); }
      if bytes.last() == Some(&b'\r') { bytes.pop(); }
      if bytes.contains(&b'\r') { return Err(Error::from_reason("Use JS for bare CR framing")); }
      let line = String::from_utf8_lossy(&bytes);
      if line.is_empty() { continue; }
      // Derived serde structs also accept positional JSON arrays. JS treats
      // arrays as records without named fields, so route them to the oracle.
      if !line.trim_start().starts_with('{') { return Err(Error::from_reason("Use JS for non-object record")); }
      if line.len() > 24_000_000 && line.encode_utf16().count() > 24_000_000 { return Err(Error::from_reason("Use JS for oversized record")); }
      let obj: Record = serde_json::from_str(&line)
        .map_err(|_| Error::from_reason("Use JS for JSON compatibility/strict diagnostics"))?;
      let kind = obj.kind.as_str().unwrap_or("");
      let payload: Option<Payload> = if matches!(kind, "event_msg" | "response_item") {
        match obj.payload.as_ref() {
          Some(p) => Some(serde_json::from_str(p.get()).map_err(|_| Error::from_reason("Use JS for payload compatibility"))?),
          None => None,
        }
      } else { None };
      let pkind = payload.as_ref().and_then(|p| p.kind.as_str()).unwrap_or("");
      let keep = matches!(kind, "session_meta" | "turn_context" | "compacted")
        || (kind == "event_msg" && matches!(pkind, "user_message" | "agent_message" | "agent_reasoning" | "task_complete"))
        || (kind == "response_item" && matches!(pkind, "function_call" | "custom_tool_call" | "local_shell_call" | "message" | "reasoning"));
      let saved = if keep { Some(line.into_owned()) }
        else { obj.timestamp.as_ref().map(|ts| format!("{{\"timestamp\":{}}}", ts.get())) };
      if let Some(s) = saved {
        retained += s.len();
        if s.len() > 256 * 1024 || retained > 2 * 1024 * 1024 || lines.len() >= 10_000 {
          return Err(Error::from_reason("Use streaming JS for large retained history"));
        }
        lines.push(s);
      }
    }
    Ok(lines)
  }
  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> { Ok(output) }
}

#[napi]
pub fn read_rollout(path: String) -> AsyncTask<RolloutTask> { AsyncTask::new(RolloutTask { path }) }
