'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const INDEX_LIMIT=4*1024*1024,INDEX_VERSION=2;
const agentFields=['parentKey','name','provider','status','model','level','error','finishedAt'];
// The sidebar owns only these small fields, never conversation bodies.
const fields = ['id','origin','title','cwd','originalProject','importedCwd','createdAt','updatedAt','codexThreadId','codexActiveThreadId','pinned','lastProvider','sidebarProjectAssigned'];
function select(chat) {
  const row = {};
  for (const key of fields) if (chat[key] !== undefined) row[key] = chat[key];
  if (chat.agentFlowStep) row.agentFlowStep = true;
  if (chat.localSource) row.localSource = {provider:chat.localSource.provider,id:chat.localSource.id,projectDir:chat.localSource.projectDir};
  if (chat.agent) {
    row.agent = Object.fromEntries(agentFields.filter(key=>chat.agent[key]!==undefined).map(key=>[key,chat.agent[key]]));
    if(chat.agent.resultSummary!==undefined)row.agent.resultSummary=chat.agent.resultSummary;
    else if(chat.agent.result!==undefined)row.agent.resultSummary=require('./agentResultSummary').clip(chat.agent.result,1200);
  }
  return row;
}
function create({ directory, io = fs, indexPath } = {}) {
  const cache = new Map();
  const generations = new Map();
  let scanWork = null;
  let indexLoaded = false;
  let writtenIndex = null;
  let writtenIndexStamp = null;
  const counts = {scans:0,reads:0,hits:0,errors:0,indexLoads:0,indexWrites:0,indexErrors:0};
  const stamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const indexWriter=require('./coalescedWrites').create(async()=>{
    if(!indexPath)return;
    const parts=[];let bytes=32;
    for(const [file,entry] of cache){
      if(entry.readRevision!==(generations.get(file)||0))continue;
      const text=JSON.stringify([file,entry.signature,entry.row]);bytes+=Buffer.byteLength(text)+1;
      if(bytes>INDEX_LIMIT){counts.indexErrors++;return;}parts.push(text);
    }
    const text='{"version":'+INDEX_VERSION+',"entries":['+parts.join(',')+']}';
    const target=indexPath(),temporary=target+'.'+crypto.randomUUID()+'.tmp';
    if(text===writtenIndex && writtenIndexStamp){try{if(stamp(await io.stat(target))===writtenIndexStamp){counts.indexWriteSkips=(counts.indexWriteSkips||0)+1;return;}}catch{}}
    try {await io.mkdir(path.dirname(target),{recursive:true});await io.writeFile(temporary,text,'utf8');await require('./atomicRename').replace(temporary,target);writtenIndex=text;counts.indexWrites++;try{writtenIndexStamp=stamp(await io.stat(target));}catch{writtenIndexStamp=null;}}
    catch(error){await io.unlink(temporary).catch(()=>{});throw error;}
  });
  function saveIndex(){if(!indexPath)return Promise.resolve();return indexWriter.request('index').catch(()=>{counts.indexErrors++;});}
  function validIndexRow(row,allowUndefined=false){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id)return false;
    const allowed=new Set([...fields,'agentFlowStep','agent','localSource']);
    for(const key of Object.keys(row)){
      if(!allowed.has(key))return false;
      const value=row[key];
      if(allowUndefined&&value===undefined)continue;
      if(['agent','localSource'].includes(key)){
        const keys=key==='agent'?[...agentFields,'resultSummary']:['provider','id','projectDir'];
        if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)||(allowUndefined&&value[k]===undefined?false:k==='finishedAt'?value[k]!==null&&!(typeof value[k]==='number'&&Number.isFinite(value[k])):['model','level','error'].includes(k)&&value[k]===null?false:typeof value[k]!=='string')))return false;
        if(key==='agent'&&value.resultSummary?.length>1240)return false;
      }else if(key==='agentFlowStep'){if(value!==true)return false;}
      else if(['createdAt','updatedAt'].includes(key)){if(typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))return false;}
      else if(['pinned','sidebarProjectAssigned'].includes(key)){if(typeof value!=='boolean')return false;}
      else if(value!==null&&typeof value!=='string')return false;
    }
    return row.title===undefined||typeof row.title==='string';
  }
  async function loadIndex(){
    if(indexLoaded)return;indexLoaded=true;if(!indexPath)return;
    let handle;
    try {
      const target=indexPath(),info=await io.stat(target);if(info.size>INDEX_LIMIT)throw Error('Oversized sidebar index');
      handle=await io.open(target,'r');const buffer=Buffer.allocUnsafe(65536),parts=[],decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes=0;
      for(;;){const read=await handle.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>INDEX_LIMIT)throw Error('Oversized sidebar index');parts.push(decoder.decode(buffer.subarray(0,read.bytesRead),{stream:true}));}parts.push(decoder.decode());
      const data=JSON.parse(parts.join(''));
      if(data?.version!==INDEX_VERSION||!Array.isArray(data.entries)||data.entries.length>10000)throw Error('Invalid sidebar index');
      const loaded=new Map();
      for(const entry of data.entries){
        if(!Array.isArray(entry)||entry.length!==3)throw Error('Invalid sidebar index entry');
        const [file,signature,row]=entry;
        if(typeof file!=='string'||!/^[a-zA-Z0-9_-]+\.json$/.test(file)||loaded.has(file)||typeof signature!=='string'||signature.length>100||!/^[-+\de.]+:[-+\de.]+:[-+\de.]+$/i.test(signature)||!validIndexRow(row)||file!==row.id+'.json')throw Error('Invalid sidebar index metadata');
        loaded.set(file,{row:select(row),signature,revision:0,readRevision:0});
      }
      for(const [file,entry] of loaded)cache.set(file,entry);counts.indexLoads++;
    }catch(error){if(error.code!=='ENOENT')counts.indexErrors++;}
    finally {await handle?.close().catch(()=>{});}
  }
  // Own writes invalidate before an asynchronous scan can install stale data.
  function invalidate(id) { const file = `${id}.json`; generations.set(file,(generations.get(file)||0)+1);if(indexLoaded&&indexPath)saveIndex(); }
  async function scan() {
    counts.scans++;
    await loadIndex();
    let files;
    try { await io.mkdir(directory(), {recursive:true}); files = (await io.readdir(directory())).filter(file=>file.endsWith('.json')); }
    catch { counts.errors++; return [...cache.values()].map(entry=>({...entry.row})); }
    const present = new Set(files);
    let changed=false;
    for (const file of cache.keys()) if (!present.has(file)) {cache.delete(file);changed=true;}
    for (const file of generations.keys()) if (!present.has(file)) generations.delete(file);
    for (const file of files) {
      let previous = cache.get(file), revision = generations.get(file) || 0;
      try {
        const full = path.join(directory(),file), before = await io.stat(full), signature = stamp(before);
        if (previous && previous.signature === signature && previous.readRevision === revision) { counts.hits++; continue; }
        counts.reads++;
        const chat = await require('./chatMetadataReader').read(full,io,counts);
        if (!chat || typeof chat.id!=='string' || !chat.id || (chat.messages !== undefined && !Array.isArray(chat.messages)) || (chat.title !== undefined && typeof chat.title!=='string')) {counts.errors++;continue;}
        // A malformed saved result is not a new status row. Keep the last
        // known summary; primitive results retain the legacy String semantics.
        if(chat.agent?.result!==null&&typeof chat.agent?.result==='object'){counts.errors++;continue;}
        const row = select(chat);if(!validIndexRow(row,true)){counts.errors++;continue;}const after = await io.stat(full);
        if (stamp(after) !== signature || (generations.get(file) || 0) !== revision) continue;
        cache.set(file,{row,signature,revision,readRevision:revision});
        changed=true;
      } catch { counts.errors++; /* Keep the known row on transient stat/read/parse failure. */ }
    }
    if(changed)await saveIndex();
    return [...cache.values()].map(entry=>({...entry.row,localSource:entry.row.localSource && {...entry.row.localSource},agent:entry.row.agent && {...entry.row.agent}}));
  }
  function list() {
    if (!scanWork) scanWork = scan().finally(()=>{scanWork=null;});
    return scanWork;
  }
  return {list,invalidate,flushIndex:saveIndex,get:id=>cache.get(`${id}.json`)?.row,stats:()=>({...counts,indexWriter:indexWriter.stats(),rows:cache.size,retainedBodyCount:[...cache.values()].filter(entry=>Object.hasOwn(entry.row,'messages')).length}),select};
}
module.exports = {create,select,INDEX_LIMIT,INDEX_VERSION};
