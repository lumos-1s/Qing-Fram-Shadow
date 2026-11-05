// 跑真实导出管线，把结果写到磁盘，用于和用户手上的导出图逐像素比对
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const OUT = 'C:/Users/lumos/Desktop/web-app/tools/out/_probe_export.jpg';

const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

app.disableHardwareAcceleration();

ipcMain.handle('pick-export-location', () => ({ mode: 'file', filePath: OUT, token: 'probe' }));
ipcMain.handle('write-export-files', (_e, payload) => {
  const f = payload && payload.files && payload.files[0];
  if (!f) return { ok: 0, fail: 1 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = f.bytes ? Buffer.from(f.bytes) : Buffer.from(String(f.data || ''), 'base64');
  fs.writeFileSync(OUT, buf);
  console.log('写入', OUT, buf.length, 'bytes');
  return { ok: 1, fail: 0 };
});
ipcMain.handle('on-export-progress', () => {});

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 160; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsColor)')) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const info = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await A.flushRender(); await sleep(400);

    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    const mapped = window.AppXmp.mapXmp(${JSON.stringify(xmpText)});
    A.setGrade(mapped.patch, { replace: true, full: true });
    await A.flushRender(); await sleep(1500);

    // 导出设置：JPEG / 质量 92 / 原图尺寸
    if (A.dom.selFormat) A.dom.selFormat.value = 'jpeg';
    if (A.dom.slExportQuality) A.dom.slExportQuality.value = '92';
    if (A.dom.selExportSize) A.dom.selExportSize.value = '0';

    let msg = ''; const _ss = A.setStatus.bind(A); A.setStatus = (m) => { msg = String(m); return _ss(m); };
    let err = null;
    try { await A.exportImage(); } catch (e) { err = String(e && e.stack || e); }
    await sleep(500);
    const cv = A.dom.canvas;
    const g2 = cv.getContext('2d');
    const st = (function(){ const W=900, H=Math.round(900*cv.height/cv.width); const c=document.createElement('canvas'); c.width=W;c.height=H; const g=c.getContext('2d'); g.drawImage(cv,0,0,W,H); const d=g.getImageData(0,0,W,H).data; let r=0,gg=0,b=0,n=0,sa=0; const L=[]; for(let i=0;i<d.length;i+=4){ const R=d[i],G=d[i+1],B=d[i+2]; r+=R;gg+=G;b+=B;n++; const mx=Math.max(R,G,B),mn=Math.min(R,G,B); sa+= mx>0?(mx-mn)/mx:0; L.push(0.2126*R+0.7152*G+0.0722*B);} L.sort((a,b2)=>a-b2); const q=(p)=>Math.round(L[Math.floor(L.length*p)]||0); return {rgb:[Math.round(r/n),Math.round(gg/n),Math.round(b/n)], lv:[q(0.05),q(0.25),q(0.5),q(0.75),q(0.95)], sat:+((sa/n)*100).toFixed(1)}; })();
    const small=document.createElement('canvas'); small.width=900; small.height=Math.round(900*cv.height/cv.width); small.getContext('2d').drawImage(cv,0,0,small.width,small.height); const url=small.toDataURL('image/jpeg',0.95); return { err, msg, w: cv.width, h: cv.height, stat: st, url };
  })()`);

  console.log('导出返回:', JSON.stringify(info));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
