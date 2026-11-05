// 色调链顶端响应：把实测对角线 LUT 打出来，看它在哪个输入就已经到 255。
// 高光冲白 = 曲线提前压到 255（之后无论怎么调都是纯白），与三维彩度无关。
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
    for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);
    const mapped = window.AppXmp.mapXmp(${JSON.stringify(xmpText)});
    const p = mapped.patch;
    const bright = window.QfsAcr.measureBrightness(raw);
    const F = window.QfsAcr.toneStages({
      exp: p.exp || 0, temp: p.temp || 0, tint: p.tint || 0,
      con: p.con || 0, hi: p.hi || 0, sh: p.sh || 0,
      white: p.white || 0, black: p.black || 0
    }, bright);
    const C = window.QfsCurve;
    const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
    const pick = [0, 32, 64, 96, 128, 160, 180, 200, 210, 220, 228, 236, 244, 250, 255];
    const rows = pick.map((i) => [i, Math.round(F.r[i] * 255), Math.round(F.g[i] * 255), Math.round(F.b[i] * 255),
      cl ? Math.round((cl.r[i] <= 1 ? cl.r[i] * 255 : cl.r[i])) : null]);
    return {
      patch: { exp: p.exp, temp: p.temp, tint: p.tint, con: p.con, hi: p.hi, white: p.white, black: p.black, sh: p.sh },
      bright, rows,
      curvePts: p.curve ? p.curve.length : 0,
      lutGrid: window.QfsAcr.grid,
    };
  })()`);

  console.log('参数', JSON.stringify(out.patch), ' 图片亮度测度', JSON.stringify(out.bright));
  console.log('曲线点数', out.curvePts);
  console.log('\n  in   R    G    B   | 点曲线R');
  for (const r of out.rows) {
    console.log(String(r[0]).padStart(4), String(r[1]).padStart(4), String(r[2]).padStart(4), String(r[3]).padStart(4),
      '  |', r[4] == null ? '—' : String(r[4]).padStart(4));
  }
  // 到 255 的输入点
  for (const [nm, idx] of [['R', 1], ['G', 2], ['B', 3]]) {
    let first = null;
    for (const r of out.rows) if (r[idx] >= 255) { first = r[0]; break; }
    console.log(nm + ' 首次到 255 的输入：' + (first == null ? '未到（255 输入仍未满）' : first));
  }
  app.quit();
});
