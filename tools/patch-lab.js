// 定点裁片对照：把我们按 tint=0/38/50 各渲一张，然后在**固定的归一化坐标**上取
// 同一块区域，与 LR 的 tint=0 / tint=50 导出逐块比 Lab。
// 好处：区域是固定的，不会被「按色相自选像素」带来的偏差骗到。
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

const CPU_PASS = `
  window.__cpuPass = function (src, p, w, h, lut, haze) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    if (!(lut && lut.rgba && lut.grid > 1)) return c;
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const G = lut.grid, A = lut.rgba, S = G - 1, size = G * G;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] * S / 255, gg = d[i + 1] * S / 255, b = d[i + 2] * S / 255;
      const r0 = Math.min(S - 1, Math.floor(r)), g0 = Math.min(S - 1, Math.floor(gg)), b0 = Math.min(S - 1, Math.floor(b));
      const fr = r - r0, fg = gg - g0, fb = b - b0;
      let oR = 0, oG = 0, oB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg;
          const wy = wb * wg, y = g0 + dg2;
          for (let dr = 0; dr < 2; dr++) {
            const wr = dr ? fr : 1 - fr;
            const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
            oR += wy * wr * A[idx]; oG += wy * wr * A[idx + 1]; oB += wy * wr * A[idx + 2];
          }
        }
      }
      d[i] = oR; d[i + 1] = oG; d[i + 2] = oB;
    }
    g.putImageData(img, 0, 0);
    return c;
  };
  window.QfsColor.usingGL = () => true;
  window.QfsColor.pass = window.__cpuPass;
  true;
`;

const TW = 1740; // 与 lr 导出等比，够细又不慢

const PATCHES = [
  ['黄叶(上中)', 0.40, 0.055, 0.14, 0.075],
  ['黄叶(左下)', 0.24, 0.115, 0.12, 0.07],
  ['墙(左)', 0.10, 0.34, 0.10, 0.07],
  ['天空/隙光', 0.45, 0.205, 0.12, 0.05],
  ['路面', 0.44, 0.80, 0.12, 0.06],
  ['暗部树叶', 0.18, 0.72, 0.10, 0.06],
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
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/png'); });
    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const run = async (tint) => {
      const p = JSON.parse(JSON.stringify(base));
      p.tint = tint;
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(200);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(550);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height, keep = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { keep[i*3] = d[i*4]; keep[i*3+1] = d[i*4+1]; keep[i*3+2] = d[i*4+2]; }
      return { w: cv.width, h: cv.height, d: Array.from(keep) };
    };
    return { t0: await run(0), t38: await run(38), t50: await run(50) };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }

  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lab = (r, g, b) => {
    const R = f(r), G = f(g), B2 = f(b);
    let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
    let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
    const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    X = t(X); Z = t(Z); const Y2 = t(Y);
    return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
  };
  const patchMean = (im, nx, ny, nw, nh, ch = 3) => {
    const x0 = Math.round(nx * im.w), y0 = Math.round(ny * im.h);
    const x1 = Math.round((nx + nw) * im.w), y1 = Math.round((ny + nh) * im.h);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * im.w + x) * ch;
        r += im.d[p]; g += im.d[p + 1]; b += im.d[p + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };

  const loadJ = (fp) => {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
  };
  const LR0 = loadJ('C:/Users/lumos/Desktop/未命名导出/tint=0.jpg');
  const LR50 = loadJ('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');

  // 落盘三张渲染，供后续用纯 node 反复做增益拟合（不必再起 Electron）
  const saveRGB = (name, s) => {
    const buf = Buffer.alloc(s.w * s.h * 3);
    for (let i = 0; i < s.w * s.h; i++) { buf[i * 3] = s.d[i * 3]; buf[i * 3 + 1] = s.d[i * 3 + 1]; buf[i * 3 + 2] = s.d[i * 3 + 2]; }
    const g = { w: s.w, h: s.h, d: buf };
    // 用 PNG 太慢，直接以 ppm 落盘（无损、无依赖）
    const head = Buffer.from('P6\n' + s.w + ' ' + s.h + '\n255\n', 'ascii');
    fs.writeFileSync(path.join(OUT, name), Buffer.concat([head, g.d]));
    console.log('落盘', name);
  };
  if (out.t0) saveRGB('ours_t0.ppm', out.t0);
  if (out.t38) saveRGB('ours_t38.ppm', out.t38);
  if (out.t50) saveRGB('ours_t50.ppm', out.t50);

  const rows = [
    ['我们t0 vs LR0', out.t0, LR0],
    ['我们t50 vs LR50', out.t50, LR50],
    ['我们t38 vs LR50', out.t38, LR50],
  ];
  for (const [name, ours, lr] of rows) {
    console.log('\n' + name + '   （ΔL / Δa* / Δb* / ΔC* / Δh°；正=我们更大）');
    for (const [pn, nx, ny, nw, nh] of PATCHES) {
      const a = patchMean(lr, nx, ny, nw, nh, 4);
      const b = patchMean(ours, nx, ny, nw, nh, 3);
      const la = lab(a[0], a[1], a[2]), lb = lab(b[0], b[1], b[2]);
      const Ca = Math.hypot(la[1], la[2]), Cb = Math.hypot(lb[1], lb[2]);
      let ha = Math.atan2(la[2], la[1]) * 180 / Math.PI, hb = Math.atan2(lb[2], lb[1]) * 180 / Math.PI;
      if (ha < 0) ha += 360; if (hb < 0) hb += 360;
      let dh = hb - ha; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
      console.log(' ' + pn.padEnd(11) + 'LR ' + a.map((v) => v.toFixed(0)).join('/').padEnd(12) +
        '我们 ' + b.map((v) => v.toFixed(0)).join('/').padEnd(12) +
        'ΔL ' + (lb[0] - la[0] >= 0 ? '+' : '') + (lb[0] - la[0]).toFixed(1) +
        '  Δa ' + (lb[1] - la[1] >= 0 ? '+' : '') + (lb[1] - la[1]).toFixed(1) +
        '  Δb ' + (lb[2] - la[2] >= 0 ? '+' : '') + (lb[2] - la[2]).toFixed(1) +
        '  ΔC ' + (Cb - Ca >= 0 ? '+' : '') + (Cb - Ca).toFixed(1) +
        '  Δh ' + (dh >= 0 ? '+' : '') + dh.toFixed(1) + '°');
    }
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
