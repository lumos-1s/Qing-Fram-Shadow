// 自适应档位标定：对比度 / 高光这两档在 ACR 里是按「图片有多亮」选表的，
// 键算偏了就是「整体略偏硬」（暗部更暗、高光更亮），正好对上分带残差的形状。
// 这里把 (con, hi) 两个键做成网格，各自烘一张，看分带残差怎么动。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const LR1400 = path.join(ROOT, 'tools', 'out', 'sh_lr.jpg');
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

// 分带统计：按「参照图（LR）」的亮度分桶，报我们的均值差（负 = 我们更暗）
const BAND_STATS = `
  window.__bands = function (refD, d, W, H) {
    const B = [[0,32],[32,64],[64,96],[96,128],[128,160],[160,192],[192,224],[224,256]];
    const acc = B.map(() => ({ n: 0, s: 0 }));
    let sum = 0;
    const luma = (a, b, c) => 0.2126 * a + 0.7152 * b + 0.0722 * c;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const lr = luma(refD[p], refD[p+1], refD[p+2]);
      const lo = luma(d[p], d[p+1], d[p+2]);
      sum += lo - lr;
      const bi = Math.min(7, (lr / 32) | 0);
      acc[bi].n++; acc[bi].s += lo - lr;
    }
    return { bias: sum / (W * H), bands: acc.map(x => x.n ? x.s / x.n : 0), w: acc.map(x => x.n / (W*H)) };
  };
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
  await w.webContents.executeJavaScript(CPU_PASS + BAND_STATS);

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const TW = 1400;
  const out = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = ${TW}, H = Math.round(${TW} * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/jpeg', 0.98); });

    const ref = new Image();
    await new Promise((r, j) => { ref.onload = r; ref.onerror = j; ref.src = ${JSON.stringify(dataUrl(LR1400))}; });
    const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
    const rg = rc.getContext('2d');
    rg.drawImage(ref, 0, 0, W, H);
    const refD = rg.getImageData(0, 0, W, H).data;

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await window.QfsAcr.ensure(); await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(200);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;
    if (!im._acrBright) im._acrBright = window.QfsAcr.measureBrightness(src);
    const real = { con: im._acrBright.con, hi: im._acrBright.hi, sh: im._acrBright.sh };
    const realMeasure = window.QfsAcr.measureBrightness;
    const run = async (con, hi) => {
      // setGrade 会 delete im._acrBright 又重新测一次，直接写字段会被覆盖；
      // 改从源头（measureBrightness）注入，保证这次烘焙读到的是指定的键。
      window.QfsAcr.measureBrightness = () => ({ con, hi, sh: real.sh });
      A.setGrade(base, { replace: true, full: true });
      if (im._grade) { im._grade.canvas = null; im._grade.fullKey = ''; }
      im._gradeCache = null;
      await A.flushRender(); await sleep(150);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(500);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      return window.__bands(refD, d, W, H);
    };
    const res = { real, rows: [] };
    for (const con of [80, 104, 130, 160]) {
      for (const hi of [130, 160, 190, 224]) {
        res.rows.push({ con, hi, r: await run(con, hi) });
      }
    }
    return res;
  })()`);

  const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);
  console.log('原键 con/hi =', out.real.con + '/' + out.real.hi);
  console.log('\ncon  hi  |  0-32  32-64  64-96  96-128 128-160 160-192 192-224 224-256 | 整体');
  for (const row of out.rows) {
    if (!row.r) { console.log(row.con, row.hi, '失败'); continue; }
    const tag = (row.con === out.real.con && row.hi === out.real.hi) ? ' *' : '';
    console.log(String(row.con).padStart(3), String(row.hi).padStart(3), '|',
      row.r.bands.map((b) => fmt(b).padStart(6)).join(' '), '|', fmt(row.r.bias).padStart(6) + tag);
  }
  console.log('\n像素占比', out.rows[0].r.w.map((x) => (x * 100).toFixed(1) + '%').join(' '));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
