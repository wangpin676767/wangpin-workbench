'use strict';
// Exact, independently checked Codex rollout ownership. Never export a merged DB.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT=/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl(?:\.zst)?$/i;
const LIMIT=256*1024,INDEX_LIMIT=32*1024*1024;
const normalized=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const signature=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;
// DB rows may carry the Win32 extended-length prefix (\\?\C:\... or \\?\UNC\...); strip it so ownership checks compare like with like.
const plain=p=>String(p).replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'');
function inside(root,file){const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
async function safe(file,{missing=false,directory=false}={}){
 const absolute=path.resolve(file),parsed=path.parse(absolute);let current=parsed.root,last;
 for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{last=await fsp.lstat(current);}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
  if(last.isSymbolicLink())throw new Error('Linked path is not allowed: '+current);
  if(current!==absolute&&!last.isDirectory())throw new Error('Invalid ancestor directory: '+current);
 }
 if(!last)last=await fsp.lstat(absolute);
 if(normalized(await fsp.realpath(absolute))!==normalized(absolute))throw new Error('Redirected path is not allowed: '+absolute);
 if(directory?!last.isDirectory():!last.isFile())throw new Error('Invalid path type: '+absolute);
 if(!directory&&last.nlink!==1)throw new Error('Hard-linked files are not allowed: '+absolute);
 return last;
}
async function prefixMeta(file,st){
 const handle=await fsp.open(file,'r');let bytes=Buffer.alloc(0),done=false;
 const accept=chunk=>{if(done)return;const newline=chunk.indexOf(10),part=newline>=0?chunk.subarray(0,newline):chunk;if(bytes.length+part.length>LIMIT){done=true;throw new Error('Metadata line exceeds limit');}bytes=Buffer.concat([bytes,part]);if(newline>=0){done=true;throw STOP;}};
 const STOP={};
 try{
  if(signature(await handle.stat())!==signature(st))throw new Error('Rollout changed before metadata read');
  const compressed=file.endsWith('.zst'),decoder=compressed?new(require('fzstd').Decompress)(accept):null;
  const buffer=Buffer.alloc(64*1024);
  try{for(let total=0;total<LIMIT&&!done;){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,LIMIT-total),null);if(!bytesRead)break;total+=bytesRead;if(decoder)decoder.push(buffer.subarray(0,bytesRead));else accept(buffer.subarray(0,bytesRead));}}catch(e){if(e!==STOP)throw e;}
  if(signature(await handle.stat())!==signature(st))throw new Error('Rollout changed during metadata read');
  if(!done&&bytes.length>=LIMIT)throw new Error('Metadata line exceeds limit');
  const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return record.type==='session_meta'&&record.payload&&typeof record.payload==='object'?record.payload:{};
 }finally{await handle.close();}
}
async function inventory(home,threads=[],{walk:doWalk=true}={}){
 home=path.resolve(home);await safe(home,{directory:true});
 const byId=new Map(),errors=[];
 for(const row of threads){if(!UUID.test(String(row.id||'')))continue;const id=String(row.id).toLowerCase();byId.set(id,{...row,id,paths:[],parentThreadId:row.parentThreadId||null,mtimeMs:row.mtimeMs||row.updatedAt||0});}
 const entries=await fsp.readdir(home,{withFileTypes:true});
 const dbNames=entries.map(e=>e.name).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
 const dbPath=dbNames.length?path.join(home,dbNames[0]):null;
 if(dbPath){await safe(dbPath);for(const suffix of ['-wal','-shm'])await safe(dbPath+suffix,{missing:true});}
 async function walk(directory,archived){
  const stat=await safe(directory,{directory:true,missing:true});if(!stat)return;
  for(const entry of await fsp.readdir(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Linked session path is not allowed: '+file);
   if(entry.isDirectory()){await walk(file,archived);continue;}
   const match=entry.name.match(ROLLOUT);if(!match)continue;const st=await safe(file),id=match[1].toLowerCase();let meta={};
   try{meta=await prefixMeta(file,st);}catch(e){errors.push({id,file,message:'Cannot read bounded session metadata: '+e.message});}
   const source=meta.source,sub=source&&typeof source==='object'&&(Object.hasOwn(source,'subagent')||Object.hasOwn(source,'sub_agent'));
   const parent=meta.parent_thread_id||source?.subagent?.thread_spawn?.parent_thread_id||null;
   if(meta.id&&String(meta.id).toLowerCase()!==id)throw new Error('Rollout filename and session identity disagree: '+file);
   const row=byId.get(id)||{id,paths:[],parentThreadId:null,archived:false,subagent:false,mtimeMs:0};
   row.paths.push(file);row.archived=!!row.archived||archived;row.subagent=!!row.subagent||!!parent||!!sub||/^(?:zenith|prime[-_ ]?agent)$/i.test(String(meta.originator||''));
   if(parent&&UUID.test(String(parent)))row.parentThreadId=String(parent).toLowerCase();row.mtimeMs=Math.max(row.mtimeMs||0,st.mtimeMs);byId.set(id,row);
  }
 }
 if(doWalk){await walk(path.join(home,'sessions'),false);await walk(path.join(home,'archived_sessions'),true);}
 // A DB path is not permission to traverse outside the two owned session roots.
 for(const row of threads){const id=String(row.id||'').toLowerCase(),target=byId.get(id);if(!target)continue;for(const supplied of [row.rolloutPath,row.rollout_path,...(row.paths||[])].filter(Boolean)){
  const file=path.resolve(plain(supplied)),match=path.basename(file).match(ROLLOUT);
  if(![path.join(home,'sessions'),path.join(home,'archived_sessions')].some(root=>inside(root,file))||!match||match[1].toLowerCase()!==id)throw new Error('Unverified Codex rollout path: '+file);
  const st=await safe(file,{missing:true});if(st&&!target.paths.some(p=>normalized(p)===normalized(file)))target.paths.push(file);
 }}
 return {home,dbPath,threads:[...byId.values()],errors};
}
async function prepareIndex(home,ids){
 const file=path.join(home,'session_index.jsonl'),st=await safe(file,{missing:true});if(!st)return null;if(st.size>INDEX_LIMIT)throw new Error('Session index exceeds safe deletion limit');
 const handle=await fsp.open(file,'r');let data;
 try{if(signature(await handle.stat())!==signature(st))throw new Error('Session index changed');data=Buffer.alloc(st.size);let offset=0;while(offset<data.length){const r=await handle.read(data,offset,data.length-offset,offset);if(!r.bytesRead)throw new Error('Session index changed');offset+=r.bytesRead;}if(signature(await handle.stat())!==signature(st))throw new Error('Session index changed');}finally{await handle.close();}
 const text=new TextDecoder('utf-8',{fatal:true}).decode(data),lines=text.match(/[^\n]*\n|[^\n]+$/g)||[];
 const filtered=lines.filter(line=>{try{const record=JSON.parse(line);return !ids.has(String(record.id||'').toLowerCase());}catch{return true;}}).join('');
 return filtered===text?null:{file,signature:signature(st),text:filtered};
}
async function execute(home,threads,ids,{walk=true}={}){
 if(!Array.isArray(ids)||ids.some(id=>!UUID.test(String(id))))throw new Error('Invalid exact thread UUID selection');
 ids=[...new Set(ids.map(id=>String(id).toLowerCase()))];const result={deletedFiles:0,deletedBytes:0,threadCount:0,errors:[]};if(!ids.length)return result;
 const found=await inventory(home,walk?threads:threads.filter(row=>ids.includes(String(row.id).toLowerCase())),{walk}),byId=new Map(found.threads.map(row=>[row.id,row])),wanted=new Set(ids);
 // Unreadable rollout prefixes (large/truncated .zst) only hide parent hints; the exact path/signature checks below still gate every unlink.
 const index=await prepareIndex(found.home,wanted),native=found.dbPath?require('./nativeAccelerator').getNative():null;
 if(found.dbPath&&typeof native?.deleteCodexThreads!=='function')throw new Error('Native live SQLite deletion is unavailable; no data was changed');
 const planned=[];for(const id of ids){const row=byId.get(id);if(!row)throw new Error('Selected thread is absent from current inventory: '+id);for(const file of row.paths)planned.push({id,file,signature:signature(await safe(file))});}
 for(let at=0;at<ids.length;at+=512){const chunk=ids.slice(at,at+512),set=new Set(chunk);
  try{if(found.dbPath){await safe(found.dbPath);for(const suffix of ['-wal','-shm'])await safe(found.dbPath+suffix,{missing:true});await native.deleteCodexThreads(found.dbPath,chunk);}}catch(e){result.errors.push({ids:chunk,message:e.message});break;}
  for(const id of chunk){let failed=false;for(const entry of planned.filter(e=>e.id===id))try{const st=await safe(entry.file);if(signature(st)!==entry.signature)throw new Error('Rollout changed after deletion was planned');await fsp.unlink(entry.file);result.deletedFiles++;result.deletedBytes+=st.size;}catch(e){failed=true;result.errors.push({id,file:entry.file,message:e.message});}if(!failed)result.threadCount++;}
 }
 // Only remove names for completed exact deletions. A failed partial batch can be retried.
 if(index&&!result.errors.length){let temporary;try{const current=await safe(index.file);if(signature(current)!==index.signature)throw new Error('Session index changed; retained latest index');temporary=index.file+'.'+crypto.randomUUID()+'.tmp';const handle=await fsp.open(temporary,'wx');try{await handle.writeFile(index.text,'utf8');await handle.sync();}finally{await handle.close();}if(signature(await safe(index.file))!==index.signature)throw new Error('Session index changed; retained latest index');await require('./atomicRename').replace(temporary,index.file);temporary=null;}catch(e){result.errors.push({file:index.file,message:e.message});}finally{if(temporary)await fsp.unlink(temporary).catch(()=>{});}}
 return result;
}
module.exports={inventory,execute};
