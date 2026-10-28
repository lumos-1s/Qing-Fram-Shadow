// 验证:btnGridExport 按钮点击是否真的绑定到 exportGridCrop
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
    await new Promise(r => setTimeout(r, 300));

    const btn = document.getElementById('btnGridExport');
    if (!btn) return 'FAIL btnGridExport 不存在';

    // 打桩计数:点击后 exportGridCrop 是否被调用
    let called = 0;
    const orig = App.exportGridCrop;
    if (typeof orig !== 'function') return 'FAIL App.exportGridCrop 不是函数';
    App.exportGridCrop = function () { called++; return orig.apply(this, arguments); };
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    App.exportGridCrop = orig;
    if (called === 0) return 'FAIL 点击未触发 exportGridCrop';
    return 'PASS 点击触发 exportGridCrop (' + called + '次)';
}
`;

// 退出码账本:上一版把 RESULT 打进控制台就 app.quit(),点没绑上都 exit 0。
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
    if (typeof r !== 'string' || !r.startsWith('PASS')) fails.push(String(r));
    console.log(fails.length ? '✗ ' + fails.length + ' 项不通过:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
});
