'use strict';
// Validate the entire JSON stream, retaining only whitelisted sidebar fields.
// Large message/tool strings are scanned directly in each 64 KiB input chunk.
const CHUNK_BYTES=64*1024,MAX_METADATA_CHARS=256*1024,MAX_DEPTH=2048;
const top=new Set(['id','origin','title','cwd','originalProject','importedCwd','createdAt','updatedAt','codexThreadId','codexActiveThreadId','pinned','lastProvider','sidebarProjectAssigned']);
const nested=Object.assign(Object.create(null),{agent:new Set(['parentKey','name','provider','status','model','level','result','error','finishedAt']),localSource:new Set(['provider','id','projectDir'])});
function parser({ restore = false, deletion = false } = {}) {
 const nested = Object.assign(Object.create(null), {agent:new Set(['parentKey','name','provider','status','model','level','result','error','finishedAt']),localSource:new Set(['provider','id','projectDir'])}, restore ? {restoredFrom:new Set(['key','updatedAt','threadId'])} : {}, deletion ? {agentFlowStep:new Set(['parentChatId'])} : {});
 const row=deletion?{attachmentPaths:[],attachmentReferencesComplete:true}:{},fileRefs=new Set(),frames=[];let rootStarted=false,rootDone=false,mode='',capture=null,parts=[],partSize=0,stringSize=0,metadataChars=0,keyTooLong=false,escaped=false,unicode=0,numberState='',literal='',literalAt=0,tokenPath=null,resultPreview=null;
 const specials=/["\\\u0000-\u001f]/g;
 function fail(){throw Error('Invalid or oversized sidebar JSON metadata');}
 function pathForValue(){const frame=frames.at(-1);if(!frame||frame.type!=='object')return null;
  if(deletion&&frame.key==='path'&&row.attachmentReferencesComplete)return '__fileRef';
  if(frame.path===null)return null;
  if(frame.path==='root'&&(top.has(frame.key)||nested[frame.key]||['agentFlowStep','messages'].includes(frame.key)))return frame.key;
  if(nested[frame.path]?.has(frame.key))return frame.path+'.'+frame.key;return null;
 }
 function append(text){if(mode==='string')stringSize+=text.length;if(!capture)return;if(capture==='result'){resultPreview.feed(text);return;}partSize+=text.length;
  if(capture==='key'&&partSize>1024){capture=null;parts=[];keyTooLong=true;return;}
  if(partSize>MAX_METADATA_CHARS)fail();parts.push(text);
 }
 function saveValue(key,value){if(!key)return;const split=key.indexOf('.');
  if(key==='__fileRef'){if(typeof value==='string'&&!fileRefs.has(value)){if(fileRefs.size>=2048||row.attachmentPaths.join('').length+value.length>65536){row.attachmentReferencesComplete=false;}else{fileRefs.add(value);row.attachmentPaths.push(value);}}return;}
  if(key==='agentFlowStep.parentChatId'){row.agentFlowParentChatId=value;return;}
  if(split<0){row[key]=value;return;}const parent=key.slice(0,split);row[parent] ||= {};const name=key.slice(split+1);
  if(key==='agent.result')delete row.agent.resultSummary;else if(key==='agent.resultSummary')delete row.agent.result;
  row[parent][name]=value;
 }
 function beginValue(kind){const frame=frames.at(-1),field=pathForValue();
  if(!frame){if(rootStarted||kind!=='object')fail();rootStarted=true;return field;}
  if(frame.type==='object'){if(frame.stage!=='value')fail();frame.stage='comma';}
  else {if(!['first','value'].includes(frame.stage))fail();frame.stage='comma';}
  if(field){
   if(field==='messages')row.messages=kind==='array'?[]:false;
   else if(field==='agentFlowStep')row.agentFlowStep=kind==='object'||kind==='array';
   else if(nested[field])row[field]=kind==='object'||kind==='array'?{}:null;
   else if(kind==='object'||kind==='array')saveValue(field,{});
  }
  return field;
 }
 function token(kind,value,preview=false){const frame=frames.at(-1);
  if(kind==='string'&&frame?.type==='object'&&['first','key'].includes(frame.stage)){frame.key=value;frame.stage='colon';return;}
  if(kind==='object'||kind==='array'){
   const field=beginValue(kind);if(frames.length>=MAX_DEPTH)fail();frames.push({type:kind,stage:'first',path:!frames.length?'root':nested[field]&&kind==='object'?field:null,key:null});return;
  }
  if(kind==='}'||kind===']'){
   if(!frame||frame.type!==(kind==='}'?'object':'array')||!['first','comma'].includes(frame.stage))fail();frames.pop();if(!frames.length)rootDone=true;return;
  }
  if(kind===':'){if(frame?.type!=='object'||frame.stage!=='colon')fail();frame.stage='value';return;}
  if(kind===','){if(!frame||frame.stage!=='comma')fail();frame.stage=frame.type==='object'?'key':'value';return;}
  const field=beginValue('primitive');
  if(field==='agentFlowStep')row.agentFlowStep=!!value;
  else if(field&&field!=='messages')saveValue(preview&&field==='agent.result'?'agent.resultSummary':field,value);
 }
 function startString(){const frame=frames.at(-1),isKey=frame?.type==='object'&&['first','key'].includes(frame.stage);tokenPath=pathForValue();
  capture=isKey&&(frame.path==='root'||nested[frame.path]||deletion)?'key':!isKey&&tokenPath&&tokenPath!=='messages'&&tokenPath!=='agentFlowStep'?'value':null;
  if(!isKey&&tokenPath==='agent.result'){capture='result';resultPreview=require('./agentResultSummary').jsonPreview();}
  parts=[];partSize=0;stringSize=0;keyTooLong=false;escaped=false;unicode=0;mode='string';append('"');
 }
 function endString(){let value=tokenPath==='agentFlowStep'&&stringSize>2;const preview=capture==='result';if(preview)value=resultPreview.finish();else if(capture){const raw=parts.join('');value=JSON.parse(raw);if(capture==='value'&&tokenPath!=='__fileRef'){metadataChars+=raw.length;if(metadataChars>MAX_METADATA_CHARS)fail();}}else if(keyTooLong)value=null;
  mode='';parts=[];capture=null;resultPreview=null;token('string',value,preview);
 }
 function finishNumber(){if(!['zero','int','fraction','exponent'].includes(numberState))fail();const value=capture?JSON.parse(parts.join('')):null;if(capture){metadataChars+=partSize;if(metadataChars>MAX_METADATA_CHARS)fail();}mode='';parts=[];capture=null;token('primitive',value);}
 function numberChar(ch){const digit=ch>='0'&&ch<='9';
  if(numberState==='minus'){if(!digit)fail();numberState=ch==='0'?'zero':'int';}
  else if(numberState==='zero'||numberState==='int'){
   if(digit){if(numberState==='zero')fail();}
   else if(ch==='.')numberState='dot';else if(ch==='e'||ch==='E')numberState='expStart';else return false;
  }else if(numberState==='dot'){if(!digit)fail();numberState='fraction';}
  else if(numberState==='fraction'){if(!digit){if(ch==='e'||ch==='E')numberState='expStart';else return false;}}
  else if(numberState==='expStart'){if(ch==='+'||ch==='-')numberState='expSign';else if(digit)numberState='exponent';else fail();}
  else if(numberState==='expSign'){if(!digit)fail();numberState='exponent';}
  else if(numberState==='exponent'&&!digit)return false;
  append(ch);return true;
 }
 function feed(text){let i=0;
  while(i<text.length){
   if(mode==='string'){
    if(unicode){const ch=text[i++];if(!/[0-9a-fA-F]/.test(ch))fail();append(ch);unicode--;continue;}
    if(escaped){const ch=text[i++];append(ch);escaped=false;if(ch==='u')unicode=4;else if(!'"\\/bfnrt'.includes(ch))fail();continue;}
    specials.lastIndex=i;const found=specials.exec(text);if(!found){append(text.slice(i));i=text.length;continue;}
    append(text.slice(i,found.index+1));i=found.index+1;
    if(found[0]==='"')endString();else if(found[0]==='\\')escaped=true;else fail();continue;
   }
   if(mode==='number'){if(numberChar(text[i])){i++;continue;}finishNumber();continue;}
   if(mode==='literal'){if(text[i++]!==literal[literalAt++])fail();if(literalAt===literal.length){mode='';token('primitive',literal==='true'?true:literal==='false'?false:null);}continue;}
   const ch=text[i++];if(ch===' '||ch==='\n'||ch==='\r'||ch==='\t')continue;if(rootDone)fail();
   if(ch==='"'){startString();continue;}
   if(ch==='{'||ch==='['){token(ch==='{'?'object':'array');continue;}
   if('}],:'.includes(ch)){token(ch);continue;}
   if(ch==='-'||(ch>='0'&&ch<='9')){mode='number';numberState=ch==='-'?'minus':ch==='0'?'zero':'int';tokenPath=pathForValue();capture=tokenPath&&tokenPath!=='messages'?'value':null;parts=[];partSize=0;append(ch);continue;}
   if(ch==='t'||ch==='f'||ch==='n'){mode='literal';literal=ch==='t'?'true':ch==='f'?'false':'null';literalAt=1;continue;}
   fail();
  }
 }
 function finish(){if(mode==='number')finishNumber();if(mode||frames.length||!rootDone)fail();return row;}
 return {feed,finish};
}
function parse(text){const p=parser();p.feed(text);return p.finish();}
async function read(file,io,counts, { restore = false, deletion = false } = {}) {
 // Native parsing validates the complete ordinary-chat JSON off the main thread.
 // Custom IO and agent/compatibility cases retain the original streaming oracle.
 if(!restore && !deletion && io===require('fs').promises){
  const native=require('./nativeAccelerator').getNative();
  if(typeof native?.readChatMetadata==='function'){
   try{const result=await native.readChatMetadata(file),row=JSON.parse(result.json);if(counts){counts.nativeReads=(counts.nativeReads||0)+1;counts.bytesRead=(counts.bytesRead||0)+result.bytesRead;counts.maxReadChunkBytes=Math.max(counts.maxReadChunkBytes||0,Math.min(CHUNK_BYTES,result.bytesRead));}return row;}
   catch{if(counts)counts.nativeFallbacks=(counts.nativeFallbacks||0)+1;}
  }
 }
 // Small synthetic IO fixtures may provide readFile only; real files use open/read.
 if(!io.open){const p=parser({restore,deletion});p.feed(await io.readFile(file,'utf8'));return p.finish();}
 const handle=await io.open(file,'r'),buffer=Buffer.allocUnsafe(CHUNK_BYTES),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),p=parser({restore,deletion});
 try {for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;if(counts){counts.bytesRead=(counts.bytesRead||0)+bytesRead;counts.maxReadChunkBytes=Math.max(counts.maxReadChunkBytes||0,bytesRead);}p.feed(decoder.decode(buffer.subarray(0,bytesRead),{stream:true}));}p.feed(decoder.decode());return p.finish();}
 finally {await handle.close();}
}
module.exports={read,parse,parser,CHUNK_BYTES,MAX_METADATA_CHARS,MAX_DEPTH};
