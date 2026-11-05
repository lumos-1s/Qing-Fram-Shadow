// 全分辨率渲染一张，落盘成 full_ours.jpg（与 LR 导出同尺寸，比裁切才公平）。
// 预览只有 1740 宽，放大到 520 的裁切会糊，看起来「发灰」，那是重采样的错觉。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const OUT = path.join(__dirname, 'out');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-tables', () => {
  const raw = fs.readFileSync(ACR);
  const planes = zlib.inflateSync(raw.slice(10));
  return {
    size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
    data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
  };
});
ipcMain.handle('load-acr-shadows', () => {
  const raw = fs.readFileSync(SHD);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsAcr)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const xmpText = fs.readFileSync(XMP, 'utf8');
  const OVERRIDES = process.argv.slice(3);
  const OUTNAME = process.env.OUTNAME || 'full_ours.jpg';
  const out = await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const A = window.App;
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: raw, w: raw.naturalWidth, h: raw.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);
    // NOBAL=1 关掉引擎级的两级定标（通道平衡 + 高光收口），用来量它们的影响
    if (${process.env.NOBAL ? 'true' : 'false'}) { window.QfsAcr._noBalance = true; }
    const p = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const ov = ${JSON.stringify(OVERRIDES)};
    for (const kv of ov) {
      const i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1);
      if (k.indexOf('det.') === 0) { p.det = p.det || {}; p.det[k.slice(4)] = Number(v); }
      else if (k) p[k] = Number(v);
    }
    A.setGrade(p, { replace: true, full: true });
    await A.flushRender(); await sleep(200);
    if (window.ensureFullGrade) window.ensureFullGrade(im);
    await A.flushRender(); await sleep(900);
    const cv = im._grade && im._grade.canvas;
    if (!cv) return { error: '画布没生成' };
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    return { w: cv.width, h: cv.height, data: Array.from(d) };
  })()`);
  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  const rgba = Buffer.from(out.data);
  fs.writeFileSync(path.join(OUT, OUTNAME), jpeg.encode({ data: rgba, width: out.w, height: out.h }, 96).data);
  console.log(OUTNAME, out.w + 'x' + out.h);
  app.quit();
});
