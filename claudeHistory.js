const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { parseImport } = require('./importChat');

// Cache only small sidebar summaries. Enumeration remains fresh on every call,
// including files added/removed by an independently running Claude CLI.
function create({io=fs,maxBytes=4*1024*1024,maxEntries=2048}={}) {
 const cache=new Map(),pending=new Map(),rootRevisions=new Map();
 let retainedBytes=0;
 const counts={prefixReads:0,prefixBytes:0,nativeReads:0,hits:0,coalesced:0,evictions:0};
 const signature=stat=>[stat.size,stat.mtimeMs,stat.ctimeMs].every(Number.isFinite)?`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`:null;
 const clone=row=>({...row,cwd:row.cwd&&typeof row.cwd==='object'?JSON.parse(JSON.stringify(row.cwd)):row.cwd});
 const ownerBytes=root=>Buffer.byteLength(root,'utf8')+16;
 function remove(key){const old=cache.get(key);if(old){retainedBytes-=old.bytes;cache.delete(key);}}
 function touch(key,entry){cache.delete(key);cache.set(key,entry);}
 function trim(){while(retainedBytes>maxBytes||cache.size>maxEntries){remove(cache.keys().next().value);counts.evictions++;}}
 function own(real,root){const entry=cache.get(real);if(!entry||entry.owners.has(root))return;if(entry.owners.size>=32){remove(real);counts.evictions++;return;}entry.owners.add(root);const bytes=ownerBytes(root);entry.bytes+=bytes;retainedBytes+=bytes;trim();}
 async function summary(filename,real,stat) {
  const stamp=signature(stat),prior=cache.get(real);
  if(stamp&&prior?.signature===stamp){counts.hits++;touch(real,prior);return clone(prior.row);}
  const key=stamp?real+'\0'+stamp:null;
  if(key&&pending.has(key)){counts.coalesced++;return clone(await pending.get(key));}
  const work=(async()=>{
   let handle;
   try {
    const limit=Math.min(stat.size,256*1024);let buf;
    if(io===fs){const native=require('./nativeAccelerator').getNative();if(typeof native?.readHistoryPrefix==='function')try{const value=await native.readHistoryPrefix(real,limit);if(Buffer.isBuffer(value)&&value.length<=limit){buf=value;counts.nativeReads++;}}catch{/* Original reader remains the compatibility fallback. */}}
    let bytesRead;
    if(buf){bytesRead=buf.length;}else{handle=await io.open(real,'r');buf=Buffer.alloc(limit);({bytesRead}=await handle.read(buf,0,buf.length,0));}
    counts.prefixReads++;counts.prefixBytes+=bytesRead;
    let title='',cwd='';
    for(const line of buf.subarray(0,bytesRead).toString('utf8').split('\n')) {
     let row;try{row=JSON.parse(line);}catch{continue;}
     if(row.cwd)cwd=row.cwd;
     if(!title&&row.type==='user'&&!row.isMeta&&!row.isSidechain){const content=row.message?.content;title=typeof content==='string'?content:(content||[]).filter(c=>c.type==='text').map(c=>c.text).join(' ');}
     if(row.type==='summary'&&row.summary)title=row.summary;
    }
    const row={id:crypto.createHash('sha256').update(real.toLowerCase()).digest('hex'),filename:real,projectDir:path.dirname(filename),title:title.replace(/\s+/g,' ').slice(0,100)||path.basename(filename,'.jsonl'),cwd,updatedAt:stat.mtimeMs};
    if(handle){await handle.close();handle=null;}
    // A growing/replaced file still yields the original best-effort summary,
    // but may never populate the cache until a stable read is observed.
    let stable=false;try{const after=await io.stat(real),resolvedAfter=await io.realpath(filename);stable=stamp&&signature(after)===stamp&&resolvedAfter===real;}catch{/* A successful prefix read remains usable, but not cacheable. */}
    if(stable&&typeof row.cwd==='string'){
     const owners=cache.get(real)?.owners||new Set();
     const bytes=Buffer.byteLength(JSON.stringify(row),'utf8')+Buffer.byteLength(real,'utf8')+stamp.length*2+[...owners].reduce((sum,root)=>sum+ownerBytes(root),0);
     if(bytes<=maxBytes&&maxEntries>0){remove(real);cache.set(real,{signature:stamp,row:clone(row),bytes,owners});retainedBytes+=bytes;trim();}
    }
    return row;
   } finally {await handle?.close();}
  })();
  if(key)pending.set(key,work);
  try{return clone(await work);}finally{if(key&&pending.get(key)===work)pending.delete(key);}
 }
// Only enumerate top-level session files. Nested subagent logs are not independent chats.
async function list(roots) {
  const sessions = new Map();
  const errors = [];
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const rootKey=path.resolve(root),revision={};
    rootRevisions.set(rootKey,revision);
    const observed=new Set();let complete=true;
    let projects;
    try { projects = await io.readdir(path.join(root, 'projects'), { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') {errors.push(`${root}: ${e.message}`);complete=false;} projects=[]; }
    for (const project of projects.filter(p => p.isDirectory())) {
      const dir = path.join(root, 'projects', project.name);
      let files;
      try { files = await io.readdir(dir, { withFileTypes: true }); } catch { complete=false;continue; }
      for (const file of files.filter(f => f.isFile() && f.name.endsWith('.jsonl'))) {
        const filename = path.join(dir, file.name);
        try {
          const real = await io.realpath(filename);
          observed.add(real);
          const id = crypto.createHash('sha256').update(real.toLowerCase()).digest('hex');
          if (sessions.has(id)) {own(real,rootKey);continue;}
          const stat = await io.stat(real);
          const row=await summary(filename,real,stat);
          // Aliased roots retain their own projectDir, as before caching.
          row.projectDir=dir;
          own(real,rootKey);
          sessions.set(id,row);
        } catch (e) { errors.push(`${file.name}: ${e.message}`); }
      }
    }
    if(complete&&rootRevisions.get(rootKey)===revision)for(const [real,entry]of cache){if(!observed.has(real)&&entry.owners.delete(rootKey)){const bytes=ownerBytes(rootKey);entry.bytes-=bytes;retainedBytes-=bytes;}if(!entry.owners.size)remove(real);}
    if(rootRevisions.get(rootKey)===revision)rootRevisions.delete(rootKey);
  }
  return { sessions: [...sessions.values()].sort((a,b) => b.updatedAt-a.updatedAt), errors };
}
return {list,stats:()=>({...counts,entries:cache.size,retainedBytes,pending:pending.size})};
}
const defaultStore=create();
const list=defaultStore.list;

async function read(session) {
  if (!session) throw new Error('找不到 Claude Code 對話，請重新載入側欄');
  if ((await fs.stat(session.filename)).size > 50 * 1024 * 1024) throw new Error('此紀錄超過 50 MB，請先匯出需要的對話片段');
  let raw = await fs.readFile(session.filename, 'utf8');
  // A running CLI may be writing its final JSONL line; keep all complete records.
  if (!raw.endsWith('\n')) {
    const tail = raw.slice(raw.lastIndexOf('\n') + 1);
    try { JSON.parse(tail); } catch { raw = raw.slice(0, raw.lastIndexOf('\n') + 1); }
  }
  const [data] = parseImport(raw, session.filename);
  return { ...data, title: session.title };
}
module.exports = { list, read, create, stats:defaultStore.stats };
