// 阶梯拟合：用「LR 自己的导出」当参照（同图、同预设、同 tint），只比统计量，
// 不涉及几何对齐。目的：找出哪一个旋钮能把「黄叶的彩度」补回来，而不动其他色相。
//
// 参照（tint=0）：LR a* 3.3  b* 33.5  L* 52.0  C* 34.1
// 参照（tint=50）：LR a* 5.3 b* 32.5  L* 52.6  C* 33.6
// 我们（tint=0）：a* 3.1 b* 30.4 L* 51.2 C* 30.6 → 缺 3.1 b*、3.5 C*
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

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

const TW = 1400;

// 每个变体：名称 + (patch) => void。目标 tint 见下。
const VARIANTS = [
  ['基准', () => {}],
  ['cal×0.5', (p) => { for (const k in p.cal) p.cal[k] = Math.round(p.cal[k] * 0.5); }],
  ['cal×1.5', (p) => { for (const k in p.cal) p.cal[k] = Math.round(p.cal[k] * 1.5); }],
  ['cal×2', (p) => { for (const k in p.cal) p.cal[k] = Math.round(p.cal[k] * 2); }],
  ['mixSat×0.5', (p) => { for (const k in p.mix) p.mix[k].s = Math.round(p.mix[k].s * 0.5); }],
  ['mixSat×0.75', (p) => { for (const k in p.mix) p.mix[k].s = Math.round(p.mix[k].s * 0.75); }],
  ['mixLum×0.6', (p) => { for (const k in p.mix) p.mix[k].l = Math.round(p.mix[k].l * 0.6); }],
  ['sat+6', (p) => { p.sat = (p.sat || 0) + 6; }],
  ['vib+12', (p) => { p.vib = (p.vib || 0) + 12; }],
  ['sat+4/vib+8', (p) => { p.sat = (p.sat || 0) + 4; p.vib = (p.vib || 0) + 8; }],
  ['cg.high×0', (p) => { if (p.cg) p.cg.high = { h: 0, s: 0, l: 0 }; }],
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
    const LIST = [${variantSrc}];
    const run = async (fn, tint, temp) => {
      const p = JSON.parse(JSON.stringify(base));
      if (tint !== undefined) p.tint = tint;
      if (temp !== undefined) p.temp = temp;
      if (fn) fn(p);
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
    const r = {};
    for (const [k, fn] of LIST) r[k] = await run(fn);
    // 额外：tint=0 / tint=50 基准，供与 LR 阶梯直接对比
    r['@tint0'] = await run(null, 0);
    r['@tint50'] = await run(null, 50);
    return { r };
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
  const stat = (s) => {
    let ya = 0, yb = 0, yL = 0, yC = 0, yn = 0, C = 0, n = 0, sr = 0, sg = 0, sb = 0;
    const sec = new Map(); // 色相扇区彩度（每 30°）
    for (let y = 0; y < s.h; y += 2) {
      for (let x = 0; x < s.w; x += 2) {
        const p = (y * s.w + x) * 3;
        const R = s.d[p], G = s.d[p + 1], B = s.d[p + 2];
        const t = lab(R, G, B); n++; sr += R; sg += G; sb += B;
        const c = Math.hypot(t[1], t[2]); C += c;
        if (t[0] > 20 && t[0] < 96 && c > 14) {
          let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
          if (h >= 65 && h < 105) { ya += t[1]; yb += t[2]; yL += t[0]; yC += c; yn++; }
        }
        if (t[0] > 20 && t[0] < 96 && c > 10) {
          let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
          const sec2 = Math.floor(h / 30) * 30;
          const q = sec.get(sec2) || { c: 0, n: 0 };
          q.c += c; q.n++; sec.set(sec2, q);
        }
      }
    }
    const secOut = {};
    for (const [k, v] of sec) if (v.n > n * 0.01) secOut[k] = v.c / v.n;
    return { rgb: [sr / n, sg / n, sb / n], C: C / n, y: { a: ya / yn, b: yb / yn, L: yL / yn, C: yC / yn, n: yn / n }, sec: secOut };
  };

  const LR0 = { a: 3.3, b: 33.5, L: 52.0, C: 34.1, rgb: [122.8, 115.0, 70.6] };
  const LR50 = { a: 5.3, b: 32.5, L: 52.6, C: 33.6, rgb: [132.7, 112.9, 84.7] };
  const b0 = stat(out.r['@tint0']);
  const b50 = stat(out.r['@tint50']);
  console.log('参照 LR tint=0 ：', 'a* ' + LR0.a, 'b* ' + LR0.b, 'L* ' + LR0.L, 'C* ' + LR0.C);
  console.log('我们 tint=0    ：', 'a* ' + b0.y.a.toFixed(1), 'b* ' + b0.y.b.toFixed(1), 'L* ' + b0.y.L.toFixed(1), 'C* ' + b0.y.C.toFixed(1),
    ' → 差 a ' + (b0.y.a - LR0.a).toFixed(1) + ' / b ' + (b0.y.b - LR0.b).toFixed(1) + ' / C ' + (b0.y.C - LR0.C).toFixed(1));
  console.log('参照 LR tint=50：', 'a* ' + LR50.a, 'b* ' + LR50.b, 'L* ' + LR50.L, 'C* ' + LR50.C);
  console.log('我们 tint=50   ：', 'a* ' + b50.y.a.toFixed(1), 'b* ' + b50.y.b.toFixed(1), 'L* ' + b50.y.L.toFixed(1), 'C* ' + b50.y.C.toFixed(1),
    ' → 差 a ' + (b50.y.a - LR50.a).toFixed(1) + ' / b ' + (b50.y.b - LR50.b).toFixed(1) + ' / C ' + (b50.y.C - LR50.C).toFixed(1));

  console.log('\n变体（都在 tint=38 下）：     黄带a*  黄带b*  黄带L*  黄带C*   全图C*   全图RGB          Δb*  ΔC*');
  for (const [k] of VARIANTS) {
    const s = out.r[k];
    if (!s) continue;
    const v = stat(s);
    console.log(' ' + k.padEnd(14) + v.y.a.toFixed(1).padStart(7) + v.y.b.toFixed(1).padStart(8) +
      v.y.L.toFixed(1).padStart(8) + v.y.C.toFixed(1).padStart(8) + v.C.toFixed(1).padStart(8) +
      ('  ' + v.rgb.map((x) => x.toFixed(0)).join('/')).padEnd(15) +
      (v.y.b - b0.y.b >= 0 ? '+' : '') + (v.y.b - b0.y.b).toFixed(1) +
      (v.y.C - b0.y.C >= 0 ? '  +' : '  ') + (v.y.C - b0.y.C).toFixed(1));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
