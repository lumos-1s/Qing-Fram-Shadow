// 预设墙"每帧到底改了多少次 transform"的确定性探针。
// 与帧耗时不同，这个数字不受机器负载影响，用来判断"减少写入"类改动有没有真的生效。
//
// 用法：node tools/wall-writes.js
// 参考（本机 87 预设 / 360 节点）：未量化约 26 次/帧；scale 档位 0.025 约 18；0.05 约 11。
'use strict';
const { spawn } = require('child_process'); const fs=require('fs'),path=require('path'),os=require('os');
const ROOT=path.join(__dirname,'..'), EXE=process.env.QF_ELECTRON_BIN||require('electron');
const PORT=9400+Math.floor(Math.random()*40), PROFILE=path.join(os.tmpdir(),'qfs-wc-'+Date.now());
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const child=spawn(EXE,['--no-sandbox','--user-data-dir='+PROFILE,'--remote-debugging-port='+PORT,ROOT],{cwd:ROOT,stdio:'ignore',windowsHide:true});
  let page=null;
  for(let i=0;i<60&&!page;i++){await sleep(200);try{page=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');}catch(_){}}
  if(!page){console.log('NO_PAGE');process.exit(1);}
  const ws=new WebSocket(page.webSocketDebuggerUrl); let id=0; const P=new Map();
  const send=(m,p)=>new Promise((res,rej)=>{const i=++id;P.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));setTimeout(()=>{if(P.has(i)){P.delete(i);rej(new Error('t'));}},20000);});
  ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);if(m.id&&P.has(m.id)){const p=P.get(m.id);P.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}});
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r.exceptionDetails?'EXC':r.result.value;};
  for(let i=0;i<80;i++){ if(await ev(`!!(window.App && document.getElementById('presetWallGrid') && !document.getElementById('splash') && document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length)`)) break; await sleep(100); }
  await sleep(500);
  const r = await ev(`(async () => {
     const g = document.getElementById('presetWallGrid');
     const tiles = [...g.querySelectorAll('.pw-tile')];
     const last = new Map();
     for (const t of tiles) last.set(t, t.style.transform);
     let changes = 0, frames = 0;
     App.stopWallMotion(); App.panWallTo(0, 0);
     await new Promise(r => setTimeout(r, 200));
     const t0 = performance.now();
     await new Promise((done) => {
        const step = () => {
           if (performance.now() - t0 > 2400) { done(); return; }
           frames++;
           App.panWallTo(App._wallPan.x - 18, App._wallPan.y - 6);
           for (const t of tiles) { const v = t.style.transform; if (last.get(t) !== v) { changes++; last.set(t, v); } }
           requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
     });
     return { frames, changes, perFrame: +(changes / frames).toFixed(1) };
  })()`);
  console.log('WRITES ' + JSON.stringify(r));
  ws.close(); child.kill(); try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch(_){}
  process.exit(0);
})().catch(e=>{console.error('FAIL '+(e&&e.message));process.exit(1);});
