// 彩度残差溯源：探测工具自身会把源图重编码成 JPEG(q0.98) 再烘，输出又存 JPEG，
// 两次 4:2:0 色度下采样都会削彩度。这里同一份渲染跑 JPEG / PNG 两种进出，
// 看「整体 C* 比 LR 低 1.3」里有多少是工具的编码损耗，有多少是真的实现差异。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg';
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
      let outR = 0, outG = 0, outB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg, wy = wb * wg, y = g0 + dg2;
          for (let dr = 0; dr < 2; dr++) {
            const wr = dr ? fr : 1 - fr;
            const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
            outR += wy * wr * A[idx]; outG += wy * wr * A[idx + 1]; outB += wy * wr * A[idx + 2];
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

const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const labOf = (r, g, b) => {
  const R = srgb(r), G = srgb(g), B = srgb(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  let h = Math.atan2(200 * (fy - fz), 500 * (fx - fy)) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L: 116 * fy - 16, C: Math.hypot(500 * (fx - fy), 200 * (fy - fz)), h };
};

// 面积平均缩到 W×H
function resample(px, w, h, W, H) {
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
      let R = 0, G = 0, B = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const s = (sy * w + sx) * 4;
        R += px[s]; G += px[s + 1]; B += px[s + 2]; n++;
      }
      const d = (y * W + x) * 3;
      out[d] = R / n; out[d + 1] = G / n; out[d + 2] = B / n;
    }
  }
  return out;
}

const HUES = [[345, 15, '红'], [15, 45, '橙'], [45, 70, '黄'], [70, 100, '黄绿'],
  [100, 150, '绿'], [150, 200, '青'], [200, 260, '蓝'], [260, 300, '紫'], [300, 345, '洋红']];

function analyse(maps, W, H) {
  const buckets = HUES.map(() => ({ n: 0, sc: 0, oc: 0, lc: 0, ol: 0, ll: 0 }));
  const N = W * H;
  for (let i = 0; i < N; i++) {
    const k = i * 3;
    const s = labOf(maps.src[k], maps.src[k + 1], maps.src[k + 2]);
    if (s.C < 8) continue;
    let bi = -1;
    for (let j = 0; j < HUES.length; j++) {
      const lo = HUES[j][0], hi = HUES[j][1];
      if (lo < hi ? (s.h >= lo && s.h < hi) : (s.h >= lo || s.h < hi)) { bi = j; break; }
    }
    if (bi < 0) continue;
    const o = labOf(maps.ours[k], maps.ours[k + 1], maps.ours[k + 2]);
    const l = labOf(maps.lr[k], maps.lr[k + 1], maps.lr[k + 2]);
    const b = buckets[bi];
    b.n++; b.sc += s.C; b.oc += o.C; b.lc += l.C; b.ol += o.L; b.ll += l.L;
  }
  return buckets;
}

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
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = ${TW}, H = Math.round(${TW} * raw.height / raw.width);

    const makeImg = async (mime) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      cv.getContext('2d').drawImage(raw, 0, 0, W, H);
      const src = new Image();
      const url = cv.toDataURL(mime, 0.98);
      await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = url; });
      return { src, url };
    };

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;

    const runOne = async (mime) => {
      const pk = await makeImg(mime);
      const im = { name: 'DSC09381', el: pk.src, w: pk.src.naturalWidth, h: pk.src.naturalHeight, exif: {} };
      A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
      A.template = A.defaultTemplate();
      A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
      await window.QfsAcr.ensure(); await window.QfsShadows.ensure();
      await A.flushRender(); await sleep(200);
      A.setGrade(base, { replace: true, full: true });
      await A.flushRender(); await sleep(200);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(700);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      return { src: pk.url, out: cv.toDataURL(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.98), w: cv.width, h: cv.height };
    };
    return { jpeg: await runOne('image/jpeg'), png: await runOne('image/png') };
  })()`);

  const b64 = (url) => Buffer.from(url.split(',')[1], 'base64');
  const decode = (url) => {
    const buf = b64(url);
    if (url.startsWith('data:image/png')) {
      const p = PNG.sync.read(buf);
      return { w: p.width, h: p.height, data: new Uint8Array(p.data) };
    }
    const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, data: new Uint8Array(j.data) };
  };

  const lri = jpeg.decode(fs.readFileSync(LR), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const W = out.jpeg.w, H = out.jpeg.h;
  const lr = resample(lri.data, lri.width, lri.height, W, H);

  console.log('尺寸', W + 'x' + H);
  for (const mode of ['jpeg', 'png']) {
    const s = out[mode];
    if (!s) { console.log(mode, '失败'); continue; }
    const src = decode(s.src), ours = decode(s.out);
    const bk = analyse({ src: resample(src.data, src.w, src.h, W, H), ours: resample(ours.data, ours.w, ours.h, W, H), lr }, W, H);
    const tot = bk.reduce((a, b) => ({
      n: a.n + b.n, oc: a.oc + b.oc, lc: a.lc + b.lc, ol: a.ol + b.ol, ll: a.ll + b.ll,
    }), { n: 0, oc: 0, lc: 0, ol: 0, ll: 0 });
    const rows = bk.map((b, i) => b.n > 1000
      ? `${HUES[i][2]} ${(b.oc / b.n).toFixed(1)}/${(b.lc / b.n).toFixed(1)}→${((b.oc - b.lc) / b.n).toFixed(1)}`
      : null).filter(Boolean).join('  ');
    console.log(mode.padEnd(5), '总体C* 我们', (tot.oc / tot.n).toFixed(2), 'LR', (tot.lc / tot.n).toFixed(2),
      'Δ', ((tot.oc - tot.lc) / tot.n).toFixed(2),
      '| L* Δ', ((tot.ol - tot.ll) / tot.n).toFixed(2));
    console.log('      ', rows);
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
