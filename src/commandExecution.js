'use strict';
const {execFile}=require('node:child_process');
const {killTree}=require('./codexRunner');
const PHASES=new Set(['received','awaiting_approval','spawning','spawned','first_output','exited','result_ready']);
function tracker(notify=()=>{}) {
  const startedAt=new Date().toISOString(),start=Date.now(),events=[];let terminal=false;
  return {update(phase,extra={}) {
    if(terminal||!PHASES.has(phase))return;
    const elapsedMs=Math.max(0,Date.now()-start);events.push({phase,elapsedMs});if(events.length>12)events.shift();
    const event={phase,startedAt,elapsedMs,events:events.map(e=>({...e}))};
    for(const key of ['stream','exitCode','reason','termination'])if(extra[key]!==undefined)event[key]=extra[key];
    if(phase==='result_ready')terminal=true;
    try{notify(event);}catch{/* Observability cannot change tool authorization or results. */}
  }};
}
function run(command,{cwd,signal,timeoutSeconds=120,progress,execImpl=execFile,killImpl=killTree,settleMs=1500}={}) {
  const limit=Math.max(5,Math.min(900,Number(timeoutSeconds)||120));
  return new Promise((resolve,reject)=>{
    let child,timer,grace,pipeTimer,settled=false,stopping='',exited=false,first=false,heldPipe=false;
    const cleanup=()=>{clearTimeout(timer);clearTimeout(grace);clearTimeout(pipeTimer);signal?.removeEventListener('abort',abort);};
    const finish=(error,output='')=>{
      if(settled)return;settled=true;cleanup();
      // Inherited pipes can outlive the parent. Detach without pretending the
      // descendant exited, or sending taskkill to a PID that could be reused.
      if(stopping||heldPipe){child?.stdout?.destroy();child?.stderr?.destroy();child?.unref?.();}
      progress?.update('result_ready',{reason:stopping||(error?'failed':'success'),termination:heldPipe?'parent_exited_pipes_open':exited?'process_exited':'unconfirmed'});
      if(error)reject(error);else resolve(output);
    };
    const stoppedError=()=>Object.assign(Error((stopping==='cancelled'?'已停止；':'指令超過 '+limit+' 秒已中止等待；')+(exited?'命令程序已退出。':'尚無法確認命令程序已終止，請先核對狀態，勿自動重試。')),{name:stopping==='cancelled'?'AbortError':'Error'});
    const stop=reason=>{
      if(settled||stopping)return;stopping=reason;clearTimeout(timer);
      if(!exited)try{killImpl(child);}catch{/* Bounded settlement remains active if termination fails. */}
      grace=setTimeout(()=>finish(stoppedError()),settleMs);
    };
    const abort=()=>stop('cancelled');
    if(signal?.aborted){stopping='cancelled';finish(stoppedError());return;}
    progress?.update('spawning');
    try{child=execImpl('powershell.exe',['-NoProfile','-NonInteractive','-Command',String(command)],{cwd,windowsHide:true,maxBuffer:4*1024*1024},(error,stdout='',stderr='')=>{
      if(settled)return;
      if(stopping){finish(stoppedError());return;}
      if(error){const bounded=String(stderr).slice(-4000);finish(Error(String(error.message)+(bounded?'\n'+bounded:'')));return;}
      const output=String(stdout)+String(stderr);
      if(Buffer.byteLength(output,'utf8')>4*1024*1024){finish(Error('命令輸出合計超過 4 MiB；結果未完整保留，請縮小輸出範圍，勿自動重試。'));return;}
      finish(null,output);
    });}catch(error){finish(error);return;}
    child.once('spawn',()=>{if(!settled)progress?.update('spawned');});
    const firstOutput=stream=>chunk=>{if(settled||first||!chunk?.length)return;first=true;progress?.update('first_output',{stream});};
    child.stdout?.on('data',firstOutput('stdout'));child.stderr?.on('data',firstOutput('stderr'));
    child.once('exit',code=>{
      if(settled)return;exited=true;progress?.update('exited',{exitCode:Number.isInteger(code)?code:null});
      pipeTimer=setTimeout(()=>{heldPipe=true;if(stopping)finish(stoppedError());else finish(Error('命令主程序已退出，但輸出管道未結束；子程序狀態及結果未知，請先核對狀態，勿自動重試。'));},settleMs);
    });
    child.once('error',error=>{if(!settled)finish(error);});
    timer=setTimeout(()=>stop('timeout'),limit*1000);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
module.exports={tracker,run};
