// 启动耗时探针：量"启动页消失"的时刻（= 用户第一次能操作墙的时间）。
//
// 用法：node tools/boot-time.js
// 判读：连续跑 3 次取中位数；同机有别的 Electron/CI 在跑时数字会明显偏高。
// 用法示例：改启动逻辑前后各跑 3 次，差 200ms 以上才值得讨论"是不是变慢了"。
'use strict';
const { spawn } = require('child_process'); const fs=require('fs'),path=require('path'),os=require('os');
const ROOT=path.join(__dirname,'..'), EXE=process.env.QF_ELECTRON_BIN||require('electron');
const PROFILE=path.join(os.tmpdir(),'qfs-bt-'+Date.now()), PORT=9352;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const child=spawn(EXE,['--no-sandbox','--user-data-dir='+PROFILE,'--remote-debugging-port='+PORT,ROOT],{cwd:ROOT,stdio:'ignore',windowsHide:true});
  let page=null;
  for(let i=0;i<60&&!page;i++){await sleep(150);try{page=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');}catch(_){}}
  if(!page){console.log('NO_PAGE');process.exit(1);}
  const ws=new WebSocket(page.webSocketDebuggerUrl); let id=0; const P=new Map();
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;P.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(P.has(i)){P.delete(i);rej(new Error('t'));}},15000);});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&P.has(m.id)){const p=P.get(m.id);P.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}});
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r.exceptionDetails?null:r.result.value;};
  // 先等到启动页真的进了 DOM（否则连上的是空白页，"没 splash" 是假象）
  for(let i=0;i<200;i++){ if(await ev('!!document.getElementById("splash")')) break; await sleep(20); }
  // 轮询到启动页真正移除，记录当时的 performance.now()
  let goneAt=0, decoded=0;
  for(let i=0;i<200;i++){
    const s=await ev(`(() => {
      const sp=document.getElementById('splash');
      if (sp) return { gone:false };
      const g=document.getElementById('presetWallGrid');
      let dec=0; if(g) for(const im of g.querySelectorAll('img')) if(im.complete&&im.naturalWidth) dec++;
      return { gone:true, t:Math.round(performance.now()), dec };
    })()`);
    if(s && s.gone){ goneAt=s.t; decoded=s.dec; break; }
    await sleep(25);
  }
  console.log('BOOTTIME splashGone=' + goneAt + 'ms decoded=' + decoded);
  ws.close(); child.kill(); try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch(_){}
  process.exit(0);
})().catch(e=>{console.error('FAIL '+(e&&e.message));process.exit(1);});
