// 锐化标定：扫描 (量/半径) 组合，用「高频能量」对齐 LR 导出。
//
// 为什么要扫描而不是直接用 XMP 的 40/0.5：LR 的捕获锐化是在全分辨率上做的
// 反卷积，我们是在烘焙分辨率上做 USM，两者的等效强度不一样，必须实测对齐。
//
// 输出既打印指标，也把每档写进 tools/out/shp_*.jpg，方便肉眼复核。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = path.join(ROOT, 'tools', 'out', 'sh_lr.jpg');
const OUT = path.join(ROOT, 'tools', 'out');
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

// 与 shadow-compare 同款：沙箱里没有 WebGL，三维表用 CPU 三线性复现
const CPU_PASS = `
  window.__cpuPass = function (src, p, w, h, lut, haze) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    if (!(lut && lut.rgba && lut.grid > 1)) return c;
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const G = lut.grid, A = lut.rgba, S = G - 1;
    const size = G * G;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] * S / 255, gg = d[i + 1] * S / 255, b = d[i + 2] * S / 255;
      const r0 = Math.min(S - 1, Math.floor(r)), g0 = Math.min(S - 1, Math.floor(gg)), b0 = Math.min(S - 1, Math.floor(b));
      const fr = r - r0, fg = gg - g0, fb = b - b0;
      let outR = 0, outG = 0, outB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg;
          const wy = wb * wg, y = g0 + dg2;
          for (let dr = 0; dr < 2; dr++) {
            const wr = dr ? fr : 1 - fr;
            const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
            outR += wy * wr * A[idx];
            outG += wy * wr * A[idx + 1];
            outB += wy * wr * A[idx + 2];
          }
        }
      }
      d[i] = outR; d[i + 1] = outG; d[i + 2] = outB;
    }
    g.putImageData(img, 0, 0);
    return c;
  };
  window.QfsColor.usingGL = () => true;
  window.QfsColor.pass = window.__cpuPass;
  true;
`;

// ── 高频能量 ────────────────────────────────────────────────
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function loadRGB(file) {
  const j = jpeg.decode(fs.readFileSync(file), { maxMemoryUsageInMB: 4096 });
  const { width: W, height: H, data } = j;
  const L = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = lum(data[p], data[p + 1], data[p + 2]);
  const lap = new Float32Array(W * H), grad = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, c = L[i];
      lap[i] = Math.abs(4 * c - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]);
      grad[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]);
    }
  }
  return { W, H, L, lap, grad };
}

function hf(e) {
  const { lap, grad, L, W, H } = e;
  const flat = [], edge = [];
  const byL = [[0, 64], [64, 160], [160, 256]].map(() => []);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x, v = lap[i];
      if (grad[i] < 6) flat.push(v);
      else if (grad[i] > 40) edge.push(v);
      const b = L[i] < 64 ? 0 : (L[i] < 160 ? 1 : 2);
      byL[b].push(v);
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  return { flat: mean(flat), edge: mean(edge), byL: byL.map(mean) };
}

const CASES = [
  { tag: 'off', det: { shp: 0 } },
  { tag: 'preset', det: {} },
  { tag: 'half', det: { shp: 20, shr: 0.5, shd: 60, shm: 34 } },
  { tag: 'r10', det: { shp: 40, shr: 1.0, shd: 60, shm: 34 } },
  { tag: 'nomask', det: { shp: 40, shr: 0.5, shd: 60, shm: 0 } },
  { tag: 'd25', det: { shp: 40, shr: 0.5, shd: 25, shm: 34 } }
];

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsShadows)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await w.webContents.executeJavaScript(CPU_PASS);

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const TW = 1400;
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = ${TW}, H = Math.round(${TW} * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    // 无损中转：多一次 JPEG 会平白软掉一截
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/png'); });
    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);

    const mapped = window.AppXmp.mapXmp(${JSON.stringify(xmpText)});
    const base = mapped.patch;
    base.tint = 0;

    const run = async (det, pow) => {
      window.QfsSharpen._lumPow = (pow === undefined ? 0.5 : pow);
      const p = JSON.parse(JSON.stringify(base));
      if (det) p.det = Object.assign({}, p.det, det);
      A.setGrade(p, { replace: true, full: true });
      // 参数完全相同时（只换亮度权重）签名不变会命中缓存，得手动失效
      if (im._grade) { im._grade.canvas = null; im._grade.fullKey = ''; }
      im._gradeCache = null;
      await A.flushRender(); await sleep(200);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(650);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      return cv.toDataURL('image/jpeg', 0.95);
    };
    const shots = {};
    for (const c of ${JSON.stringify(CASES)}) shots[c.tag] = await run(c.det, c.pow);
    // 参照：LR 的 5905 导出用**和我们完全相同**的画布缩图与 JPEG 质量落到 1400。
    // 不这么做的话，参照走面积平均、我们走画布，光重采样就差 18% 边缘能量，
    // 标定出来的锐化量会虚高一大截。
    const lrRaw = new Image();
    await new Promise((r, j) => { lrRaw.onload = r; lrRaw.onerror = j; lrRaw.src = ${JSON.stringify(dataUrl(LR))}; });
    const lc = document.createElement('canvas'); lc.width = W; lc.height = H;
    const lg = lc.getContext('2d'); lg.imageSmoothingQuality = 'high';
    lg.drawImage(lrRaw, 0, 0, W, H);
    return { shots, ref: lc.toDataURL('image/jpeg', 0.95), det: mapped.patch.det, applied: mapped.applied };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);
  if (out.error) { console.log('渲染脚本报错：', out.error); app.quit(); return; }

  console.log('XMP 映射：det =', JSON.stringify(out.det));
  console.log('已应用：', out.applied.join('、'));
  const refPath = path.join(OUT, 'lr_canvas.jpg');
  fs.writeFileSync(refPath, Buffer.from(out.ref.split(',')[1], 'base64'));
  const ref = hf(loadRGB(refPath));
  console.log('\n LR 基准   平地', ref.flat.toFixed(2), ' 边缘', ref.edge.toFixed(2),
    ' 亮度档', ref.byL.map((v) => v.toFixed(1)).join(' / '));
  console.log('\n 档位       平地   /LR    边缘   /LR   亮度档 vs LR');
  for (const c of CASES) {
    const url = out.shots[c.tag];
    if (!url) { console.log(c.tag, '失败'); continue; }
    const f = path.join(OUT, 'shp_' + c.tag + '.jpg');
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    const h = hf(loadRGB(f));
    console.log(' ' + c.tag.padEnd(9)
      + h.flat.toFixed(2).padStart(6) + (h.flat / ref.flat).toFixed(3).padStart(7)
      + h.edge.toFixed(2).padStart(8) + (h.edge / ref.edge).toFixed(3).padStart(7)
      + '   ' + h.byL.map((v, i) => (v / ref.byL[i]).toFixed(2)).join(' / '));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
