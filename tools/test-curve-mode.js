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
      return cv ? stat(cv) : null;
    };

    const PTS = [[0,0],[17,26],[34,44],[51,60],[68,74],[85,89],[102,105],[119,120],[136,135],[153,151],[170,167],[187,183],[204,200],[221,218],[238,236],[255,255]].map(p => [p[0]/255, p[1]/255]);
    const r = { full: await run(base) };
    const mk = (fn) => { const p = JSON.parse(JSON.stringify(base)); fn(p); return p; };
    r.pointOnly = await run(mk(p => { p.curve = Object.assign({}, p.curve, { rgb: PTS }); }));
    r.paramOnly = await run(mk(p => { p.curve = Object.assign({}, p.curve, { rgb: PTS.slice(0,1).concat([PTS[PTS.length-1]]) }); delete p.curve.rgb; }));
    r.noCurve = await run(mk(p => { delete p.curve; }));
    return r;
  })()`);

  const jpeg = require('jpeg-js');
  const ref = (f) => {
    const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const W = 700, H = Math.round(700 * img.height / img.width);
    const d = img.data, iw = img.width, ih = img.height;
    let r = 0, g = 0, b = 0, n = 0, sa = 0; const L = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sa += mx > 0 ? (mx - mn) / mx : 0;
      L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
    L.sort((a, b2) => a - b2);
    const q = (p) => Math.round(L[Math.floor(L.length * p)] || 0);
    return { rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((sa / n) * 100).toFixed(1) };
  };
  const T = ref(LR), U = ref(USER);
  const dist = (a) => Math.sqrt(
    a.rgb.reduce((s, v, i) => s + (v - T.rgb[i]) ** 2, 0) / 3 +
    a.lv.reduce((s, v, i) => s + (v - T.lv[i]) ** 2, 0) / 5 * 0.5 +
    (a.sat - T.sat) ** 2 * 0.5);

  const rows = [['当前(点+参数叠加)', out.full], ['只用点曲线', out.pointOnly], ['无曲线', out.noCurve]];
  console.log('方案'.padEnd(20), '平均RGB'.padEnd(16), '亮度 5/25/50/75/95'.padEnd(24), '饱和', ' 偏差');
  for (const [k, v] of rows) {
    if (!v) { console.log(k, '(失败)'); continue; }
    console.log(k.padEnd(18), JSON.stringify(v.rgb).padEnd(16), v.lv.join('/').padEnd(24), String(v.sat).padStart(5), dist(v).toFixed(1).padStart(6));
  }
  console.log('★ LR 目标'.padEnd(18), JSON.stringify(T.rgb).padEnd(16), T.lv.join('/').padEnd(24), String(T.sat).padStart(5), '     —');
  console.log('★ 你的导出'.padEnd(18), JSON.stringify(U.rgb).padEnd(16), U.lv.join('/').padEnd(24), String(U.sat).padStart(5), dist(U).toFixed(1).padStart(6));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
