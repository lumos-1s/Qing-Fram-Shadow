const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const mode = process.env.GLMODE || 'a';
if (mode === 'a') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
if (mode === 'b') {
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
if (mode === 'c') {
  app.commandLine.appendSwitch('use-gl', 'desktop');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: mode === 'd', width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false } });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 3000));
  const r = await w.webContents.executeJavaScript(`(() => {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    return { gl: !!gl, renderer: gl ? gl.getParameter(gl.RENDERER) : null, usingGL: !!(window.QfsColor && window.QfsColor.usingGL && window.QfsColor.usingGL()) };
  })()`);
  console.log('模式', mode, JSON.stringify(r));
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
