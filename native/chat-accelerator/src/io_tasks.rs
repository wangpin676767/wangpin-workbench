use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;
use std::{fs, io::Read, path::Path};
use serde::de::{self, Deserialize, IgnoredAny, MapAccess, SeqAccess, Visitor};

const DB_LIMIT: usize = 128 * 1024 * 1024;
fn fail(message: impl ToString) -> Error { Error::from_reason(message.to_string()) }
fn bounded_read(path: &str, limit: usize) -> Result<Vec<u8>> {
  let file=fs::File::open(path).map_err(fail)?;
  if file.metadata().map_err(fail)?.len()>limit as u64 {return Err(fail("Use JS for oversized database"));}
  let mut bytes=Vec::new();file.take(limit as u64+1).read_to_end(&mut bytes).map_err(fail)?;
  if bytes.len()>limit {return Err(fail("Use JS for growing database"));} Ok(bytes)
}
fn be(bytes:&[u8],at:usize)->u32 {u32::from_be_bytes(bytes[at..at+4].try_into().unwrap())}
pub fn merge(db:Vec<u8>,wal:Vec<u8>)->Result<Vec<u8>> {
  let mut out=db;
  if wal.len()>=32 && matches!(be(&wal,0),0x377f0682|0x377f0683) {
    let page=be(&wal,8) as usize;
    if (512..=65536).contains(&page) {
      let mut pages=std::collections::HashMap::new();let mut pending=Vec::new();
      let mut count=out.len()/page;let mut at=32;
      while at+24+page<=wal.len() {
        if be(&wal,at+8)!=be(&wal,16)||be(&wal,at+12)!=be(&wal,20) {break;}
        pending.push((be(&wal,at) as usize,at+24));
        let commit=be(&wal,at+4);
        if commit!=0 {for (p,o) in pending.drain(..) {pages.insert(p,o);}count=commit as usize;}
        at+=24+page;
      }
      if !pages.is_empty() {
        let size=count.checked_mul(page).filter(|s|*s<=DB_LIMIT).ok_or_else(||fail("Use JS for large WAL output"))?;
        out.resize(size,0);
        for(p,o) in pages {if p>=1&&p<=count {out[(p-1)*page..p*page].copy_from_slice(&wal[o..o+page]);}}
      }
    }
  }
  if out.len()>=100&&out[18]==2 {out[18]=1;out[19]=1;}Ok(out)
}
pub struct DbTask {path:String}
impl Task for DbTask {
  type Output=Vec<u8>;type JsValue=Buffer;
  fn compute(&mut self)->Result<Vec<u8>> {
    let db=bounded_read(&self.path,DB_LIMIT)?;
    let wal=match bounded_read(&format!("{}-wal",self.path),DB_LIMIT.saturating_sub(db.len())) {Ok(b)=>b,Err(e)=>{
      if Path::new(&format!("{}-wal",self.path)).exists(){return Err(e);}Vec::new()
    }};
    merge(db,wal)
  }
  fn resolve(&mut self,_:Env,out:Vec<u8>)->Result<Buffer>{Ok(out.into())}
}
#[napi]
pub fn read_db_with_wal(path:String)->AsyncTask<DbTask>{AsyncTask::new(DbTask{path})}

pub struct WalkTask {dir:String}
fn walk(dir:&Path,out:&mut Vec<String>,bytes:&mut usize,depth:usize)->Result<()> {
  if depth>256 {return Err(fail("Use JS for deep directory tree"));}
  let entries=match fs::read_dir(dir) {Ok(it)=>it,Err(_)=>return Ok(())};
  for entry in entries {let entry=entry.map_err(fail)?;let kind=entry.file_type().map_err(fail)?;
    if kind.is_dir(){walk(&entry.path(),out,bytes,depth+1)?;}
    else {
      let name=entry.file_name();let name=name.to_str().ok_or_else(||fail("Use JS for path encoding"))?;
      if name.starts_with("rollout-")&&(name.ends_with(".jsonl")||name.ends_with(".jsonl.zst")) {
        let path=entry.path().into_os_string().into_string().map_err(|_|fail("Use JS for path encoding"))?;
        *bytes+=path.len();if out.len()>=10000||*bytes>2*1024*1024{return Err(fail("Use JS for large directory inventory"));}out.push(path);
      }
    }
  }Ok(())
}
impl Task for WalkTask {
  type Output=Vec<String>;type JsValue=Vec<String>;
  fn compute(&mut self)->Result<Vec<String>> {let mut out=Vec::new();walk(Path::new(&self.dir),&mut out,&mut 0,0)?;Ok(out)}
  fn resolve(&mut self,_:Env,out:Vec<String>)->Result<Vec<String>>{Ok(out)}
}
#[napi]
pub fn walk_rollouts(dir:String)->AsyncTask<WalkTask>{AsyncTask::new(WalkTask{dir})}

#[napi(object)]
pub struct RolloutFile {pub path:String,pub size:Option<f64>,pub mtime_ms:Option<f64>,pub birthtime_ms:Option<f64>,pub ctime_ms:Option<f64>}
pub struct ScanTask {dir:String}
fn millis(time:std::io::Result<std::time::SystemTime>)->Option<f64>{
 let time=time.ok()?;match time.duration_since(std::time::UNIX_EPOCH){Ok(v)=>Some(v.as_secs() as f64*1000.0+v.subsec_nanos() as f64/1_000_000.0),Err(v)=>{let d=v.duration();Some(-(d.as_secs() as f64*1000.0+d.subsec_nanos() as f64/1_000_000.0))}}
}
#[cfg(windows)]
fn change_millis(path:&str)->Option<f64>{
 use std::os::windows::{fs::OpenOptionsExt,io::AsRawHandle};
 #[repr(C)]struct BasicInfo{creation:i64,access:i64,write:i64,change:i64,attributes:u32}
 #[link(name="kernel32")]extern "system"{fn GetFileInformationByHandleEx(handle:*mut std::ffi::c_void,class:i32,info:*mut std::ffi::c_void,size:u32)->i32;}
 let f=fs::OpenOptions::new().access_mode(0x80).share_mode(7).open(path).ok()?;
 let mut info=BasicInfo{creation:0,access:0,write:0,change:0,attributes:0};
 if unsafe{GetFileInformationByHandleEx(f.as_raw_handle(),0,&mut info as *mut _ as *mut _,std::mem::size_of::<BasicInfo>() as u32)}==0{return None;}
 let ticks=info.change as i128-116_444_736_000_000_000i128;
 // Match libuv's seconds plus nanoseconds conversion, including pre-epoch times.
 let sec=ticks.div_euclid(10_000_000);let sub=ticks.rem_euclid(10_000_000);
 Some(sec as f64*1000.0+sub as f64/10_000.0)
}
#[cfg(not(windows))]
fn change_millis(_path:&str)->Option<f64>{None}
impl Task for ScanTask {
 type Output=Vec<RolloutFile>;type JsValue=Vec<RolloutFile>;
 fn compute(&mut self)->Result<Vec<RolloutFile>>{
  let mut paths=Vec::new();walk(Path::new(&self.dir),&mut paths,&mut 0,0)?;
  Ok(paths.into_iter().map(|path|{let m=fs::metadata(&path);RolloutFile{size:m.as_ref().ok().map(|s|s.len() as f64),mtime_ms:m.as_ref().ok().and_then(|s|millis(s.modified())),birthtime_ms:m.as_ref().ok().and_then(|s|millis(s.created())),ctime_ms:change_millis(&path),path}}).collect())
 }
 fn resolve(&mut self,_:Env,out:Vec<RolloutFile>)->Result<Vec<RolloutFile>>{Ok(out)}
}
#[napi]
pub fn scan_rollouts(dir:String)->AsyncTask<ScanTask>{AsyncTask::new(ScanTask{dir})}

struct ArrayMarker(bool);
impl<'de> Deserialize<'de> for ArrayMarker {
  fn deserialize<D:de::Deserializer<'de>>(d:D)->std::result::Result<Self,D::Error>{
    struct V;impl<'de> Visitor<'de> for V {
      type Value=ArrayMarker;
      fn expecting(&self,f:&mut std::fmt::Formatter)->std::fmt::Result{write!(f,"a JSON value")}
      fn visit_seq<A:SeqAccess<'de>>(self,mut a:A)->std::result::Result<ArrayMarker,A::Error>{while a.next_element::<IgnoredAny>()?.is_some(){}Ok(ArrayMarker(true))}
      fn visit_map<A:MapAccess<'de>>(self,mut a:A)->std::result::Result<ArrayMarker,A::Error>{while a.next_entry::<IgnoredAny,IgnoredAny>()?.is_some(){}Ok(ArrayMarker(false))}
      fn visit_bool<E:de::Error>(self,_:bool)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
      fn visit_i64<E:de::Error>(self,_:i64)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
      fn visit_u64<E:de::Error>(self,_:u64)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
      fn visit_f64<E:de::Error>(self,_:f64)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
      fn visit_str<E:de::Error>(self,_:&str)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
      fn visit_unit<E:de::Error>(self)->std::result::Result<ArrayMarker,E>{Ok(ArrayMarker(false))}
    }d.deserialize_any(V)
  }
}
struct Metadata(serde_json::Map<String,serde_json::Value>);
impl<'de> Deserialize<'de> for Metadata {
  fn deserialize<D:de::Deserializer<'de>>(d:D)->std::result::Result<Self,D::Error>{
    struct V;impl<'de> Visitor<'de> for V {
      type Value=Metadata;
      fn expecting(&self,f:&mut std::fmt::Formatter)->std::fmt::Result{write!(f,"a chat object")}
      fn visit_map<A:MapAccess<'de>>(self,mut a:A)->std::result::Result<Metadata,A::Error>{
        let mut out=serde_json::Map::new();let mut retained=0;
        while let Some(key)=a.next_key::<String>()? {
          if matches!(key.as_str(),"agent"|"localSource"|"agentFlowStep") {return Err(de::Error::custom("Use original parser for agent metadata"));}
          if key=="messages" {let marker=a.next_value::<ArrayMarker>()?;out.insert(key,if marker.0{serde_json::json!([])}else{serde_json::json!(false)});}
          else if matches!(key.as_str(),"id"|"origin"|"title"|"cwd"|"originalProject"|"importedCwd"|"createdAt"|"updatedAt"|"codexThreadId"|"codexActiveThreadId"|"pinned"|"lastProvider"|"sidebarProjectAssigned") {
            let value=a.next_value::<serde_json::Value>()?;
            if value.is_object()||value.is_array(){return Err(de::Error::custom("Use JS for nonprimitive metadata"));}
            retained+=value.to_string().len();if retained>256*1024{return Err(de::Error::custom("Use JS for oversized metadata"));}out.insert(key,value);
          }else{a.next_value::<IgnoredAny>()?;}
        }Ok(Metadata(out))
      }
    }d.deserialize_map(V)
  }
}
pub struct MetadataTask {path:String}
#[napi(object)]
pub struct MetadataResult {pub json:String,pub bytes_read:f64}
impl Task for MetadataTask {
  type Output=MetadataResult;type JsValue=MetadataResult;
  fn compute(&mut self)->Result<MetadataResult>{
    let mut f=fs::File::open(&self.path).map_err(fail)?;let length=f.metadata().map_err(fail)?.len();if length>32*1024*1024{return Err(fail("Use JS for large chat"));}
    // Bounded temporary source storage stays on the native worker. Only the
    // small projection crosses Node-API; slice parsing skips large body strings.
    let mut source=Vec::with_capacity(length as usize);let mut chunk=[0u8;64*1024];
    loop{let n=f.read(&mut chunk).map_err(fail)?;if n==0{break;}if source.len()+n>32*1024*1024{return Err(fail("Use JS for growing chat"));}source.extend_from_slice(&chunk[..n]);}
    std::str::from_utf8(&source).map_err(fail)?;
    let mut de=serde_json::Deserializer::from_slice(&source);
    let row=Metadata::deserialize(&mut de).map_err(fail)?;de.end().map_err(fail)?;
    let text=serde_json::to_string(&row.0).map_err(fail)?;if text.len()>256*1024{return Err(fail("Use JS for oversized metadata"));}Ok(MetadataResult{json:text,bytes_read:source.len() as f64})
  }
  fn resolve(&mut self,_:Env,out:MetadataResult)->Result<MetadataResult>{Ok(out)}
}
#[napi]
pub fn read_chat_metadata(path:String)->AsyncTask<MetadataTask>{AsyncTask::new(MetadataTask{path})}

pub struct PrefixTask {path:String,max_bytes:u32}
impl Task for PrefixTask {
 type Output=Vec<u8>;type JsValue=Buffer;
 fn compute(&mut self)->Result<Vec<u8>>{
  if self.max_bytes>256*1024{return Err(fail("History prefix limit exceeded"));}
  let mut file=fs::File::open(&self.path).map_err(fail)?;
  let size=file.metadata().map_err(fail)?.len().min(self.max_bytes as u64) as usize;
  let mut bytes=vec![0;size];let n=file.read(&mut bytes).map_err(fail)?;bytes.truncate(n);Ok(bytes)
 }
 fn resolve(&mut self,_:Env,out:Vec<u8>)->Result<Buffer>{Ok(out.into())}
}
#[napi]
pub fn read_history_prefix(path:String,max_bytes:u32)->AsyncTask<PrefixTask>{AsyncTask::new(PrefixTask{path,max_bytes})}

pub struct LedgerFileTask {path:String,text:String}
impl Task for LedgerFileTask {
 type Output=();type JsValue=();
 fn compute(&mut self)->Result<()>{
  use std::io::Write;
  // Validate before creating the unique temporary. Node performs the existing
  // Windows-aware atomic rename only after this durable worker write succeeds.
  if self.text.len()>16*1024*1024{return Err(fail("Ledger record limit exceeded"));}
  let value:serde_json::Value=serde_json::from_str(&self.text).map_err(fail)?;
  if !value.is_object(){return Err(fail("Ledger record must be a JSON object"));}
  drop(value);
  let mut file=fs::OpenOptions::new().create_new(true).write(true).open(&self.path).map_err(fail)?;
  file.write_all(self.text.as_bytes()).map_err(fail)?;file.flush().map_err(fail)?;file.sync_data().map_err(fail)?;Ok(())
 }
 fn resolve(&mut self,_:Env,_:())->Result<()>{Ok(())}
}
#[napi]
pub fn write_ledger_file(path:String,text:String)->AsyncTask<LedgerFileTask>{AsyncTask::new(LedgerFileTask{path,text})}
