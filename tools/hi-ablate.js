// 高光里到底是谁把 B 抬起来的：逐个 3D stage 关掉，只看最亮 6% 的均值。
// 关掉的是 colorLut 的输入参数，不是渲染链路，所以能精确归因到某一个 stage。
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
const N = 320, pts = [];
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const u = (i + 0.5) / N, v = (j + 0.5) / N;
  const x = Math.floor(u * LR.w), y = Math.floor(v * LR.h), rad = Math.max(1, Math.round(LR.w / 1740));
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const p = ((y + dy) * LR.w + (x + dx)) * 4;
    r += LR.d[p]; g += LR.d[p + 1]; b += LR.d[p + 2]; n++;
  }
  pts.push({ u, v, Y: 0.2126 * s2l(r / n) + 0.7152 * s2l(g / n) + 0.0722 * s2l(b / n), lr: [r / n, g / n, b / n] });
}
pts.sort((a, b) => b.Y - a.Y);
const TOP = pts.slice(0, Math.round(pts.length * 0.06));

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
  const coords = TOP.map((p) => [p.u, p.v]);

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
    const bright = window.QfsAcr.measureBrightness(raw);
    const C = window.QfsCurve;
    const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
    const F = window.QfsAcr.toneStages({
      exp: p.exp || 0, temp: p.temp || 0, tint: p.tint || 0,
      con: p.con || 0, hi: p.hi || 0, sh: p.sh || 0,
      white: p.white || 0, black: p.black || 0
    }, bright);

    const sc = document.createElement('canvas');
    sc.width = raw.naturalWidth; sc.height = raw.naturalHeight;
    const scg = sc.getContext('2d', { willReadFrequently: true });
    scg.drawImage(raw, 0, 0);
    const S = scg.getImageData(0, 0, sc.width, sc.height).data;
    const SW = sc.width, SH = sc.height;

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

    // 先把每个点的「过完色调+曲线」的值取出来（这一步与 stage 无关）
    const pre = [];
    for (const uv of ${JSON.stringify(coords)}) {
      const x = Math.min(SW - 1, Math.floor(uv[0] * SW)), y = Math.min(SH - 1, Math.floor(uv[1] * SH));
      const q = (y * SW + x) * 4;
      const src = [S[q], S[q + 1], S[q + 2]];
      const t1 = [tbl(F.r, src[0]), tbl(F.g, src[1]), tbl(F.b, src[2])];
      const t2 = cl ? [C.sampleLut(cl.r, t1[0] / 255) * 255, C.sampleLut(cl.g, t1[1] / 255) * 255, C.sampleLut(cl.b, t1[2] / 255) * 255] : t1;
      pre.push(t2);
    }

    const variant = (mut, label) => {
      const q = JSON.parse(JSON.stringify(p));
      mut(q);
      const lut = window.QfsAcr.colorLut(q, 33, bright);
      if (!lut) return { label, mean: null };
      let r = 0, g = 0, b = 0, clip = 0;
      for (const t of pre) {
        const o = sample3(lut, t[0], t[1], t[2]);
        r += o[0]; g += o[1]; b += o[2];
        if (Math.max(o[0], o[1], o[2]) >= 254.5) clip++;
      }
      const n = pre.length;
      return { label, mean: [r / n, g / n, b / n], clip: clip / n * 100 };
    };

    const keepCG = p.cg, keepCal = p.cal, keepMix = p.mix;
    const res = [
      variant(() => {}, '全部'),
      variant((q) => { q.cg = null; }, '无颜色分级'),
      variant((q) => { q.cal = null; }, '无校准'),
      variant((q) => { q.sat = 0; }, '无饱和'),
      variant((q) => { q.vib = 0; }, '无自然饱和'),
      variant((q) => { q.mix = null; }, '无混色器'),
      variant((q) => { q.cg = null; q.cal = null; q.mix = null; q.sat = 0; q.vib = 0; }, '只留色调补偿 pre'),
    ];
    return { res, patch: p, bright };
  })()`);

  const lrMean = [0, 1, 2].map((c) => TOP.reduce((s, p) => s + p.lr[c], 0) / TOP.length);
  console.log('参数', JSON.stringify(out.patch, (k, v) => (k === 'curve' ? '…' : v)).slice(0, 400));
  console.log('\n最亮 6% 均值（' + TOP.length + ' 点）');
  console.log('  ' + 'LR 导出'.padEnd(16) + [0, 1, 2].map((c) => lrMean[c].toFixed(1).padStart(6)).join(' '));
  for (const r of out.res) {
    if (!r.mean) { console.log('  ' + r.label.padEnd(16) + '（无 3D 表）'); continue; }
    const d = r.mean.map((v, i) => v - lrMean[i]);
    console.log('  ' + r.label.padEnd(16) + r.mean.map((v) => v.toFixed(1).padStart(6)).join(' ') +
      '   与 LR 差 ' + d.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1)).join(',') + '  撞顶 ' + r.clip.toFixed(0) + '%');
  }
  app.quit();
});
