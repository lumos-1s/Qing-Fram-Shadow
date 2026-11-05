// 用 CPU 三线性插值复现 WebGL 的三维色表通道，从而在无 GL 环境下量到真实管线的结果
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg';
const USER = 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg';
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

// ── CPU 版 pass：只做三维表（本预设无镜头校正/去雾/黑白，故与 GL 等价）──
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
          const wg = db ? (dg2 ? fg : 1 - fg) : (dg2 ? fg : 1 - fg);
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

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsColor)')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await w.webContents.executeJavaScript(CPU_PASS);

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    // 统一缩到 1400px 宽：三维表与分辨率无关，缩图能把 CPU 插值耗时压到可接受
    const W = 1400, H = Math.round(1400 * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/jpeg', 0.98); });

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    await A.flushRender(); await sleep(400);
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;

    const stat = (cv) => {
      const W2 = 700, H2 = Math.round(700 * cv.height / cv.width);
      const c = document.createElement('canvas'); c.width = W2; c.height = H2;
      const g = c.getContext('2d'); g.drawImage(cv, 0, 0, W2, H2);
      const d = g.getImageData(0, 0, W2, H2).data;
      let r = 0, gg = 0, b = 0, n = 0, sa = 0; const L = [];
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G2 = d[i + 1], B = d[i + 2];
        r += R; gg += G2; b += B; n++;
        const mx = Math.max(R, G2, B), mn = Math.min(R, G2, B);
        sa += mx > 0 ? (mx - mn) / mx : 0;
        L.push(0.2126 * R + 0.7152 * G2 + 0.0722 * B);
      }
      L.sort((a, b2) => a - b2);
      const q = (pp) => Math.round(L[Math.floor(L.length * pp)] || 0);
      return { rgb: [Math.round(r / n), Math.round(gg / n), Math.round(b / n)], lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((sa / n) * 100).toFixed(1) };
    };

    const labStat = (cv) => {
      const W2 = 700, H2 = Math.round(700 * cv.height / cv.width);
      const c = document.createElement('canvas'); c.width = W2; c.height = H2;
      const g = c.getContext('2d'); g.drawImage(cv, 0, 0, W2, H2);
      const d = g.getImageData(0, 0, W2, H2).data;
      const iv = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
      const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      let L = 0, Aa = 0, Bb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = iv(d[i] / 255), g2 = iv(d[i + 1] / 255), b = iv(d[i + 2] / 255);
        let X = f((0.4124 * r + 0.3576 * g2 + 0.1805 * b) / 0.95047);
        let Y = f(0.2126 * r + 0.7152 * g2 + 0.0722 * b);
        let Z = f((0.0193 * r + 0.1192 * g2 + 0.9505 * b) / 1.08883);
        L += 116 * Y - 16; Aa += 500 * (X - Y); Bb += 200 * (Y - Z); n++;
      }
      return { L: +(L / n).toFixed(1), a: +(Aa / n).toFixed(1), b: +(Bb / n).toFixed(1) };
    };

    const run = async (patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender(); await sleep(400);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(900);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const s = stat(cv), lb = labStat(cv);
      s.L = lb.L; s.a = lb.a; s.b = lb.b;
      return s;
    };

    const base0 = JSON.parse(JSON.stringify(base));
    base0.tint = 0;
    const sample = (pts, n) => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        let k = 0;
        while (k < pts.length - 2 && pts[k + 1][0] < x) k++;
        const a = pts[k], b = pts[k + 1];
        const t = b[0] > a[0] ? (x - a[0]) / (b[0] - a[0]) : 0;
        out[i] = a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, t));
      }
      return out;
    };
    const r = {};
    r.pointOnly = await run(base0);
    const P = window.QfsAcr.parametricDiag(0, 50, 0, 0);
    r.paramOnly = await run(Object.assign({}, base0, { curve: { rgb: P } }));
    if (P && base0.curve && base0.curve.rgb) {
      const A = sample(base0.curve.rgb, 256), B = sample(P, 256);
      const comp = [];
      for (let i = 0; i < 256; i++) comp.push([i / 255, B[Math.max(0, Math.min(255, Math.round(A[i] * 255)))]]);
      r.both = await run(Object.assign({}, base0, { curve: Object.assign({}, base0.curve, { rgb: comp }) }));
    }
    r.noCurve = await run(Object.assign({}, base0, { curve: { rgb: [[0, 0], [1, 1]] } }));
    return r;
  })()`);

  const jpeg = require('jpeg-js');
  const iv = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  const f8 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const ref = (f) => {
    const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const W = 700, H = Math.round(700 * img.height / img.width);
    const d = img.data, iw = img.width, ih = img.height;
    let r = 0, g = 0, b = 0, n = 0, sa = 0, LL = 0, Aa = 0, Bb = 0; const L = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sa += mx > 0 ? (mx - mn) / mx : 0;
      L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
      const rr = iv(R / 255), gg = iv(G / 255), bb = iv(B / 255);
      const X = f8((0.4124 * rr + 0.3576 * gg + 0.1805 * bb) / 0.95047);
      const Y = f8(0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
      const Z = f8((0.0193 * rr + 0.1192 * gg + 0.9505 * bb) / 1.08883);
      LL += 116 * Y - 16; Aa += 500 * (X - Y); Bb += 200 * (Y - Z);
    }
    L.sort((a, b2) => a - b2);
    const q = (p) => Math.round(L[Math.floor(L.length * p)] || 0);
    return { L: +(LL / n).toFixed(1), a: +(Aa / n).toFixed(1), b: +(Bb / n).toFixed(1),
      rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
      lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((sa / n) * 100).toFixed(1) };
  };
  const LRDIR = 'C:/Users/lumos/.workbuddy/clipboard-images/';
  const LRREF = {
    0: ref(LRDIR + 'clipboard-2026-11-04T09-06-26-912Z-d6c9e40f.jpg'),
    50: ref(LRDIR + 'clipboard-2026-11-04T09-06-26-915Z-bedfecfa.jpg'),
    100: ref(LRDIR + 'clipboard-2026-11-04T09-06-26-909Z-e09d058e.jpg'),
  };
  const T = LRREF[0];
  const rows = [
    ['只点曲线(当前)', out.pointOnly],
    ['只参数曲线', out.paramOnly],
    ['点+参数叠加', out.both],
    ['线性(无曲线)', out.noCurve],
  ];
  console.log('方案'.padEnd(16), '  L     a*    b*  饱和  亮度 5/25/50/75/95');
  const dist = (v) => Math.sqrt(v.lv.reduce((s, x, i) => s + (x - T.lv[i]) ** 2, 0) / 5 + (v.sat - T.sat) ** 2 * 0.3);
  for (const [k, v] of rows) {
    if (!v) { console.log(k, '(失败)'); continue; }
    console.log(k.padEnd(16), String(v.L).padStart(5), String(v.a).padStart(5), String(v.b).padStart(5), String(v.sat).padStart(5), v.lv.join('/'), '  偏差 ' + dist(v).toFixed(1));
  }
  console.log('★ LR tint0'.padEnd(15), String(T.L).padStart(5), String(T.a).padStart(5), String(T.b).padStart(5), String(T.sat).padStart(5), T.lv.join('/'));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
