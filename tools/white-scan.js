// 高光自适应档（bright.hi）扫描：同一张图、同一套参数，只改「高光 stage 认为这张图
// 有多亮」这个行索引，看顶端与中调分别怎么变。用来判断高光压缩是不是选错了档。
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

const LR = (() => {
  const j = jpeg.decode(fs.readFileSync('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
})();
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const N = 240, pts = [];
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const u = (i + 0.5) / N, v = (j + 0.5) / N;
  const x = Math.floor(u * LR.w), y = Math.floor(v * LR.h), rad = 4;
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -rad; dy <= rad; dy += 2) for (let dx = -rad; dx <= rad; dx += 2) {
    const p = ((y + dy) * LR.w + (x + dx)) * 4;
    r += LR.d[p]; g += LR.d[p + 1]; b += LR.d[p + 2]; n++;
  }
  pts.push({ u, v, Y: 0.2126 * s2l(r / n) + 0.7152 * s2l(g / n) + 0.0722 * s2l(b / n), lr: [r / n, g / n, b / n] });
}
pts.sort((a, b) => b.Y - a.Y);
const TOP = pts.slice(0, Math.round(pts.length * 0.06));
const MID = pts.slice(Math.round(pts.length * 0.25), Math.round(pts.length * 0.55));

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
  const coords = [...TOP, ...MID].map((p) => [p.u, p.v]);

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
    const p = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const base = window.QfsAcr.measureBrightness(raw);
    const C = window.QfsCurve;
    const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;

    const sc = document.createElement('canvas');
    sc.width = raw.naturalWidth; sc.height = raw.naturalHeight;
    const scg = sc.getContext('2d', { willReadFrequently: true });
    scg.drawImage(raw, 0, 0);
    const S = scg.getImageData(0, 0, sc.width, sc.height).data;
    const SW = sc.width, SH = sc.height;
    const srcAt = [];
    for (const uv of ${JSON.stringify(coords)}) {
      const x = Math.min(SW - 1, Math.floor(uv[0] * SW)), y = Math.min(SH - 1, Math.floor(uv[1] * SH));
      const q = (y * SW + x) * 4;
      srcAt.push([S[q], S[q + 1], S[q + 2]]);
    }
    const tbl = (arr, v) => {
      const x = Math.min(255, Math.max(0, v)), i0 = Math.min(254, Math.floor(x)), f = x - i0;
      return (arr[i0] * (1 - f) + arr[i0 + 1] * f) * 255;
    };
    const sample3 = (lut, r, g, b) => {
      const G = lut.grid, SG = G - 1, AT = lut.rgba;
      const x = Math.min(SG, Math.max(0, r) * SG / 255), y = Math.min(SG, Math.max(0, g) * SG / 255), z = Math.min(SG, Math.max(0, b) * SG / 255);
      const i0 = Math.min(SG - 1, Math.floor(x)), j0 = Math.min(SG - 1, Math.floor(y)), k0 = Math.min(SG - 1, Math.floor(z));
      const fx = x - i0, fy = y - j0, fz = z - k0;
      const at = (ri, gi, bi) => ((gi * G + bi) * G + ri) * 4;
      const o = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const c00 = AT[at(i0, j0, k0) + ch] * (1 - fx) + AT[at(i0 + 1, j0, k0) + ch] * fx;
        const c10 = AT[at(i0, j0 + 1, k0) + ch] * (1 - fx) + AT[at(i0 + 1, j0 + 1, k0) + ch] * fx;
        const c01 = AT[at(i0, j0, k0 + 1) + ch] * (1 - fx) + AT[at(i0 + 1, j0, k0 + 1) + ch] * fx;
        const c11 = AT[at(i0, j0 + 1, k0 + 1) + ch] * (1 - fx) + AT[at(i0 + 1, j0 + 1, k0 + 1) + ch] * fx;
        const c0 = c00 * (1 - fy) + c10 * fy, c1 = c01 * (1 - fy) + c11 * fy;
        o[ch] = c0 * (1 - fz) + c1 * fz;
      }
      return o;
    };
    const runW = (w) => {
      const bright = base;
      const p2 = Object.assign({}, p, { white: w });
      const F = window.QfsAcr.toneStages({
        exp: p2.exp || 0, temp: p2.temp || 0, tint: p2.tint || 0,
        con: p2.con || 0, hi: p2.hi || 0, sh: p2.sh || 0, white: p2.white || 0, black: p2.black || 0
      }, bright);
      const lut = window.QfsAcr.colorLut(p2, 33, bright);
      const acc = [];
      for (const s of srcAt) {
        const t1 = [tbl(F.r, s[0]), tbl(F.g, s[1]), tbl(F.b, s[2])];
        const t2 = cl ? [C.sampleLut(cl.r, t1[0] / 255) * 255, C.sampleLut(cl.g, t1[1] / 255) * 255, C.sampleLut(cl.b, t1[2] / 255) * 255] : t1;
        acc.push(sample3(lut, t2[0], t2[1], t2[2]));
      }
      return acc;
    };
    const rows = [23, 15, 8, 0, -10, -20];
    const res = {};
    for (const r of rows) res[r] = runW(r);
    return { res, base };
  })()`);

  const meanOf = (arr, a, b) => [0, 1, 2].map((c) => { let s = 0; for (let i = a; i < b; i++) s += arr[i][c]; return s / (b - a); });
  const lrTop = [0,1,2].map((c)=>TOP.reduce((s,p)=>s+p.lr[c],0)/TOP.length);
  const lrMid = [0,1,2].map((c)=>MID.reduce((s,p)=>s+p.lr[c],0)/MID.length);
  const srcTop = [0, 1, 2].map((c) => TOP.reduce((s, p) => s + p.lr[c], 0) / TOP.length);
  console.log('亮度测度 base =', JSON.stringify(out.base));
  console.log('LR      顶 6% ' + lrTop.map((v) => v.toFixed(1).padStart(6)).join(' ') +
    '   中调 ' + lrMid.map((v) => v.toFixed(1).padStart(6)).join(' '));
  console.log('源图    顶 6% ' + srcTop.map((v) => v.toFixed(1).padStart(6)).join(' '));
  console.log('');
  console.log(' white  顶6% R      G      B   | 与 LR 差          | 中调差');
  for (const r of Object.keys(out.res)) {
    const a = out.res[r];
    const t = meanOf(a, 0, TOP.length), m = meanOf(a, TOP.length, TOP.length + MID.length);
    const d = t.map((v, i) => v - lrTop[i]);
    const dm = m.map((v, i) => v - lrMid[i]);
    console.log(String(r).padStart(4) + '  ' + t.map((v) => v.toFixed(1).padStart(6)).join(' ') +
      '  | ' + d.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).join(',').padEnd(22) +
      ' | ' + dm.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).join(','));
  }
  app.quit();
});
