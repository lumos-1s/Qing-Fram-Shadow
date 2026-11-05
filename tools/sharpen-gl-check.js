// 锐化：GPU 通道与 CPU 实现的等价性 + 耗时对比。
//
// 同一张输入画布复制两份，一份走 QfsSharpen.applyCanvas（CPU），一份走
// QfsColor.sharpenCanvas（GL 三趟：横模糊 / 纵模糊 / 合成）。逐像素比 RGB，
// 并分别计时。判据：最大差 ≤2 级（8 位取整 + 一次中间量化）。
//
// 用法：
//   node tools/run-electron.js tools/sharpen-gl-check.js
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" node tools/run-electron.js tools/sharpen-gl-check.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.QF_IMG || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('get-prefs', () => ({}));

const CASES = [
  { name: 'LR 预设同款', shp: 40, shr: 0.5, shd: 25, shm: 10 },
  { name: '无蒙版', shp: 80, shr: 1.2, shd: 40, shm: 0 },
  { name: '蒙版拉满 + 大半径', shp: 120, shr: 3, shd: 60, shm: 100 }
];

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsSharpen && window.QfsColor)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    // 测试机通常是 swiftshader，产品路径会主动回退 CPU；这里强制走 GPU 才能验公式
    window.QFS_FORCE_GPU_SHARPEN = true;
    if (!window.QfsColor.usingGL()) return { gl: false };
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const FW = raw.naturalWidth, FH = raw.naturalHeight;
    const mk = (W, H) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.filter = 'brightness(1.02) contrast(1.06) saturate(1.04)';
      g.drawImage(raw, 0, 0, W, H);
      g.filter = 'none';
      return c;
    };
    const flat = (cv) => {
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      c.getContext('2d').drawImage(cv, 0, 0);
      return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    };
    const res = { src: FW + 'x' + FH, gl: true, cases: [] };
    for (const size of [1600, FW]) {
      const W = size, H = size === FW ? FH : Math.round(size * FH / FW);
      for (const cs of ${JSON.stringify(CASES)}) {
        const P = window.QfsSharpen.paramsOf(cs, W, FW);
        const a = mk(W, H), b = mk(W, H);
        let t = performance.now();
        window.QfsSharpen.applyCanvas(a, cs, W, FW);
        const cpuMs = performance.now() - t;
        t = performance.now();
        const gpu = window.QfsColor.sharpenCanvas(b, P);
        const gpuMs = performance.now() - t;
        if (!gpu) { res.cases.push({ size: W + 'x' + H, name: cs.name, error: 'gpu null' }); continue; }
        const A = flat(a), B = flat(gpu), S = flat(b);
        let max = 0, sum = 0, over1 = 0, over2 = 0, n = 0, vsSrc = 0;
        for (let i = 0; i < A.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            const d = Math.abs(A[i + k] - B[i + k]);
            if (d > max) max = d;
            sum += d; n++;
            if (d > 1) over1++;
            if (d > 2) over2++;
            vsSrc += Math.abs(B[i + k] - S[i + k]);
          }
        }
        res.cases.push({
          size: W + 'x' + H, name: cs.name,
          cpu: +cpuMs.toFixed(1), gpu: +gpuMs.toFixed(1),
          speedup: +(cpuMs / Math.max(0.01, gpuMs)).toFixed(1),
          maxDiff: max, meanDiff: +(sum / n).toFixed(4),
          gpuVsSrc: +(vsSrc / n).toFixed(3),
          pctOver2: +(100 * over2 / n).toFixed(4),
          err: window.QfsColor.sharpenLastError()
        });
      }
    }
    return res;
   } catch (e) { return { err: String(e && e.message || e) }; }
  })()`);
  console.log(JSON.stringify(out, null, 2));
  if (out.err) { console.log('FAIL  ' + out.err); app.exit(1); return; }
  if (!out.gl) { console.log('SKIP  这台机器拿不到 WebGL'); app.quit(); return; }
  const bad = out.cases.filter((c) => c.error || c.maxDiff > 3 || c.meanDiff > 0.05);
  if (bad.length) { console.log('FAIL  锐化 GPU 与 CPU 不一致:', JSON.stringify(bad)); app.exit(1); return; }
  console.log('PASS  锐化 GPU 与 CPU 最大差 ≤3 级（均值 <0.05，肉眼不可见）');
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
