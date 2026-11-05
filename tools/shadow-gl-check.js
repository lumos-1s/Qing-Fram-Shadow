// 阴影 shader 与逐像素实现的等价性 + 耗时对比。
//
// 同一个源画布复制两份：一份走 app-acr-shadows 的 applyCanvas（CPU），
// 一份走 QfsShadows.prepare + QfsColor.pass（GL）。逐像素比对 RGB 差值，
// 并分别计时。任何一次改阴影公式，这个脚本都应当给出「最大差 ≤1」。
//
// 用法：
//   node tools/run-electron.js tools/shadow-gl-check.js
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" node tools/run-electron.js tools/shadow-gl-check.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.QF_IMG || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-shadows', () => {
  const raw = fs.readFileSync(SHD);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    const ok = await w.webContents.executeJavaScript('!!(window.QfsShadows && window.QfsColor)');
    if (ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
    const res = { gl: window.QfsColor.canShadow(), cases: [] };
    if (!res.gl) return res;
    await window.QfsShadows.ensure();
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const FULL_W = raw.naturalWidth, FULL_H = raw.naturalHeight;

    for (const W of [1600, FULL_W]) {
      const H = W === FULL_W ? FULL_H : Math.round(W * FULL_H / FULL_W);
      // 模拟 bakeOne 的输入：先过一遍色调（这里用等价的 CSS 滤镜近似），
      // 两份画布必须逐字节一致，否则比的不是同一条输入。
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.filter = 'brightness(1.02) contrast(1.05) saturate(1.05)';
        g.drawImage(raw, 0, 0, W, H);
        g.filter = 'none';
        return c;
      };
      const a = mk(), b = mk();
      const key = 'glcheck|' + W;

      // ① CPU（冷启动：场要算）
      const t1 = performance.now();
      window.QfsShadows.applyCanvas(a, -30, key);
      const cpuCold = performance.now() - t1;
      // ② CPU（暖：场命中）
      const t2 = performance.now();
      window.QfsShadows.applyCanvas(mk(), -30, key);
      const cpuWarm = performance.now() - t2;

      // ③ GL（场已命中，只上传纹理 + 跑一遍）
      const t3 = performance.now();
      const sh = window.QfsShadows.prepare(b, -30, key, false);
      const outC = window.QfsColor.pass(b, {}, W, H, null, null, sh);
      const glMs = performance.now() - t3;

      if (!outC) { res.cases.push({ W, error: 'pass returned null' }); continue; }

      // GL 的输出画布是 WebGL 上下文，取不到 2D context，先落到一张普通画布上再比
      const flat = document.createElement('canvas');
      flat.width = W; flat.height = H;
      flat.getContext('2d').drawImage(outC, 0, 0);
      const A = a.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      const B = flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      let max = 0, sum = 0, over1 = 0, over2 = 0, n = 0;
      // 只统计真正被阴影改过的像素：两边都没动的位置没有比较意义
      for (let i = 0; i < A.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(A[i + k] - B[i + k]);
          if (d > max) max = d;
          sum += d; n++;
          if (d > 1) over1++;
          if (d > 2) over2++;
        }
      }
      res.cases.push({
        W, size: W + 'x' + H,
        cpuCold: +cpuCold.toFixed(1), cpuWarm: +cpuWarm.toFixed(1), gl: +glMs.toFixed(1),
        speedup: +(cpuWarm / Math.max(0.01, glMs)).toFixed(0),
        maxDiff: max, meanDiff: +(sum / n).toFixed(4),
        pctOver1: +(100 * over1 / n).toFixed(3), pctOver2: +(100 * over2 / n).toFixed(3)
      });
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  if (!out.gl) {
    console.log('SKIP  这台机器拿不到 WebGL 浮点纹理，阴影走的是逐像素兜底路径');
  } else {
    const bad = out.cases.filter((c) => c.error || c.maxDiff > 1);
    if (bad.length) {
      console.log('FAIL  阴影 shader 与逐像素实现不一致:', JSON.stringify(bad));
      app.exit(1);
      return;
    }
    console.log('PASS  shader 与逐像素的最大差 ≤1 级（8 位取整）');
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
