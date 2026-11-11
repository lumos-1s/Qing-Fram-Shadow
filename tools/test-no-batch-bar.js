// 回归：缩略图多选 / Ctrl+A 全选后，画布下方不再弹出那条浮动操作条。
//
// 旧行为：buildThumbnails() 在 batchSel > 1 时把 #batchBar（「已选 N 张 / 应用当前样式 /
// 取消」）显示出来，它 absolute 定位在 bottom:80px，正好压在照片下沿。用户反馈要取消它。
// 能力没有丢：批量同步走顶栏「同步到选中」/ Ctrl+D，批量删除走右键菜单 / Delete，
// 取消多选走单击任一缩略图或再按一次 Ctrl+A。
//
// 用法：node tools/run-electron.js tools/test-no-batch-bar.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(c, () => ({ ok: true }));
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.26', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

async function main() {
    const win = new BrowserWindow({
        width: 1280, height: 800, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500); win.showInactive();
    const exec = (x) => win.webContents.executeJavaScript(x);
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1100);

    const r = await exec(`(async () => {
        const A = window.App;
        const imgs = [];
        for (let k = 0; k < 4; k++) {
            const c = document.createElement('canvas'); c.width = 400; c.height = 300;
            const g = c.getContext('2d'); g.fillStyle = ['#3c6','#36c','#c63','#c3c'][k]; g.fillRect(0, 0, 400, 300);
            const el = new Image();
            await new Promise((r2) => { el.onload = r2; el.onerror = r2; el.src = c.toDataURL('image/png'); });
            imgs.push({ el, name: 'p' + k + '.png', path: null, w: 400, h: 300, exif: {}, customSettings: null });
        }
        A.images = imgs; A.image = imgs[0]; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate(); A.setTpl(imgs[0], A.template);
        A.updateEmptyState(); A.buildThumbnails(); A.scheduleRender(true);
        await new Promise((r2) => setTimeout(r2, 350));
        const key = (mods) => document.dispatchEvent(new KeyboardEvent('keydown',
            Object.assign({ key: 'a', bubbles: true, cancelable: true }, mods)));

        const dom = { bar: document.querySelectorAll('#batchBar, .batch-bar, .batch-bar-btn').length,
            syncBtn: !!document.getElementById('btnSyncSel'),
            syncDisabled: !!(document.getElementById('btnSyncSel') || {}).disabled };
        key({ ctrlKey: true });
        await new Promise((r2) => setTimeout(r2, 220));
        const sel = { n: A.batchSel.length, all: A.batchSel.join(','),
            barAfter: document.querySelectorAll('#batchBar, .batch-bar, .batch-bar-btn').length,
            floating: Array.from(document.querySelectorAll('#canvasPane, #canvasPane *'))
                .filter((e) => e.classList && e.classList.contains('batch-bar')).length,
            status: A.statusMsg || '',
            thumbs: document.querySelectorAll('#thumbStrip .thumb-item').length };
        // 再按一次 Ctrl+A 取消全选
        key({ ctrlKey: true });
        await new Promise((r2) => setTimeout(r2, 180));
        const off = { n: A.batchSel.length, status: A.statusMsg || '' };
        // 多选 3 张（勾选 checkbox）后，也不该冒出浮层
        for (const i of [0, 1, 2]) A.toggleBatch(i);
        await new Promise((r2) => setTimeout(r2, 180));
        const partial = { n: A.batchSel.length,
            barAfter: document.querySelectorAll('#batchBar, .batch-bar, .batch-bar-btn').length };
        // 单击任一缩略图能清空多选（原先靠浮层上的「取消」按钮）
        A.selectImage(1);
        await new Promise((r2) => setTimeout(r2, 180));
        const cleared = { n: A.batchSel.length, idx: A.currentIdx,
            barAfter: document.querySelectorAll('#batchBar, .batch-bar, .batch-bar-btn').length };
        return { dom, sel, off, partial, cleared };
    })()`);

    check(r.dom.bar === 0, '页面里已没有多选浮动操作条（DOM 与样式一并移除）', `matched=${r.dom.bar}`);
    check(r.dom.syncBtn && !r.dom.syncDisabled, '顶栏「同步到选中」仍在且可用',
        `btn=${r.dom.syncBtn} disabled=${r.dom.syncDisabled}`);
    check(r.sel.n === 4 && r.sel.all === '0,1,2,3', 'Ctrl+A 仍然全选 4 张缩略图',
        `batchSel=${r.sel.all}`);
    check(r.sel.barAfter === 0 && r.sel.floating === 0 && r.sel.status.indexOf('已全选 4 张') >= 0,
        '全选后不再弹小窗，状态栏仍给出「已全选 4 张」提示',
        `bar=${r.sel.barAfter} floating=${r.sel.floating} status=${r.sel.status}`);
    check(r.off.n === 0 && r.off.status.indexOf('已取消全选') >= 0,
        '再按一次 Ctrl+A 仍能取消全选', `n=${r.off.n} status=${r.off.status}`);
    check(r.partial.n === 3 && r.partial.barAfter === 0,
        '手动多选 3 张时同样不弹浮层', `n=${r.partial.n} bar=${r.partial.barAfter}`);
    check(r.cleared.n === 1 && r.cleared.idx === 1 && r.cleared.barAfter === 0,
        '单击任一缩略图即可清空多选（替代原浮层的「取消」按钮）',
        `n=${r.cleared.n} idx=${r.cleared.idx}`);

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });
