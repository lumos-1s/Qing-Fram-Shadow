// 扫描 高光/阴影 档位，找到最接近 LR 亮度分布的组合
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-tables', () => {
  const raw = fs.readFileSync(ACR);
  const planes = zlib.inflateSync(raw.slice(10));
  return {
    size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
    data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
  };
});
ipcMain.handle('get-prefs', () => ({}));

// LR 目标亮度分位
const jpeg = require('jpeg-js');
function lvOf(f) {
  const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const W = 700, H = Math.round(700 * img.height / img.width);
  const d = img.data, iw = img.width, ih = img.height, L = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
    L.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  }
  L.sort((a, b) => a - b);
  const q = (p) => L[Math.floor(L.length * p)] || 0;
  return [0.05, 0.25, 0.5, 0.75, 0.95].map(q);
}
const LR_LV = lvOf(LR);

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp)')) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    await A.flushRender(); await sleep(400);
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;

    const lvOf = (cv) => {
      const W = 700, H = Math.round(700 * cv.height / cv.width);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.drawImage(cv, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data; const L = [];
      for (let i = 0; i < d.length; i += 4) L.push(0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]);
      L.sort((a, b) => a - b);
      return [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => Math.round(L[Math.floor(L.length * p)] || 0));
    };

    const run = async (patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender(); await sleep(500);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(900);
      const cv = im._grade && im._grade.canvas;
      return cv ? lvOf(cv) : null;
    };

    const res = [];
    for (const hi of [-100, -80, -60, -40, -20, 0]) {
      for (const sh of [-30, -20, -10, 0]) {
        const p = JSON.parse(JSON.stringify(base));
        p.hi = hi; p.sh = sh;
        res.push({ hi, sh, lv: await run(p) });
      }
    }
    return res;
  })()`);

  const dist = (lv) => lv.reduce((s, v, i) => s + Math.abs(v - LR_LV[i]), 0);
  out.sort((a, b) => dist(a.lv) - dist(b.lv));
  console.log('LR 目标亮度:', LR_LV.map(Math.round).join('/'), '\n');
  console.log('排名  高光  阴影   亮度 5/25/50/75/95          总偏差');
  out.slice(0, 10).forEach((r, i) => {
    console.log(String(i + 1).padStart(3), String(r.hi).padStart(6), String(r.sh).padStart(4), '  ', r.lv.join('/').padEnd(24), dist(r.lv).toFixed(0).padStart(5));
  });
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
