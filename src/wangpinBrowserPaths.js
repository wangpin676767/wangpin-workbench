'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function locations({home=os.homedir(),localAppData=process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),appData=process.env.APPDATA||path.join(home,'AppData','Roaming')}={}){
 return {installed:path.join(localAppData,'Programs','WangpinBrowser'),legacy:path.join(localAppData,'Programs','WangpinBrowser','firefox.exe'),profiles:path.join(appData,'Wangpin','Wangpin')};
}
function installedPath(options){const dir=locations(options).installed;return ['WangpinBrowser.exe','firefox.exe'].map(name=>path.join(dir,name)).find(file=>{try{return fs.statSync(file).isFile();}catch{return false;}})||'';}
function resolveExecutable(configured='',options){const loc=locations(options),installed=installedPath(options);return installed && (!configured || same(configured,loc.legacy))?installed:configured||loc.legacy;}
function isInstalled(executable,options){return same(path.dirname(executable),locations(options).installed);}
function sections(file){const stat=fs.statSync(file);if(stat.size>1024*1024)throw Error('王品瀏覽器設定檔清單過大');const result=[];let current;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const heading=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(heading){current={section:heading[1]};result.push(current);}else{const pair=/^\s*([^;#=]+?)\s*=\s*(.*?)\s*$/.exec(line);if(current&&pair)current[pair[1]]=pair[2];}}return result;}
function defaultProfile(executable,options){
 if(!isInstalled(executable,options))return path.join(path.dirname(path.dirname(executable)),'profile');
 const base=locations(options).profiles;
 let list;try{list=sections(path.join(base,'profiles.ini'));}catch{throw Error('找不到安裝版王品瀏覽器的設定檔清單；請先正常開啟安裝版一次。');}
 const profiles=list.filter(s=>/^Profile\d+$/i.test(s.section)&&s.Path).map(s=>({...s,dir:s.IsRelative==='1'?path.resolve(base,s.Path):path.resolve(s.Path)})).filter(s=>fs.existsSync(s.dir));
 const installs=list.filter(s=>/^Install/i.test(s.section)&&s.Default).map(s=>path.resolve(base,s.Default));
 const preferred=profiles.filter(s=>installs.some(dir=>same(dir,s.dir)));
 if(preferred.length===1)return preferred[0].dir;
 const defaults=profiles.filter(s=>s.Default==='1');if(!preferred.length&&defaults.length===1)return defaults[0].dir;
 if(profiles.length===1)return profiles[0].dir;
 throw Error('無法唯一確認安裝版王品瀏覽器的預設設定檔，已停止另開空白設定檔。');
}
module.exports={locations,installedPath,resolveExecutable,isInstalled,defaultProfile};
