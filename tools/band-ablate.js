// 分带敏感性图：把每个色彩 stage 单独关掉，看它在「LR 亮度五带」上各推了多少 RGB。
// 目的：定位「中亮部缺绿、亮部多蓝」到底由哪一级产生 —— 也就是我们相对 LR 的那层
// 品红纱是从哪儿来的。输出 ΔRGB = 关掉该级 − 基准，正数表示该级原本在往下压。
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
    const G = lut.grid, A = lut.rgba, S = G - 1;
    const size = G * G;
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

const TW = 1663; // 与截图对齐后的宽一致，避免缩放差异混进分带统计

const VARIANTS = [
  ['noExp', (p) => { p.exp = 0; }],
  ['noCon', (p) => { p.con = 0; }],
  ['noHi', (p) => { p.hi = 0; }],
  ['noSh', (p) => { p.sh = 0; }],
  ['noWhite', (p) => { p.white = 0; }],
  ['noBlack', (p) => { p.black = 0; }],
  ['noSat', (p) => { p.sat = 0; }],
  ['noVib', (p) => { p.vib = 0; }],
  ['noCg', (p) => { p.cg = null; }],
  ['noMix', (p) => { p.mix = null; }],
  ['noCal', (p) => { p.cal = null; }],
  ['noCurve', (p) => { p.curve = null; }],
  ['noParam', (p) => { p.param = null; }],
  ['noTemp', (p) => { p.temp = 0; }],
  ['noTint', (p) => { p.tint = 0; }],
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
  // 页面里有 CSP，不能 eval：把每个变体写成函数字面量直接塞进待执行源码
  const variantSrc = VARIANTS.map(([k, fn]) => '["' + k + '", ' + fn.toString() + ']').join(',\n      ');
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
    const VARIANT_LIST = [
      ${variantSrc}
    ];
    const run = async (mut) => {
      const p = JSON.parse(JSON.stringify(base));
      if (mut) mut(p);
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(220);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(600);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height;
      const keep = new Uint8Array(n * 3);
      // 抽稀：每 2 像素取一个，够统计
      for (let i = 0; i < n; i++) { keep[i*3] = d[i*4]; keep[i*3+1] = d[i*4+1]; keep[i*3+2] = d[i*4+2]; }
      return { w: cv.width, h: cv.height, d: Array.from(keep) };
    };
    const r = { base: await run(null) };
    for (const [k, fn] of VARIANT_LIST) r[k] = await run(fn);
    return { r, base: { temp: base.temp, tint: base.tint, cg: base.cg, cal: base.cal,
      hi: base.hi, sh: base.sh, white: base.white, black: base.black, sat: base.sat, vib: base.vib } };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('预设：', JSON.stringify(out.base));

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
  const BANDS = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]];
  const stat = (s) => {
    const bands = BANDS.map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
    let sa = 0, sb = 0, sh = 0, sn = 0, C = 0, n = 0;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x += 2) {
        const p = (y * s.w + x) * 3;
        const R = s.d[p], G = s.d[p + 1], B = s.d[p + 2];
        const t = lab(R, G, B); n++;
        const bi = BANDS.findIndex(([lo, hi]) => t[0] >= lo && t[0] < hi);
        if (bi >= 0) { const q = bands[bi]; q.n++; q.r += R; q.g += G; q.b += B; }
        const c = Math.hypot(t[1], t[2]); C += c;
        if (t[0] > 20 && t[0] < 244 && c > 14) {
          let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
          if (h >= 65 && h < 105) { sa += t[1]; sb += t[2]; sh += h; sn++; }
        }
      }
    }
    return { bands: bands.map((q) => (q.n ? [q.r / q.n, q.g / q.n, q.b / q.n, q.n] : null)), a: sa / sn, b: sb / sn, h: sh / sn, C: C / n, n };
  };

  // LR 截图同带均值（作为"目标"）
  let target = null;
  try {
    const j = jpeg.decode(fs.readFileSync(path.join(OUT, 'shot_lr.jpg')), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const s = { w: j.width, h: j.height, d: j.data };
    const bands = BANDS.map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x += 2) {
        const p = (y * s.w + x) * 4;
        const t = lab(s.d[p], s.d[p + 1], s.d[p + 2]);
        const bi = BANDS.findIndex(([lo, hi]) => t[0] >= lo && t[0] < hi);
        if (bi >= 0) { const q = bands[bi]; q.n++; q.r += s.d[p]; q.g += s.d[p + 1]; q.b += s.d[p + 2]; }
      }
    }
    target = bands.map((q) => (q.n ? [q.r / q.n, q.g / q.n, q.b / q.n] : null));
  } catch (e) { console.log('（没读到 shot_lr.jpg，跳过目标列）'); }

  const base = stat(out.r.base);
  console.log('\n基准分带 RGB（我们）  ' + base.bands.map((q, i) => 'L' + BANDS[i][0] + ':' + (q ? q.slice(0, 3).map((v) => v.toFixed(1)).join('/') : '-')).join('  '));
  if (target) {
    console.log('目标分带 RGB（LR 截图）' + target.map((q, i) => 'L' + BANDS[i][0] + ':' + (q ? q.map((v) => v.toFixed(1)).join('/') : '-')).join('  '));
    console.log('残差（我们−LR）        ' + base.bands.map((q, i) => 'L' + BANDS[i][0] + ':' + (q && target[i] ? q.slice(0, 3).map((v, k) => (v - target[i][k] >= 0 ? '+' : '') + (v - target[i][k]).toFixed(1)).join(',') : '-')).join('  '));
  }

  console.log('\n各级贡献（关掉该级 − 基准；正数=该级原本在把该通道压低）');
  console.log('变体       ΔR/ΔG/ΔB 按亮度带（L0-48 | 48-96 | 96-144 | 144-192 | 192+）        黄带Δh  黄带ΔC');
  for (const [k] of VARIANTS) {
    if (!out.r[k]) continue;
    const v = stat(out.r[k]);
    const cells = v.bands.map((q, i) => {
      if (!q || !base.bands[i]) return '-';
      return [0, 1, 2].map((j) => { const d = q[j] - base.bands[i][j]; return (d >= 0 ? '+' : '') + d.toFixed(1); }).join(',');
    });
    console.log(' ' + k.padEnd(9) + cells.map((c) => c.padEnd(20)).join('') +
      (v.h - base.h >= 0 ? '+' : '') + (v.h - base.h).toFixed(1) + '°'.padStart(3) +
      '  ' + (v.C - base.C >= 0 ? '+' : '') + (v.C - base.C).toFixed(1));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
