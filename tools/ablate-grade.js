// 分段排除：逐组关闭调色阶段，看哪一段把结果推离 LR 最远
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg';

const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');


app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 160; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsColor)')) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    await A.flushRender(); await sleep(400);

    console.log('ENV', JSON.stringify({gl: !!(window.QfsColor && window.QfsColor.usingGL()), acr: !!(window.QfsAcr && window.QfsAcr.ready())}));
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;

    const measure = () => {
      // 直接量烘焙全图（纯调色结果，不含模板底板）
      const b = im._grade && im._grade.canvas;
      if (!b) return null;
      const W = 900, H = Math.round(900 * b.height / b.width);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(b, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      let r = 0, gg = 0, bb = 0, n = 0, sa = 0; const L = [];
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        r += R; gg += G; bb += B; n++;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        sa += mx > 0 ? (mx - mn) / mx : 0;
        L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
      }
      L.sort((a, b2) => a - b2);
      const q = (p) => Math.round(L[Math.floor(L.length * p)] || 0);
      return { rgb: [Math.round(r / n), Math.round(gg / n), Math.round(bb / n)], lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((sa / n) * 100).toFixed(1) };
    };

    const run = async (label, patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender();
      await sleep(900);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(1200);
      return { label, ...measure() };
    };

    const no = (keys) => { const p = JSON.parse(JSON.stringify(base)); keys.forEach(k => delete p[k]); return p; };
    const results = [];
    results.push(await run('全参数', base));
    results.push(await run('去掉曲线', no(['curve'])));
    results.push(await run('去曲线+黑白场', no(['curve', 'black', 'white'])));
    results.push(await run('去曲线+黑白场+高光阴影', no(['curve', 'black', 'white', 'hi', 'sh'])));
    results.push(await run('去曲线+HSL混色器', no(['curve', 'mix'])));
    results.push(await run('去曲线+校准', no(['curve', 'cal'])));
    results.push(await run('只保留曲线', { curve: base.curve }));
    return results;
  })()`);

  // 读 LR 目标
  const jpeg = require('jpeg-js');
  const img = jpeg.decode(fs.readFileSync(LR), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const W = 900, H = Math.round(900 * img.height / img.width);
  const c = Buffer.alloc(W * H * 4);
  const d = img.data, iw = img.width, ih = img.height;
  let r = 0, g = 0, b = 0, n = 0, sa = 0; const L = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sxp = Math.floor(x * iw / W), syp = Math.floor(y * ih / H);
      const i = (syp * iw + sxp) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sa += mx > 0 ? (mx - mn) / mx : 0;
      L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
  }
  L.sort((a, b2) => a - b2);
  const q = (p) => Math.round(L[Math.floor(L.length * p)] || 0);
  const target = { label: '★ LR 目标', rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((sa / n) * 100).toFixed(1) };

  const dist = (a) => Math.sqrt(
    a.rgb.reduce((s, v, i) => s + (v - target.rgb[i]) ** 2, 0) / 3 +
    a.lv.reduce((s, v, i) => s + (v - target.lv[i]) ** 2, 0) / 5 * 0.5 +
    (a.sat - target.sat) ** 2 * 0.5
  );

  const all = [...out, target];
  console.log('方案'.padEnd(22), '平均RGB'.padEnd(16), '亮度 5/25/50/75/95'.padEnd(24), '饱和', ' 偏差');
  for (const x of all) {
    const dd = x.label.startsWith('★') ? '—' : dist(x).toFixed(1);
    console.log(x.label.padEnd(20), JSON.stringify(x.rgb).padEnd(16), x.lv.join('/').padEnd(24), String(x.sat).padStart(5), String(dd).padStart(7));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
