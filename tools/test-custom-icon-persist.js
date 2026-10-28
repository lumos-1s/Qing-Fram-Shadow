// 验证:删除/重命名自定义图标真实写回磁盘 json(不再重启复活)
//
// 上一版把 delete/rename 的实现**在测试里重抄了一遍**当 mock,于是测的是 mock 而不是产品代码 ——
// 真实 handler 就地改 shared/custom-icons.json(打包后在 app.asar 里只读)这个 bug 被完美放过。
// 现在 handler 直接用 src/main/custom-icons.js,测试与产品共用同一份实现。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const { createCustomIconStore } = require(path.join(__dirname, '..', 'src', 'main', 'custom-icons.js'));

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-icon-persist-'));
const TMP = path.join(TMPDIR, 'custom-icons.json');           // userData 里的可写副本
const SEED = path.join(TMPDIR, 'seed.json');                   // 只读种子
const SEED_BEFORE = JSON.stringify([
    { name: '甲', dataUrl: 'data:image/png;base64,AAAA', custom: true },
    { name: '乙', dataUrl: 'data:image/png;base64,BBBB', custom: true }
]);
fs.writeFileSync(SEED, SEED_BEFORE, 'utf-8');

// 与 src/main/index.js 里完全相同的接法
const store = createCustomIconStore(TMP, SEED);

ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, n + '.json'), 'utf8')));
ipcMain.handle('load-all-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')) })));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('list-custom-icons', () => store.list());
ipcMain.handle('delete-custom-icon', (_e, d) => store.remove(d));
ipcMain.handle('rename-custom-icon', (_e, d, n) => store.rename(d, n));
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
    await App.loadLogos();
    await new Promise(r => setTimeout(r, 300));
    const customs = App.logos.filter(l => l.custom);
    console.log('LOADED_CUSTOMS:', customs.length, customs.map(c => c.name).join(','));
    if (customs.length !== 2) return 'FAIL 初始加载应为 2 个自定义图标';
    // 删除甲 —— 走 UI 同一条路径(App.deleteCustomIcon 内部会调真实 handler)
    const delRes = await App.deleteCustomIcon(customs[0]);
    console.log('DELETE_RESULT:', JSON.stringify(delRes));
    if (!delRes || delRes.ok !== true) return 'FAIL deleteCustomIcon 未报告成功: ' + JSON.stringify(delRes);
    const afterDel = await window.qingframe.listCustomIcons();
    console.log('AFTER_DEL:', afterDel.length, afterDel.map(c => c.name).join(','));
    // 重命名乙
    const renRes = await window.qingframe.renameCustomIcon('data:image/png;base64,BBBB', '乙新名');
    console.log('RENAME_RESULT:', JSON.stringify(renRes));
    const afterRen = await window.qingframe.listCustomIcons();
    console.log('AFTER_REN:', afterRen.length, afterRen.map(c => c.name).join(','));

    const okAll = afterDel.length === 1 && afterDel[0].name === '乙'
        && afterRen.length === 1 && afterRen[0].name === '乙新名';
    return okAll ? 'PASS 删除写盘+重命名写盘均生效' : 'FAIL 列表内容不符';
}
`;

let verdict = 'FAIL 未执行到断言';
app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try { const u = new URL(request.url); const fp = u.searchParams.get('p'); if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 }); return net.fetch(pathToFileURL(fp).href); }
        catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => { console.log('[page][' + level + ']', msg); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    try { verdict = await win.webContents.executeJavaScript('(' + CHECK + ')()'); }
    catch (e) { verdict = 'FAIL executeJavaScript 抛错: ' + (e && e.message); }
    console.log('RESULT: ' + verdict);

    // 种子必须逐字节不变 —— 证明写操作没再碰 shared/ 里的库文件
    const seedIntact = fs.readFileSync(SEED, 'utf-8') === SEED_BEFORE;
    console.log('SEED_UNTOUCHED:', seedIntact);
    if (!seedIntact) verdict = 'FAIL 种子文件被写了(应只写 userData 副本)';

    try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (e) {}
    // Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0
    app.exit(String(verdict).startsWith('PASS') ? 0 : 1);
});
