// 设置弹窗回归：默认导出位置的回显 / 选择 / 清除，以及「关于」瘦身后设置项的搬迁。
// 用法: node tools/run-electron.js tools/test-settings-ui.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 主进程侧可变的 prefs：设置页读到什么由这里决定，等价于用户改过设置
let prefsStub = {};
let savedPrefs = [];
let pickFail = false;
ipcMain.handle('get-prefs', () => prefsStub);
ipcMain.handle('save-prefs', (_e, p) => {
    savedPrefs.push(p);
    // 与主进程 saveState 一致：按字段合并，undefined 不覆盖
    if (p && typeof p === 'object') {
        const next = Object.assign({}, prefsStub);
        for (const [k, v] of Object.entries(p)) if (v !== undefined) next[k] = v;
        prefsStub = next;
    }
    return { ok: true };
});
ipcMain.handle('pick-default-export-dir', () => {
    // 模拟「主进程还是旧版」：Electron 会以 invoke 失败的形式抛回来
    if (pickFail) throw new Error("Error invoking remote method 'pick-default-export-dir': Error: No handler registered for 'pick-default-export-dir'");
    prefsStub = { defaultExportDir: 'E:\\导出' };
    return { ok: true, dir: 'E:\\导出' };
});
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.22', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: true, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));
ipcMain.handle('open-external', () => ({ ok: true }));
ipcMain.handle('open-data-dir', () => ({ ok: true }));
ipcMain.handle('copy-text', () => ({ ok: true }));
ipcMain.handle('save-diagnostics', () => ({ ok: true, path: 'x' }));
ipcMain.handle('check-for-updates', () => ({ ok: true }));
ipcMain.handle('start-update-download', () => ({ ok: true }));
ipcMain.handle('quit-and-install', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch',
    'pick-export-location', 'write-export-files']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({
        width: 1400, height: 900, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-about.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom)')) break;
        await sleep(250);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // ── A：结构 —— 设置项在设置弹窗里，关于弹窗已瘦身 ──
    const sA = await exec(`(() => {
        const inSettings = !!document.querySelector('#settingsModal #tfUpdateMirror');
        const inAbout = !!document.querySelector('#aboutModal #tfUpdateMirror');
        const hasGear = !!document.getElementById('btnSettings');
        const aboutToSettings = !!document.querySelector('#aboutModal #btnAboutOpenSettings');
        return { inSettings, inAbout, hasGear, aboutToSettings };
    })()`);
    check(sA.hasGear, '工具栏有「设置」按钮', JSON.stringify(sA));
    check(sA.inSettings && !sA.inAbout,
        '更新下载源已从「关于」搬到「设置」（同一 ID 只存在一份）', JSON.stringify(sA));
    check(sA.aboutToSettings, '关于里保留跳转设置的入口', JSON.stringify(sA));

    // ── B：未设置时显示「每次询问」，清除按钮禁用 ──
    await exec(`window.App.openSettings()`);
    await sleep(80);
    const sB = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return {
            open: document.getElementById('settingsModal').style.display,
            text: p.textContent,
            muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled
        };
    })()`);
    check(sB.open === 'flex', '设置弹窗可打开', JSON.stringify(sB));
    check(sB.text === '每次询问' && sB.muted, '未设置时显示「每次询问」', JSON.stringify(sB));
    check(sB.clearDisabled === true, '未设置时「改回每次询问」不可点', JSON.stringify(sB));

    // ── C：Esc 关闭并把焦点还给齿轮按钮 ──
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await sleep(120);
    const sC = await exec(`({ display: document.getElementById('settingsModal').style.display, focus: document.activeElement && document.activeElement.id })`);
    check(sC.display === 'none' && sC.focus === 'btnSettings', 'Esc 关闭并恢复焦点到设置按钮', JSON.stringify(sC));

    // ── D：已设置时回显真实路径，清除按钮可用 ──
    prefsStub = { defaultExportDir: 'D:' + path.sep + 'Photos' };
    await exec(`window.App.openSettings()`);
    await sleep(80);
    const sD = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return { text: p.textContent, muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled };
    })()`);
    check(sD.text === prefsStub.defaultExportDir && !sD.muted,
        '已设置时回显默认导出路径', JSON.stringify(sD));
    check(sD.clearDisabled === false, '已设置时「改回每次询问」可点', JSON.stringify(sD));

    // ── E：选择文件夹后立即回显 ──
    await exec(`window.App.chooseDefaultExportDir()`);
    await sleep(120);
    const sE = await exec(`document.getElementById('setExportDirPath').textContent`);
    check(sE === 'E:' + path.sep + '导出', '选择文件夹后立即回显新路径', sE);

    // ── F：清除 → 写回空串，面板回到「每次询问」 ──
    savedPrefs = [];
    await exec(`window.App.clearDefaultExportDir()`);
    await sleep(120);
    const sF = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return { text: p.textContent, muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled };
    })()`);
    check(savedPrefs.some(p => p && p.defaultExportDir === ''),
        '清除时把默认导出位置写成空串（回落到每次询问）', JSON.stringify(savedPrefs));
    check(sF.text === '每次询问' && sF.muted && sF.clearDisabled === true,
        '清除后面板回到「每次询问」', JSON.stringify(sF));

    // ── G：主进程缺少新接口时不能说「没反应」，要给出可操作的提示 ──
    // 复现用户现场：旧 electron.exe 还活着（主进程旧），页面却是新的
    pickFail = true;
    await exec(`window.App.chooseDefaultExportDir()`);
    await sleep(100);
    const sG = await exec(`({
        msg: window.App.statusMsg || '',
        path: document.getElementById('setExportDirPath').textContent
    })`);
    check(/重启/.test(sG.msg),
        '接口不可用时提示「重启应用」而不是静默', JSON.stringify(sG));
    check(sG.path === '每次询问',
        '接口不可用时不会把已有设置改坏', JSON.stringify(sG));
    pickFail = false;

    if (failures.length) {
        console.error('\n设置页检查失败: ' + failures.length);
        failures.forEach(f => console.error(' - ' + f));
        app.exit(1);
    } else {
        console.log('\n设置页检查全部通过');
        app.exit(0);
    }
}).catch((e) => {
    console.error((e && e.stack) || e);
    app.exit(2);
});
