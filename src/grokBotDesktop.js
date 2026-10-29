'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
function executable(localAppData=process.env.LOCALAPPDATA){
  if(!localAppData)throw Error('找不到 Windows 本機應用程式資料夾');
  return path.join(localAppData,'Programs','Grok Bot','Grok Bot.exe');
}
async function open({localAppData,launch=spawn}={}){
  const exe=executable(localAppData);
  let stat;try{stat=await fs.stat(exe);}catch{throw Error('找不到已安裝的 Grok Bot，請確認安裝於 AppData\\Local\\Programs\\Grok Bot。');}
  if(!stat.isFile())throw Error('Grok Bot 執行檔無效');
  await new Promise((resolve,reject)=>{
    const child=launch(exe,[],{cwd:path.dirname(exe),shell:false,detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
  return {ok:true,external:true,message:'已啟動 Grok Bot。請在外部程式內操作；回答不會自動回傳工作台。'};
}
module.exports={executable,open};
