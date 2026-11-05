// 端到端校验：把一张灰阶渐变喂进真实烘焙流程，做四路消融，定位「灰轴系统性偏低」
// 到底出在哪个环节：阴影空间 pass / 三维修正表 / CSS 滤镜的对角线本身。
//
//   full    阴影 + 三维修正（当前线上路径）
//   no-sh   关掉阴影 pass，其余不动
//   no-fix  关掉三维修正（colorLut 不传亮度测度），其余不动
//   bare    只有 CSS 滤镜（连三维颜色表都关掉）
//
// 期望值一律用 toneStages 的灰轴对角线，也就是「滤镜本该给出的值」。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');

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
  window.__cpuPassOrig = window.__cpuPass;
  window.QfsColor.pass = window.__cpuPass;
  true;
`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
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
    await window.QfsAcr.ensure(); await window.QfsShadows.ensure();

    // 灰阶 1024×64：横向 0..255，纵向加一点错位纹理，让「有纹理像素」判据能成立
    const W = 1024, H = 64;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = Math.round(x * 255 / (W - 1));
      const vv = (y % 2 && x % 3 === 0) ? Math.max(0, v - 4) : v;
      const i = (y * W + x) * 4;
      img.data[i] = vv; img.data[i + 1] = vv; img.data[i + 2] = vv; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = cv.toDataURL('image/png'); });
    const im = { name: 'ramp', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await A.flushRender(); await sleep(300);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;
    A.setGrade(base, { replace: true, full: true });
    await A.flushRender(); await sleep(200);

    // ── 消融开关 ───────────────────────────────────────────────
    const shReal = window.QfsShadows.applyCanvas.bind(window.QfsShadows);
    const lutReal = window.QfsAcr.colorLut;
    const passReal = window.__cpuPass;
    function setMode(m) {
      window.QfsShadows.applyCanvas = (m.sh ? shReal : () => false);
      window.QfsAcr.colorLut = (m.fix ? lutReal : (p, gr) => lutReal(p, gr, null));
      window.QfsColor.pass = (m.lut ? passReal : () => null);
    }

    function readRamp() {
      const outC = im._grade && im._grade.canvas;
      if (!outC) return null;
      const d = outC.getContext('2d').getImageData(0, 0, outC.width, outC.height).data;
      const rows = [];
      for (let v = 0; v <= 255; v += 8) {
        const x = Math.round(v * (outC.width - 1) / 255);
        const i = (Math.floor(outC.height / 2) * outC.width + x) * 4;
        rows.push([d[i], d[i + 1], d[i + 2]]);
      }
      return { rows, size: [outC.width, outC.height] };
    }
    async function bakeWith(m) {
      setMode(m);
      if (im._grade) { im._grade.canvas = null; im._grade.fullKey = ''; }
      im._gradeCache = null;
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender();
      return readRamp();
    }

    const modes = {
      full: { sh: 1, fix: 1, lut: 1 },
      noSh: { sh: 0, fix: 1, lut: 1 },
      noFix: { sh: 0, fix: 0, lut: 1 },
      bare: { sh: 0, fix: 0, lut: 0 },
    };
    const res = {};
    for (const k of Object.keys(modes)) res[k] = await bakeWith(modes[k]);
    setMode(modes.full);

    // 期望：色调的灰轴对角线（= CSS 滤镜本该给出的值）
    const br = im._acrBright || { con: 128, hi: 128 };
    const F = window.QfsAcr.toneStages({ exp: base.exp, temp: base.temp, tint: base.tint, con: base.con,
      hi: base.hi, white: base.white, black: base.black }, br);
    // 滤镜里的表还串了用户曲线（buildTables 的 cl），所以第二条期望要把曲线也叠上
    const CU = window.QfsCurve;
    const curved = !!(CU && CU.curveActive(base.curve));
    const cl = curved ? CU.buildCurveLuts(base.curve) : null;
    const chain = (d, c) => {
      if (!c) return d;
      const o = new Array(256);
      for (let i = 0; i < 256; i++) o[i] = c[Math.min(255, Math.round(Math.max(0, Math.min(1, d[i])) * 255))];
      return o;
    };
    const FC = { r: chain(F.r, cl && cl.r), g: chain(F.g, cl && cl.g), b: chain(F.b, cl && cl.b) };

    // 直接看当前线上 LUT 的灰轴响应（把 LUT 喂给它自己的对角线输出，应当 ≈ 恒等）
    const lut = window.QfsAcr.colorLut(base, 33, br);
    const sampleLut = (r, gg, b) => {
      const G = lut.grid, S = G - 1, arr = lut.rgba;
      const x = Math.min(S, r * S / 255), y = Math.min(S, gg * S / 255), z = Math.min(S, b * S / 255);
      const i0 = Math.min(S - 1, Math.floor(x)), j0 = Math.min(S - 1, Math.floor(y)), k0 = Math.min(S - 1, Math.floor(z));
      const fx = x - i0, fy = y - j0, fz = z - k0;
      const at2 = (ri, gi, bi) => ((gi * G + bi) * G + ri) * 4;
      const o = [];
      for (let ch = 0; ch < 3; ch++) {
        const c00 = arr[at2(i0, j0, k0) + ch] * (1 - fx) + arr[at2(i0 + 1, j0, k0) + ch] * fx;
        const c10 = arr[at2(i0, j0 + 1, k0) + ch] * (1 - fx) + arr[at2(i0 + 1, j0 + 1, k0) + ch] * fx;
        const c01 = arr[at2(i0, j0, k0 + 1) + ch] * (1 - fx) + arr[at2(i0 + 1, j0, k0 + 1) + ch] * fx;
        const c11 = arr[at2(i0, j0 + 1, k0 + 1) + ch] * (1 - fx) + arr[at2(i0 + 1, j0 + 1, k0 + 1) + ch] * fx;
        o.push((c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz);
      }
      return o;
    };
    const lutRows = [];
    for (let v = 0; v <= 255; v += 8) {
      const y = [F.r[v] * 255, F.g[v] * 255, F.b[v] * 255];
      const o = sampleLut(y[0], y[1], y[2]);
      lutRows.push([Math.round(y[0]), Math.round(y[1]), Math.round(y[2]),
        Math.round(o[0]), Math.round(o[1]), Math.round(o[2])]);
    }
    return { res, want: Array.from({ length: 32 }, (_, k) => Math.round(F.r[k * 8] * 255)),
      wantC: Array.from({ length: 32 }, (_, k) => Math.round(FC.r[k * 8] * 255)),
      br, sh: base.sh, curved, lutRows, hasLut: !!lut };
  })()`);

  if (out.error) { console.log(out.error); app.quit(); return; }
  const { res } = out;
  console.log('输出尺寸', res.full && res.full.size.join('x'), '亮度测度', JSON.stringify(out.br),
    '预设 sh =', out.sh, '点曲线 =', out.curved, 'LUT =', out.hasLut);
  const lum = (a) => Math.round(0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]);
  console.log('\n  v   色调对角  +曲线   full  noSh  noFix  bare   bare-曲线');
  for (let k = 0; k < 32; k++) {
    const v = k * 8, w = out.want[k];
    const cols = ['full', 'noSh', 'noFix', 'bare'].map((n) => {
      const a = res[n] && res[n].rows[k];
      return a ? String(lum(a)).padStart(5) : '    -';
    });
    const bare = res.bare && res.bare.rows[k];
    const d = bare ? String(lum(bare) - out.wantC[k]).padStart(9) : '        -';
    console.log(String(v).padStart(3), String(w).padStart(8), String(out.wantC[k]).padStart(6),
      cols.join(' '), d);
  }
  console.log('\n  v  滤镜后y(R G B)      LUT(y) → 应≈y');
  out.lutRows.forEach((r) => console.log(String(r[0]).padStart(3),
    String(r[1]).padStart(6), String(r[2]).padStart(4), String(r[3]).padStart(4),
    '   →', String(r[4]).padStart(5), String(r[5]).padStart(4), String(r[6]).padStart(4)));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
