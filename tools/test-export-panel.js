// 导出面板收敛（②）+ 选中元素联动面板（①）回归。
// 不依赖加载照片：导出面板的「保存到」行与 revealElementPanel 都是纯 DOM 操作，
// 直接用 App 暴露的方法断言即可。
// 用法: node tools/run-electron.js tools/test-export-panel.js
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

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// get-prefs 用可变变量承载，方便在用例里切换「无默认目录 / 有默认目录」两种状态。
let currentPrefs = { exportQuality: 92 };
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => currentPrefs);
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '31.7.7', chrome: '126.0.6478.234', node: '20.18.3',
    platform: 'win32', arch: 'x64', packaged: true, portable: false,
    osRelease: '10.0.22631', userData: 'C:\\Users\\lumos\\AppData\\Roaming\\qf-test', appPath: ROOT
}));
ipcMain.handle('open-external', () => ({ ok: true }));
ipcMain.handle('open-data-dir', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'pick-default-export-dir']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) {
            return new Response('NF', { status: 404 });
        }
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
        await new Promise(r => setTimeout(r, 250));
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // ── ① 导出面板「保存到」行存在 ──
    const rows = await exec(`(() => {
        return {
            hasPath: !!document.getElementById('epExportDirPath'),
            hasPick: !!document.getElementById('btnEpPickDir'),
            hasClear: !!document.getElementById('btnEpClearDir'),
            // ② 锚点：选中元素后要翻到这两个分组
            hasGrpCustomText: !!document.getElementById('grpCustomText'),
            hasGrpElManage: !!document.getElementById('grpElManage')
        };
    })()`);
    check(rows.hasPath && rows.hasPick && rows.hasClear, '导出弹层含「保存到」行（路径/更改/改回询问）');
    check(rows.hasGrpCustomText && rows.hasGrpElManage, '文字与 Logo 面板有定位锚点（grpCustomText / grpElManage）');

    // ── ② 无默认目录：显示「每次询问」，改回询问按钮禁用 ──
    currentPrefs = { exportQuality: 92 };
    await exec('window.App.refreshExportDirRow()');
    const none = await exec(`(() => {
        const p = document.getElementById('epExportDirPath');
        const c = document.getElementById('btnEpClearDir');
        return { text: p ? p.textContent : '', muted: p ? p.classList.contains('muted') : false, clearDisabled: c ? c.disabled : null };
    })()`);
    check(none.text === '每次询问' && none.muted && none.clearDisabled === true,
        '无默认目录：显示「每次询问」且禁用改回按钮', JSON.stringify(none));

    // ── ② 设了默认目录：显示路径，改回按钮可用 ──
    const dir = 'C:\\Users\\lumos\\Pictures\\qingframe-out';
    currentPrefs = { exportQuality: 92, defaultExportDir: dir };
    await exec('window.App.refreshExportDirRow()');
    const set = await exec(`(() => {
        const p = document.getElementById('epExportDirPath');
        const c = document.getElementById('btnEpClearDir');
        return { text: p ? p.textContent : '', muted: p ? p.classList.contains('muted') : true, clearDisabled: c ? c.disabled : null };
    })()`);
    check(set.text === dir && set.muted === false && set.clearDisabled === false,
        '设默认目录：显示路径且启用改回按钮', JSON.stringify(set));

    // ── ① 选中 Logo → 翻到 Logo 页签 ──
    const logoNav = await exec(`(() => {
        const before = document.getElementById('panel-logo').classList.contains('active');
        window.App.revealElementPanel('logo');
        return { before, after: document.getElementById('panel-logo').classList.contains('active') };
    })()`);
    check(!logoNav.before && logoNav.after, '选中 Logo：切换到 Logo 页签', JSON.stringify(logoNav));

    // ── ① 选中文字 → 翻到文字页签 ──
    const textNav = await exec(`(() => {
        window.App.revealElementPanel('text');
        return { textActive: document.getElementById('panel-text').classList.contains('active') };
    })()`);
    check(textNav.textActive, '选中文字：切换到文字页签', JSON.stringify(textNav));

    // ── ① 贴纸也归到 Logo 页签的元素管理 ──
    const stickerNav = await exec(`(() => {
        window.App.revealElementPanel('sticker');
        return { logoActive: document.getElementById('panel-logo').classList.contains('active') };
    })()`);
    check(stickerNav.logoActive, '选中贴纸：同样落到 Logo 页签（元素管理）', JSON.stringify(stickerNav));

    await win.close();
    app.quit();
    if (failures.length) { console.error('\n失败 ' + failures.length + ' 项'); process.exit(1); }
    console.log('\n全部通过');
    process.exit(0);
});

app.on('window-all-closed', () => {});
