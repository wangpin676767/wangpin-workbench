'use strict';

const path = require('node:path');
const DOWNLOAD_URL = 'https://brave.com/download/';

// UI dependencies are injected so detecting a missing browser never launches or
// installs software by itself. Only an explicit dialog action opens the official page.
function create({detect,showMessageBox,showOpenDialog,openDownload,savePath=async()=>{}}) {
  let pending = null;
  async function guide({path:customPath='',reason=''} = {}) {
    let selected = customPath, note = '';
    for (;;) {
      const found = await detect(selected);
      if (found?.path) return {ready:true,path:found.path,missing:false,cancelled:false};
      const result = await showMessageBox({
        type:'info',title:'需要安裝 Brave',
        message:'這台電腦找不到 Brave，外部瀏覽器功能尚未準備好。',
        detail:[reason,'請到 Brave 官方網站安裝，完成後按「重新偵測」。已安裝在其他位置，可指定 brave.exe。',
          '若要用官方 ChatGPT／Codex 擴充操作網站，還需要在平常使用的 Brave 設定檔安裝官方擴充，並確認桌面 App 已連線。',note].filter(Boolean).join('\n\n'),
        buttons:['開啟 Brave 官方下載頁','重新偵測','指定 brave.exe','稍後'],defaultId:1,cancelId:3,noLink:true
      });
      if (result.response === 0) { await openDownload(DOWNLOAD_URL); note='官方下載頁已開啟。安裝完成後，回到這裡重新偵測。'; }
      else if (result.response === 1) note='仍未偵測到 Brave；請確認已完成安裝，或指定 brave.exe。';
      else if (result.response === 2) {
        const picked = await showOpenDialog({title:'選擇 Brave 執行檔 brave.exe',properties:['openFile'],filters:[{name:'Brave 執行檔',extensions:['exe']}]});
        if (picked.canceled || !picked.filePaths?.[0]) continue;
        const file = picked.filePaths[0];
        if (path.win32.basename(file).toLowerCase() !== 'brave.exe') { note='請選擇 Brave 的 brave.exe，不會改用其他瀏覽器。'; continue; }
        const custom = await detect(file);
        if (!custom?.path || path.resolve(custom.path).toLowerCase() !== path.resolve(file).toLowerCase()) { note='這個位置找不到可用的 brave.exe；請重新指定。'; continue; }
        selected = custom.path; await savePath(selected);
        return {ready:true,path:selected,missing:false,cancelled:false};
      } else return {ready:false,path:'',missing:true,cancelled:true};
    }
  }
  return {
    ensure(options) {
      // One installation guide is enough when multiple clicks arrive together.
      if (!pending) pending = guide(options).finally(()=>{pending=null;});
      return pending;
    }
  };
}

module.exports = {create,DOWNLOAD_URL};
