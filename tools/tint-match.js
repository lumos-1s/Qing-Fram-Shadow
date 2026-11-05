// tint 匹配实验：固定其余参数，扫 tint，把每个结果对齐到 LR 截图后按 Lab 误差打分。
// 目的：判断我们对 tint 的响应是不是「过强」，以及截图对应的等效 tint。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const SHOT = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T12-51-55-527Z-61c9021d.jpg';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const OUT = path.join(ROOT, 'tools', 'out');
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

// ── 载入截图内容区 ───────────────────────────────
const shotRaw = jpeg.decode(fs.readFileSync(SHOT), { useTArray: true, maxMemoryUsageInMB: 4096 });
const X0 = 0, X1 = 1663, Y0 = 4, Y1 = 1104;
const SW = X1 - X0, SH = Y1 - Y0;
const SHOTRGB = { w: SW, h: SH, d: Buffer.alloc(SW * SH * 3) };
for (let y = 0; y < SH; y++) {
  for (let x = 0; x < SW; x++) {
    const s = ((y + Y0) * shotRaw.width + (x + X0)) * 4, d = (y * SW + x) * 3;
    SHOTRGB.d[d] = shotRaw.data[s]; SHOTRGB.d[d + 1] = shotRaw.data[s + 1]; SHOTRGB.d[d + 2] = shotRaw.data[s + 2];
  }
}

const CX = 0.4997, CY = 0.4953, SX = 0.9987, SY = 0.9919;
function warp(im) {
  const w = SW, h = SH;
  const out = { w, h, d: Buffer.alloc(w * h * 3) };
  for (let y = 0; y < h; y++) {
    const gn = (y + 0.5) / h;
    const vy = (CY + (gn - 0.5) * SY) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / w;
      const vx = (CX + (gx - 0.5) * SX) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const d = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) {
        const a = im.d[(y0 * im.w + x0) * 3 + k] * (1 - fx) + im.d[(y0 * im.w + x0 + 1) * 3 + k] * fx;
        const b = im.d[((y0 + 1) * im.w + x0) * 3 + k] * (1 - fx) + im.d[((y0 + 1) * im.w + x0 + 1) * 3 + k] * fx;
        out.d[d + k] = a * (1 - fy) + b * fy;
      }
    }
  }
  return out;
}

const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B2 = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

function score(im) {
  let dE = 0, dL = 0, dh = 0, dC = 0, n = 0, ny = 0, dR = 0, dG = 0, dB = 0;
  for (let i = 0; i < SW * SH; i++) {
    const p = i * 3;
    const la = lab(SHOTRGB.d[p], SHOTRGB.d[p + 1], SHOTRGB.d[p + 2]);
    const lb = lab(im.d[p], im.d[p + 1], im.d[p + 2]);
    dE += Math.hypot(lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]);
    dL += lb[0] - la[0];
    dR += im.d[p] - SHOTRGB.d[p]; dG += im.d[p + 1] - SHOTRGB.d[p + 1]; dB += im.d[p + 2] - SHOTRGB.d[p + 2];
    n++;
    const Ca = Math.hypot(la[1], la[2]);
    if (la[0] > 20 && la[0] < 240 && Ca > 12) {
      let ha = Math.atan2(la[2], la[1]) * 180 / Math.PI; if (ha < 0) ha += 360;
      if (ha >= 70 && ha < 100) {
        let hb = Math.atan2(lb[2], lb[1]) * 180 / Math.PI;
        let d = hb - (ha > 180 ? ha - 360 : ha); while (d > 180) d -= 360; while (d < -180) d += 360;
        dh += d; dC += Math.hypot(lb[1], lb[2]) - Ca; ny++;
      }
    }
  }
  return {
    dE: dE / n, dL: dL / n, dh: ny ? dh / ny : 0, dC: ny ? dC / ny : 0, ny: ny / n,
    dRGB: [dR / n, dG / n, dB / n],
  };
}

const TINTS = [-20, 0, 10, 20, 30, 38, 48, 60, 75];

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
  const TW = 1663;
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
      await A.flushRender(); await sleep(220);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(600);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height, rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { rgb[i*3] = d[i*4]; rgb[i*3+1] = d[i*4+1]; rgb[i*3+2] = d[i*4+2]; }
      return { w: cv.width, h: cv.height, d: Array.from(rgb) };
    };
    const shots = {};
    for (const t of ${JSON.stringify(TINTS)}) shots['t' + t] = await run(t);
    return { shots, base: { temp: base.temp, tint: base.tint } };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('XMP：temp =', out.base.temp, ' tint =', out.base.tint, '\n');
  console.log('  tint    ΔE76   ΔL    ΔRGB(R,G,B)        黄带Δh   黄带ΔC  占比');
  const rows = [];
  for (const t of TINTS) {
    const s = out.shots['t' + t];
    if (!s) continue;
    const im = { w: s.w, h: s.h, d: Uint8Array.from(s.d) };
    const r = score(warp(im));
    rows.push({ t, ...r });
    console.log(String(t).padStart(6), r.dE.toFixed(2).padStart(8), r.dL.toFixed(1).padStart(6),
      ('(' + r.dRGB.map((v) => v.toFixed(1)).join(',') + ')').padStart(20),
      r.dh.toFixed(1).padStart(8), r.dC.toFixed(1).padStart(8),
      (100 * r.ny).toFixed(1).padStart(6) + '%');
  }
  const best = rows.slice().sort((a, b) => a.dE - b.dE)[0];
  console.log('\n最佳 tint =', best.t, ' ΔE', best.dE.toFixed(2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
