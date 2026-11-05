const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsColor && window.QfsAcr)')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const r = await w.webContents.executeJavaScript(`(async () => {
    if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (e) { return { err: String(e) }; } }
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    return {
      usingGL: !!(window.QfsColor && window.QfsColor.usingGL && window.QfsColor.usingGL()),
      acrReady: !!(window.QfsAcr && window.QfsAcr.ready && window.QfsAcr.ready()),
      rawGL: !!gl,
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
      qfsMix: !!window.QfsMix,
    };
  })()`);
  console.log('环境:', JSON.stringify(r));
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
