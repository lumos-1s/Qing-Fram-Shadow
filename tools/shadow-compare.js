// 阴影 pass 的效果验证：同一张图、同一套 XMP，把「空间自适应阴影」与「不做阴影 /
// 旧全局表」逐像素对比 LR 的 tint=0 导出（同一预设，只把 tint 归零）。
//
// 为什么用 tint=0 那张：它和我们的参数只差 tint，其它（含 Shadows2012=-30）完全一致，
// 所以任何残差都归因于我们自己的实现，而不是"用户手改过预设"。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

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

// 把任意画布/文件重采样到 TW 宽：按整数分箱做面积平均（不是最近邻）。
// 最近邻会让 5905→1400 的缩图产生大量锯齿，逐像素 MAE 会被锯齿淹没，
// 变成"看得出差别但看不出方向"。
function loadRGB(file, TW) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const TH = Math.round(TW * img.height / img.width);
  const out = new Uint8Array(TW * TH * 3);
  for (let y = 0; y < TH; y++) {
    const sy0 = Math.floor(y * img.height / TH), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * img.height / TH));
    for (let x = 0; x < TW; x++) {
      const sx0 = Math.floor(x * img.width / TW), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * img.width / TW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * img.width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const s = row + sx * 4;
          r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2]; n++;
        }
      }
      const d = (y * TW + x) * 3;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d: out };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// k×k 分块平均：把两边的重采样差异、锯齿、局部纹理都磨掉，只剩色调形状
function soft(rgb, k) {
  const w = Math.floor(rgb.w / k), h = Math.floor(rgb.h / k);
  const d = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < k; j++) {
        const row = (y * k + j) * rgb.w;
        for (let i = 0; i < k; i++) {
          const s = (row + x * k + i) * 3;
          r += rgb.d[s]; g += rgb.d[s + 1]; b += rgb.d[s + 2];
        }
      }
      const n = k * k, o = (y * w + x) * 3;
      d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n;
    }
  }
  return { w, h, d };
}

// 按「参照图亮度」分带统计有符号差：负 = 我们更暗，正 = 我们更亮
function softDiff(ref, got) {
  const n = ref.w * ref.h;
  const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]].map((b) => ({
    lo: b[0], hi: b[1], n: 0, sum: 0, abs: 0
  }));
  let abs = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const lr = luma(ref.d[j], ref.d[j + 1], ref.d[j + 2]);
    const lg = luma(got.d[j], got.d[j + 1], got.d[j + 2]);
    const d = lg - lr;
    abs += Math.abs(d); sum += d;
    for (const b of bands) {
      if (lr >= b.lo && lr < b.hi) { b.n++; b.sum += d; b.abs += Math.abs(d); break; }
    }
  }
  return {
    abs: +(abs / n).toFixed(2),
    bias: +(sum / n).toFixed(2),
    bands: bands.map((b) => b.n ? `${(b.sum / b.n).toFixed(1)}±${(b.abs / b.n).toFixed(1)}` : '-')
  };
}

// 与参照图比：整体 MAE、按亮度分带的 MAE、分位数
function compare(ref, got) {
  const n = ref.w * ref.h;
  let mae = 0, maeL = 0;
  let rr = 0, rg = 0, rb = 0, gr = 0, gg2 = 0, gb = 0;
  const bands = [{ lo: 0, hi: 64, n: 0, s: 0 }, { lo: 64, hi: 128, n: 0, s: 0 },
    { lo: 128, hi: 192, n: 0, s: 0 }, { lo: 192, hi: 256, n: 0, s: 0 }];
  const Lr = [], Lg = [];
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const dr = got.d[j] - ref.d[j], dg = got.d[j + 1] - ref.d[j + 1], db = got.d[j + 2] - ref.d[j + 2];
    mae += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
    rr += ref.d[j]; rg += ref.d[j + 1]; rb += ref.d[j + 2];
    gr += got.d[j]; gg2 += got.d[j + 1]; gb += got.d[j + 2];
    const lr = luma(ref.d[j], ref.d[j + 1], ref.d[j + 2]);
    const lg = luma(got.d[j], got.d[j + 1], got.d[j + 2]);
    Lr.push(lr); Lg.push(lg);
    maeL += Math.abs(lg - lr);
    const band = bands[Math.min(3, (lr / 64) | 0)];
    band.n++; band.s += Math.abs(lg - lr);
  }
  Lr.sort((a, b) => a - b); Lg.sort((a, b) => a - b);
  const q = (arr, p) => Math.round(arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]);
  return {
    mae: +(mae / n / 3).toFixed(2),
    maeL: +(maeL / n).toFixed(2),
    bands: bands.map((b) => b.n ? +(b.s / b.n).toFixed(2) : null),
    rgb: [Math.round(rr / n), Math.round(rg / n), Math.round(rb / n)],
    gotRgb: [Math.round(gr / n), Math.round(gg2 / n), Math.round(gb / n)],
    q: [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => q(Lr, p)),
    gotQ: [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => q(Lg, p))
  };
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
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/jpeg', 0.98); });

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;   // 与 LR 的 tint=0 基准对齐

    const grab = () => {
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, data: Array.from(d.data), url: cv.toDataURL('image/jpeg', 0.95) };
    };

    const run = async (patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender(); await sleep(250);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(700);
      return grab();
    };

    const r = {};
    r.spatial = await run(base);
    const p0 = JSON.parse(JSON.stringify(base)); p0.sh = 0;
    r.none = await run(p0);
    // 旧行为对照：把阴影塞回全局色调表（等价于 sh 走 toneStages 的灰轴对角线）
    const saved = window.QfsShadows.applyCanvas;
    window.QfsShadows.applyCanvas = () => false;
    r.global = await run(base);
    window.QfsShadows.applyCanvas = saved;
    return { shots: r, ready: window.QfsShadows.ready(), info: window.QfsShadows.info() };
  })()`);

  const ref = loadRGB(LR, TW);
  const toRGB = (shot) => {
    const n = shot.w * shot.h;
    const d = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      d[i * 3] = shot.data[i * 4]; d[i * 3 + 1] = shot.data[i * 4 + 1]; d[i * 3 + 2] = shot.data[i * 4 + 2];
    }
    return { w: shot.w, h: shot.h, d };
  };

  console.log('阴影表就绪:', out.ready, JSON.stringify(out.info && {
    normalFrom: out.info.normalFrom, amounts: out.info.amounts, x: out.info.xCount, k: out.info.kCount
  }));
  const refSoft = soft(ref, 4);
  // 落盘：整图三份（空间阴影 / 去阴影 / LR 重采样），供人眼核对
  const outDir = path.join(ROOT, 'tools', 'out');
  const write = (name, url) => fs.writeFileSync(path.join(outDir, name), Buffer.from(url.split(',')[1], 'base64'));
  write('sh_spatial.jpg', out.shots.spatial.url);
  write('sh_none.jpg', out.shots.none.url);
  {
    const rgba = Buffer.alloc(ref.w * ref.h * 4);
    for (let i = 0; i < ref.w * ref.h; i++) {
      rgba[i * 4] = ref.d[i * 3]; rgba[i * 4 + 1] = ref.d[i * 3 + 1];
      rgba[i * 4 + 2] = ref.d[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    fs.writeFileSync(path.join(outDir, 'sh_lr.jpg'),
      jpeg.encode({ data: rgba, width: ref.w, height: ref.h }, 95).data);
  }
  console.log('LR 参照   :', JSON.stringify(compare(ref, ref)));
  for (const k of ['spatial', 'none', 'global']) {
    const s = out.shots[k];
    if (!s) { console.log(k, '失败'); continue; }
    const c = compare(ref, toRGB(s));
    const d = softDiff(refSoft, soft(toRGB(s), 4));
    console.log(k.padEnd(9), 'MAE', String(c.mae).padStart(6), '亮度MAE', String(c.maeL).padStart(6),
      'LR分位', c.q.join('/'), '我们', c.gotQ.join('/'));
    console.log(''.padEnd(9), '软差 abs', d.abs, '偏', d.bias, '分带(暗→亮)', d.bands.join(' | '));
    console.log(''.padEnd(9), 'LR均值', JSON.stringify(c.rgb), '我们均值', JSON.stringify(c.gotRgb));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
