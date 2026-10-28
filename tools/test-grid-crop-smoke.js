// 冒烟:九宫格切图链路 —— 加载完整 UI,注入测试图,调 exportGridCrop,断言走到选目录/写盘
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

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
// 切图走的关键 IPC:选目录(不取消) + 批量写盘(9张)
// 退出码账本。Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0。
// 上一版这里的 throw 全被渲染层 exportGridCrop 的 catch 吃掉,测试永远 exit 0 ——
// 断言必须记到 fails 里,由 finish() 决定退出码。
const fails = [];
function finish(extra) {
    if (extra) fails.push(extra);
    console.log(fails.length ? '✗ ' + fails.length + ' 项不通过:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
}
let wroteNames = null;
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, path: 'TEST-DIR' }));
ipcMain.handle('write-export-files', (_e, payload) => {
    const files = (payload && payload.files) || [];
    const names = files.map(f => f.filename);
    console.log('[mock] writeExportFiles 收到 ' + files.length + ' 张: ' + names.join(', '));
    if (files.length !== 9) fails.push('写盘张数=' + files.length + '(期望9)');
    for (const n of names) { if (!n) fails.push('存在缺 filename 的条目'); }
    const sizes = files.map(f => f.data ? f.data.length : 0);
    if (sizes.some(s => s <= 0)) fails.push('存在空 data');
    if (sizes.length) console.log('[mock] 9 张 data 长度(近似大小): ' + sizes.map(s => (s / 1024).toFixed(0) + 'K').join(' '));
    wroteNames = names;
    return { ok: files.length, fail: 0 };
});

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await new Promise(r => setTimeout(r, 300)); // 等初始化渲染管线

    // 注入一张测试图
    const c = document.createElement('canvas'); c.width = 900; c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#c06030'; g.fillRect(0, 0, 900, 1200);
    g.fillStyle = '#fff'; g.font = 'bold 90px Arial'; g.fillText('T', 380, 600);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
    const im = { el: img, name: '测试照片.png', w: 900, h: 1200, exif: {}, customSettings: null };
    App.images = [im]; App.currentIdx = 0; App.image = im;
    App.template = App.defaultTemplate ? App.defaultTemplate() : { style: 'NONE', exif: { brand: 'TEST' } };
    const sub = document.getElementById('cbGridSubdir'); if (sub) sub.checked = false;
    if (App.saveGridPrefs) App.saveGridPrefs();

    // 先验证右侧栏新按钮与预览 modal 存在(九宫格已从工具栏迁入右侧栏)
    for (const id of ['btnGridExport', 'btnGridPreview', 'gridPreviewModal', 'selGridSize']) {
        if (!document.getElementById(id)) return 'FAIL 缺少 DOM:' + id;
    }
    console.log('btnGridExport/btnGridPreview/gridPreviewModal/selGridSize 存在 ✓');

    // 调用切图(不走真实点击,直接调方法,捕获异常)
    let err = null;
    try {
        await App.exportGridCrop();
    } catch (e) { err = e; }
    await new Promise(r => setTimeout(r, 600));
    if (err) return 'FAIL exportGridCrop 抛错 -> ' + err.message;
    const st = document.getElementById('statusText') || {};
    const sb = document.querySelector('#statusbar') || {};
    console.log('exportGridCrop 调用完成, 状态栏: "' + (st.textContent || sb.textContent || '') + '"');

    // 回归:导出结束后进度条/取消按钮必须收干净(提前 return 会残留"写盘 9/9")
    const bar = document.getElementById('exportProgressBar');
    const cancel = document.getElementById('btnCancelExport');
    const fill = document.getElementById('exportProgressFill');
    const prog = document.getElementById('exportProgress');
    if (prog && prog.style.display !== 'none') return 'FAIL 进度条容器未隐藏(display=' + prog.style.display + ')';
    if (cancel && cancel.style.display !== 'none') return 'FAIL 取消按钮未隐藏(display=' + cancel.style.display + ')';
    if (bar && fill && fill.style.width !== '0%') return 'FAIL 进度条未复位(width=' + fill.style.width + ')';
    console.log('进度条/取消按钮已复位 ✓');
    return 'PASS-RENDER';
}
`;

app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try {
            const u = new URL(request.url);
            const fp = u.searchParams.get('p');
            if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 });
            return net.fetch(pathToFileURL(fp).href);
        } catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => { console.log('[page:' + level + ']', msg); });
    win.webContents.on('did-fail-load', (_e, code, desc) => { console.log('[did-fail-load]', code, desc); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    const r = await win.webContents.executeJavaScript('(' + CHECK + ')()').catch(e => 'EXEC-ERR: ' + (e && e.message));
    console.log('EXEC-RESULT:', typeof r === 'string' ? r : (r || '(undefined)'));
    if (typeof r === 'string' && r.startsWith('FAIL')) fails.push(r);
    else if (r !== 'PASS-RENDER') fails.push('渲染层未给出结论:' + String(r));
    if (!wroteNames) fails.push('write-export-files 从未被调用');
    else {
        if (wroteNames[0] !== '测试照片_九宫格_1.jpg' || wroteNames[8] !== '测试照片_九宫格_9.jpg') fails.push('命名错误: ' + wroteNames[0] + '..' + wroteNames[8]);
    }
    finish();
});
