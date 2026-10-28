// 验证五优化 UI 控件与绑定存在
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, n + '.json'), 'utf8')));
ipcMain.handle('load-all-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')) })));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, dir: 'TEST' }));
ipcMain.handle('write-export-files', () => ({ ok: 9, fail: 0 }));

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await new Promise(r => setTimeout(r, 400));
    const ids = ['selGridRender', 'slGridPad', 'lblGridPad', 'cbGridSubdir', 'gridPreviewZoom', 'gridPreviewZoomImg', 'gridPreviewZoomCap', 'btnGridZoomBack'];
    const missing = ids.filter(id => !document.getElementById(id));
    const fns = ['gridRenderMax', 'gridPad', 'gridSubdir', 'loadGridPrefs', 'saveGridPrefs'].filter(n => typeof App[n] !== 'function');
    const opts = document.getElementById('selGridRender') ? Array.from(document.getElementById('selGridRender').options).map(o => o.value) : [];
    console.log('UI_MISSING:', missing.length ? missing.join(',') : 'none');
    console.log('FN_MISSING:', fns.length ? fns.join(',') : 'none');
    console.log('RENDER_OPTS:', opts.join('/'));
    console.log('PAD_MAX:', document.getElementById('slGridPad') ? document.getElementById('slGridPad').max : 'n/a');
    // 模拟记忆:设置值→save→load 回读
    const s = document.getElementById('selGridRender'); if (s) s.value = '4000';
    const p = document.getElementById('slGridPad'); if (p) p.value = '8';
    const cb = document.getElementById('cbGridSubdir'); if (cb) cb.checked = true;
    App.saveGridPrefs();
    const v = localStorage.getItem('qfs-grid-prefs');
    console.log('SAVED_PREFS:', v || 'null');
    s.value = '3000'; p.value = '0'; cb.checked = false;
    App.loadGridPrefs();
    console.log('RESTORED:', s.value, p.value, cb.checked);
    const problems = [];
    if (missing.length) problems.push('缺 DOM: ' + missing.join(','));
    if (fns.length) problems.push('缺方法: ' + fns.join(','));
    if (s.value !== '4000') problems.push('selGridRender 未回读: ' + s.value);
    if (p.value !== '8') problems.push('slGridPad 未回读: ' + p.value);
    if (cb.checked !== true) problems.push('cbGridSubdir 未回读');
    // 别把 subdir=true 留给同源的兄弟测试(它们会照着子目录命名而误判)
    s.value = '3000'; p.value = '0'; cb.checked = false; App.saveGridPrefs();
    return problems.length ? 'FAIL ' + problems.join(' | ') : 'PASS';
}
`;

// 退出码账本:上一版只把 RESULT 打进控制台就 app.quit(),通过与否和退出码无关。
const fails = [];
app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try { const u = new URL(request.url); const fp = u.searchParams.get('p'); if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 }); return net.fetch(pathToFileURL(fp).href); }
        catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => { console.log('[page][' + level + ']', msg); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    let r;
    try { r = await win.webContents.executeJavaScript('(' + CHECK + ')()'); }
    catch (e) { r = 'FAIL executeJavaScript 抛错: ' + (e && e.message); }
    console.log('RESULT:', r);
    if (r !== 'PASS') fails.push(String(r));
    console.log(fails.length ? '✗ ' + fails.length + ' 项不通过:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
});
