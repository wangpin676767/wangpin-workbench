const path=require('path');
const fs=require('fs');
const os=require('os');
const {spawnCli,findOnPath,killTree}=require('./codexRunner');
function python(custom) {
  const candidates=[custom,path.join(os.homedir(),'.zenith','src','zenith','.venv','Scripts','python.exe'),findOnPath(process.platform==='win32'?['python.exe']:['python3','python'])];
  return candidates.find(file=>file && fs.existsSync(file) && !/WindowsApps/i.test(file)) || null;
}
function execute(args,{pythonPath,runner,signal,timeoutMs=1200000,onProgress}={}) {
  const bin=python(pythonPath);
  if(!bin) return Promise.reject(new Error('找不到 Python 3.10 以上，請在 RAGthoven 設定填入 python.exe 路徑。'));
  if(signal?.aborted) return Promise.reject(new Error('已取消'));
  return new Promise((resolve,reject)=>{
    const child=spawnCli(bin,['-u',path.join(__dirname,'ragthoven_worker.py')],{env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
    const controller=new AbortController();let ended=false,buffer='',stderr='';const start=Date.now();
    const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();killTree(child);error?reject(error):resolve(JSON.stringify(result));};
    const abort=()=>finish(new Error('已取消'));
    const timer=setTimeout(()=>finish(new Error('RAGthoven 的總時間已用完，工具鏈沒有跑完。請縮小主題或提高時間上限再試一次。')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',finish);child.stdin.on('error',error=>{if(!ended)finish(error);});
    child.stderr.on('data',data=>stderr=(stderr+data).slice(-2000));
    child.on('close',code=>{if(!ended)finish(new Error(`RAGthoven 提早結束（${code}）：${stderr}`));});
    const handle=async event=>{
      if(ended)return;
      if(event.type==='result')return finish(null,event.result);
      if(event.type==='error')return finish(new Error(event.message));
      if(event.type==='model_request') {
        if(!runner)throw new Error('RAGthoven 尚未取得目前對話的模型');
        onProgress?.(`RAGthoven 第 ${event.id} 階段`);
        const message='這是純文字創作任務，只輸出要求的文字，不使用工具或修改檔案。\n\n'+event.messages.map(m=>`[${m.role}]\n${m.content}`).join('\n\n');
        // 剩下的時間見底時要直接說「總時間用完」。夾成 1ms 會讓下一階段立刻逾時，
        // 使用者只會看到「某一階段逾時」，完全看不出是整條工具鏈的預算花光了。
        const left=timeoutMs-(Date.now()-start);
        if(left<10000)throw new Error(`RAGthoven 的總時間（${Math.round(timeoutMs/60000)} 分鐘）在第 ${event.id} 階段前就用完了，工具鏈沒有跑完。請把主題縮小，或提高這次的時間上限再試一次。`);
        const result=await runner.ask(message,{name:`RAGthoven 第 ${event.id} 階段`,signal:controller.signal,timeoutMs:left});
        if(!ended)child.stdin.write(JSON.stringify({id:event.id,text:result.text})+'\n');
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data=>{buffer+=data;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;try{Promise.resolve(handle(JSON.parse(line))).catch(finish);}catch(error){finish(error);}}});
    child.stdin.write(JSON.stringify(args)+'\n');
  });
}
module.exports={python,execute};
