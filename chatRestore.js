'use strict';
const fs = require('fs').promises;
const path = require('path');
const backup = require('./chatBackup');
const metadata = require('./chatMetadataReader');
const tick = () => new Promise(resolve => setImmediate(resolve));
const regularName = name => /^[a-zA-Z0-9_-]+\.json$/.test(name) && !/^flowstep_/i.test(name);
const identity = chat => ({id:chat.id,updatedAt:chat.updatedAt,cwd:chat.cwd,importedCwd:chat.importedCwd,restoredFrom:chat.restoredFrom});

// Never collect message bodies from the existing store. Hidden stage files are
// excluded before opening: old profiles can contain gigabytes of those records.
async function identities(directory, onProgress = () => {}, isCancelled=()=>false) {
  const result = [];
  let files;
  try { files = await fs.readdir(directory, {withFileTypes:true}); }
  catch (error) { if(error.code==='ENOENT')return result;throw error; }
  let scanned=0;
  for (const item of files) {
    if(isCancelled())break;
    if (!item.isFile() || !regularName(item.name)) continue;
    const full=path.join(directory,item.name),before=await fs.stat(full);
    // A corrupt ordinary conversation must not prevent recovery of other data.
    try {
      const row=await metadata.read(full,fs,null,{restore:true});
      const after=await fs.stat(full);
      if(before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw Error('對話仍在變動，請停止執行後重試');
      if(row.id && !row.agentFlowStep && !row.agent?.parentKey)result.push(identity(row));
    } catch(error) { if(/仍在變動/.test(error.message))throw error; }
    onProgress({phase:'scan',count:++scanned});
  }
  return result;
}

async function restore(entries, {directory,attachmentsDir,newId,readChat,writeChat,target={mode:'none'},onProgress=()=>{},isCancelled=()=>false}) {
  const existing=await identities(directory,onProgress,isCancelled);
  const result={keys:[],dupKeys:[],skipped:0,errors:[],dirs:[]};
  const dirs=new Set();let count=0;
  const place=async orig=>target.mode==='project' ? target.cwd||'' : target.mode==='original' && orig && await fs.stat(orig).then(s=>s.isDirectory(),()=>false) ? orig : '';
  try {
    for await(const entry of entries) {
      if(isCancelled()){result.cancelled=true;break;}
      const createdFiles=[];
      try {
        if(!entry || !Array.isArray(entry.messages))throw Error('備份中的對話格式不正確');
        const dup=backup.findDuplicate(entry,existing);
        if(dup) {
          if(!dup.cwd && target.mode!=='none') {
            const cwd=await place(dup.importedCwd);
            if(cwd){const chat=await readChat(dup.id);if(!chat)throw Error('既有對話無法讀取');chat.cwd=cwd;chat.sidebarProjectAssigned=true;delete chat.originalProject;delete chat.workspace;await writeChat(chat,{keepTime:true});dup.cwd=cwd;}
          }
          dirs.add(dup.cwd || '');
          result.skipped++;result.dupKeys.push('app:'+dup.id);
        } else {
          const chat=backup.unpackEntry(entry,{newId,attachmentsDir,createdFiles});
          if(await readChat(chat.id))throw Error('新對話識別碼已存在，未覆寫');
          chat.cwd=await place(chat.importedCwd);
          // A saved workspace is data, never authority to override placement.
          delete chat.originalProject;delete chat.workspace;delete chat.agentFlowStep;delete chat.agent;
          chat.sidebarProjectAssigned=true;
          await writeChat(chat,{keepTime:true});
          existing.push(identity(chat));
          result.keys.push('app:'+chat.id);dirs.add(chat.cwd || '');
        }
      } catch(error) { for(const file of createdFiles)await fs.unlink(file).catch(()=>{});result.errors.push(`第 ${count+1} 段：${error.message}`); }
      onProgress({phase:'restore',count:++count,restored:result.keys.length,skipped:result.skipped,errors:result.errors.length});
      await tick();
    }
  } catch(error) { result.errors.push(error.message); }
  result.dirs=[...dirs];return result;
}

// A user-selected old userData/data root or its chats child. No credentials,
// settings, internal stage records, temporary files or linked directories copied.
async function folderDirectory(selected, destination) {
  const resolved=await fs.realpath(selected);
  if((await fs.lstat(selected)).isSymbolicLink())throw Error('請直接選擇實際的對話資料夾，不支援連結資料夾');
  const directory=path.basename(resolved).toLowerCase()==='chats'?resolved:path.join(resolved,'chats');
  if((await fs.lstat(directory)).isSymbolicLink())throw Error('請直接選擇實際的對話資料夾，不支援連結資料夾');
  if(destination){
    const dest=await fs.realpath(destination).catch(()=>path.resolve(destination));
    const inside=(a,b)=>{const rel=path.relative(a,b);return !rel || rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
    if(inside(directory,dest)||inside(dest,directory))throw Error('來源與目前對話資料夾相同或互相包含，不需再次載入');
  }
  if(!(await fs.stat(directory)).isDirectory())throw Error('請選擇包含 chats 的資料目錄或 chats 資料夾');
  return directory;
}
async function* folderEntries(selected, onProgress=()=>{}) {
  const directory=await folderDirectory(selected);
  const names=await fs.readdir(directory,{withFileTypes:true});
  let count=0;
  for(const item of names) {
    if(!item.isFile() || !regularName(item.name))continue;
    const file=path.join(directory,item.name);
    const before=await fs.stat(file);
    const row=await metadata.read(file,fs,null,{restore:true});
    if(row.agentFlowStep || row.agent?.parentKey)continue;
    const chat=JSON.parse(await fs.readFile(file,'utf8'));
    const after=await fs.stat(file);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw Error('來源對話仍在變動，請先停止來源工作台後重試');
    if(!chat.id || !Array.isArray(chat.messages))throw Error('來源對話格式不正確：'+item.name);
    // Resolve old relative attachments only inside the selected data root.
    const root=path.dirname(directory);
    for(const message of chat.messages)if(Array.isArray(message?.attachments)){
      message.attachments=await Promise.all(message.attachments.map(async attachment=>{
        if(!attachment?.path || attachment.data || attachment.text)return attachment;
        const candidate=path.resolve(root,attachment.path),rel=path.relative(root,candidate);
        let safe=!!rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel),current=root;
        if(safe)for(const part of rel.split(path.sep)){
          current=path.join(current,part);
          const info=await fs.lstat(current).catch(()=>null);
          if(!info || info.isSymbolicLink()){safe=false;break;}
        }
        if(!safe)return {...attachment,path:undefined,missing:true};
        return {...attachment,path:candidate};
      }));
    }
    onProgress({phase:'folder',count:++count});
    yield await backup.packEntry(chat,{sourceKey:'app:'+chat.id});
  }
}
module.exports={identities,restore,folderDirectory,folderEntries,regularName};
