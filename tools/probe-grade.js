// 探针：对比 mapXmp 产出的 patch 与 setGrade 后实际存下的 im.grade
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-250Z-7bc108c8.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';

const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
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
    const im = { name: 'raw', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.template.photoFrameStyle = 'SIMPLE';
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await A.flushRender(); await sleep(300);

    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    const mapped = window.AppXmp.mapXmp(${JSON.stringify(xmpText)});
    A.setGrade(mapped.patch, { replace: true, full: true });
    await A.flushRender(); await sleep(1200);

    const g = im.grade || {};
    const brief = {};
    for (const k of Object.keys(g)) {
      const v = g[k];
      if (Array.isArray(v)) brief[k] = 'Array(' + v.length + ') first=' + JSON.stringify(v[0]) + ' last=' + JSON.stringify(v[v.length - 1]);
      else if (v && typeof v === 'object') brief[k] = JSON.stringify(v).slice(0, 240);
      else brief[k] = v;
    }
    return { patchKeys: Object.keys(mapped.patch), gradeKeys: Object.keys(g), brief,
             neutral: !!(im._grade && im._grade.neutral), hasFull: !!(im._grade && im._grade.canvas) };
  })()`);

  console.log('patchKeys:', out.patchKeys.join(', '));
  console.log('gradeKeys:', out.gradeKeys.join(', '));
  console.log('丢了:', out.patchKeys.filter(k => !out.gradeKeys.includes(k)).join(', ') || '(无)');
  console.log('neutral:', out.neutral, ' 已烘全图:', out.hasFull);
  for (const [k, v] of Object.entries(out.brief)) console.log('  ', k, '=', v);
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
