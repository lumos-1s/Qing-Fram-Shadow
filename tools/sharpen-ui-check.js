// UI 冒烟：锐化那四个滑块是否绑上了、拖动是否真的改参数并重烘、标签格式对不对。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
ipcMain.handle('load-acr-tables', () => ({ size: 17, count: 0, step: 3, data: new ArrayBuffer(0) }));
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
    const w = new BrowserWindow({
        show: false, width: 1200, height: 800,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
    });
    const errs = [];
    w.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 80; i++) {
        if (await w.webContents.executeJavaScript('!!(window.App && window.App.initGradeExtra)')) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    const out = await w.webContents.executeJavaScript(`(async () => {
      const A = window.App;
      const $ = (id) => document.getElementById(id);
      const ids = ['slDetShp', 'slDetShr', 'slDetShd', 'slDetShm'];
      const present = ids.map((id) => !!$(id));
      // 挂一张假图，让 setGrade 有落点
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 400, 300);
      const im = { name: 't', el: c, w: 400, h: 300, exif: {} };
      A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
      A.template = A.defaultTemplate(); A.ensureGrade(im); A.syncGradeExtraUI(A.gradeOf(im));
      const before = { p: A.gradeOf(im).det, lbl: $('lblDetShp') && $('lblDetShp').textContent };
      // 模拟拖滑块
      $('slDetShp').value = '60';
      $('slDetShp').dispatchEvent(new Event('input'));
      $('slDetShr').value = '0.8';
      $('slDetShr').dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      const after = { det: A.gradeOf(im).det, lblShp: $('lblDetShp').textContent, lblShr: $('lblDetShr').textContent };
      // 再同步一次 UI（模拟切图回来）
      A.syncGradeExtraUI(A.gradeOf(im));
      const synced = { shp: $('slDetShp').value, shr: $('slDetShr').value, lblShr: $('lblDetShr').textContent };
      return { present, before, after, synced };
    })()`);
    console.log('四个滑块存在:', JSON.stringify(out.present));
    console.log('初始 det:', JSON.stringify(out.before.p), '标签', out.before.lbl);
    console.log('拖后 det:', JSON.stringify(out.after.det));
    console.log('拖后标签:', out.after.lblShp, '/', out.after.lblShr);
    console.log('回填 UI :', JSON.stringify(out.synced));
    if (errs.length) console.log('控制台错误:', errs.slice(0, 4).join(' | '));
    app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
