// 用 CPU 三线性插值复现 WebGL 的三维色表通道，从而在无 GL 环境下量到真实管线的结果
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/DSC09381.jpg';
const USER = 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_2.jpg';
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

    const run = async (patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender(); await sleep(400);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(900);
      const cv = im._grade && im._grade.canvas;
      return cv ? Object.assign(stat(cv), { url: cv.toDataURL('image/jpeg', 0.95) }) : null;
    };

    const r = { full: await run(base) };
    const mk = (fn) => { const p = JSON.parse(JSON.stringify(base)); fn(p); return p; };
    for (const tp of [-70, -42, -20]) {
      r['t' + tp + '_n38'] = await run(mk(p => { p.temp = tp; p.tint = 38; }));
    }
    r.tm42_n22 = await run(mk(p => { p.temp = -42; p.tint = 22; }));
    r.tm20_n22 = await run(mk(p => { p.temp = -20; p.tint = 22; }));
    r.full = await run(base);
    return r;
  })()`);

  const jpeg = require('jpeg-js');
  const hueOf = (f) => {
    const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const W = 900, H = Math.round(900 * img.height / img.width);
    const d = img.data, iw = img.width, ih = img.height;
    const bins = new Array(12).fill(0); let n = 0, sat = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), dd = mx - mn;
      if (mx < 0.12 || mx > 0.97 || dd < 0.02) continue;
      let h = 0;
      if (mx === R) h = ((G - B) / dd + (G < B ? 6 : 0));
      else if (mx === G) h = (B - R) / dd + 2;
      else h = (R - G) / dd + 4;
      h *= 60;
      bins[Math.min(11, Math.floor(h / 30))]++; n++; sat += dd / mx;
    }
    return { bins: bins.map(v => +(100 * v / n).toFixed(1)), sat: +(100 * sat / n).toFixed(1) };
  };
  const cartToFile = (name, url) => {
    const f = path.join(ROOT, 'tools', 'out', name + '.jpg');
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    return f;
  };
  const BAND = ['0', '30', '60', '90', '120', '150', '180', '210', '240', '270', '300', '330'];
  console.log('方案'.padEnd(10), BAND.map(b => b.padStart(5)).join(' '), '  饱和');
  const rows = [['当前', out.full], ['无分级', out.noCg], ['色调0', out.tint0], ['色调19', out.tintHalf], ['色温0', out.temp0], ['无混色器', out.noMix]];
  for (const [k, v] of rows) {
    if (!v || !v.url) { console.log(k, '(失败)'); continue; }
    const hs = hueOf(cartToFile('h_' + k, v.url));
    console.log(k.padEnd(12), hs.bins.map(b => String(b).padStart(5)).join(' '), String(hs.sat).padStart(6));
  }
  const lr = hueOf(LR);
  console.log('LR参考'.padEnd(10), lr.bins.map(b => String(b).padStart(5)).join(' '), String(lr.sat).padStart(6));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });  const jpeg = require('jpeg-js');
  const inv = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  const toLab = (R, G, B) => {
    const r = inv(R / 255), g = inv(G / 255), b = inv(B / 255);
    let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
    let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    X = f(X); Y = f(Y); Z = f(Z);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  };
  const labOf = (f) => {
    const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const W = 800, H = Math.round(800 * img.height / img.width);
    const d = img.data, iw = img.width, ih = img.height;
    let L = 0, A = 0, B2 = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
      const v = toLab(d[i], d[i + 1], d[i + 2]);
      L += v[0]; A += v[1]; B2 += v[2]; n++;
    }
    return [L / n, A / n, B2 / n];
  };
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  console.log('方案'.padEnd(14), '   L      a*     b*');
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (!v || !v.url) { console.log(k, '(失败)'); continue; }
    const f = path.join(outDir, 'wb_' + k + '.jpg');
    fs.writeFileSync(f, Buffer.from(v.url.split(',')[1], 'base64'));
    const [L, A, B2] = labOf(f);
    console.log(k.padEnd(14), L.toFixed(1).padStart(5), A.toFixed(1).padStart(6), B2.toFixed(1).padStart(6));
  }
  const [L, A, B2] = labOf(LR);
  console.log('LR 参考'.padEnd(12), L.toFixed(1).padStart(5), A.toFixed(1).padStart(6), B2.toFixed(1).padStart(6));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
