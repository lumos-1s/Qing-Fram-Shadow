// 验证阴影场缓存在真实烘焙路径上生效、且该失效时确实失效：
//   A 同参数首烘（冷）        → 慢
//   B 只改 sh（应命中）       → 快，且结果与 A 不同（说明只复用了场，不是复用输出）
//   C 改曝光（应失效）        → 回到慢
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
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = 1600, H = Math.round(1600 * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/jpeg', 0.98); });

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await window.QfsAcr.ensure(); await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(200);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;

    const bakeTimed = async (patch, label) => {
      const s0 = window.QfsShadows.stats();
      A.setGrade(patch, { replace: true, full: true });
      if (im._grade) { im._grade.canvas = null; im._grade.fullKey = ''; }
      im._gradeCache = null;
      const t0 = performance.now();
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      const ms = performance.now() - t0;
      const s1 = window.QfsShadows.stats();
      const cv = im._grade && im._grade.canvas;
      const d = cv ? cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data : null;
      let sum = 0, lum = 0;
      if (d) for (let i = 0; i < d.length; i += 4) { lum += 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]; sum += d[i]; }
      const n = d ? d.length / 4 : 1;
      return { label, ms: +ms.toFixed(1), lum: +(lum / n).toFixed(3), r: +(sum / n).toFixed(3),
        field: s1.misses - s0.misses, hit: s1.hits - s0.hits, size: cv ? cv.width + 'x' + cv.height : '-' };
    };

    const mk = (o) => { const p = JSON.parse(JSON.stringify(base)); Object.assign(p, o); return p; };
    const r = {};
    r.A = await bakeTimed(mk({}), 'A 冷启动（同参数首烘）');
    r.B = await bakeTimed(mk({ sh: -31 }), 'B 只改 sh（应命中场缓存）');
    r.C = await bakeTimed(mk({ sh: -31, exp: 1.56 }), 'C 改曝光（应失效重算）');
    r.D = await bakeTimed(mk({ sh: -31, exp: 1.56 }), 'D 同 C 再来一次');
    r.stats = window.QfsShadows.stats();
    return r;
  })()`);

  for (const k of ['A', 'B', 'C', 'D']) {
    const x = out[k];
    if (!x) continue;
    console.log(x.label.padEnd(24), String(x.ms).padStart(7) + 'ms', x.size.padStart(10),
      ' 场重算', x.field, ' 命中', x.hit, ' 亮度均值', x.lum, ' R均值', x.r);
  }
  console.log('累计', JSON.stringify(out.stats));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
