// 侧栏窄宽度布局回归：拼图 12 宫格按钮在最小宽度(260)下不得横向溢出。
// 之前是固定 4 列，260px 时溢出 52px、最后一列被卡片裁掉；现在按容器宽度退 3 列。
// 用法：node tools/run-electron.js tools/test-inspector-fit.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const c = document.createElement('canvas'); c.width = 900; c.height = 600;
    const g = c.getContext('2d'); g.fillStyle = '#8aa'; g.fillRect(0, 0, 900, 600);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    const im = { el, name: 'p', path: null, w: 900, h: 600, exif: {}, customSettings: null, grade: null };
    A.images = [im]; A.image = im; A.currentIdx = 0;
    A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
    if (A.refreshUI) A.refreshUI();
    A.switchTab('puzzle');
    await new Promise((r) => setTimeout(r, 400));
    const insp = document.getElementById('inspector');
    const box = document.getElementById('puzzleLayouts');
    if (!box) return { missing: true };
    const rows = [];
    for (const w of [260, 280, 300, 308, 330, 340, 380, 440]) {
        insp.style.width = w + 'px';
        await new Promise((r) => setTimeout(r, 110));
        const rr = box.getBoundingClientRect();
        const kids = Array.prototype.slice.call(box.children);
        const maxRight = Math.max.apply(null, kids.map((k) => k.getBoundingClientRect().right));
        rows.push({
            w,
            cols: getComputedStyle(box).gridTemplateColumns.split(' ').length,
            overflow: Math.round(maxRight - rr.right),
            scroll: box.scrollWidth, client: box.clientWidth,
            btn: Math.round(kids[0].getBoundingClientRect().width),
            // 文本永远不该被裁：用 scrollWidth 对比 clientWidth 判断按钮内部是否溢出
            textClip: kids.filter((k) => k.scrollWidth > k.clientWidth + 1).length
        });
    }
    insp.style.width = '308px';
    return { rows };
})()`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    win.showInactive();
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        const s = document.getElementById('pwSkip');
        if (s) s.click();
        return true;
    })()`);
    await sleep(1200);

    console.log('侧栏窄宽度布局回归（拼图 12 宫格按钮）');
    console.log('─'.repeat(72));
    let res = null;
    try {
        res = await win.webContents.executeJavaScript(PROBE);
    } catch (e) {
        check(false, '探针执行', String(e && e.message));
    }
    if (res && res.rows) {
        const bad = res.rows.filter((r) => r.overflow > 0 || r.scroll > r.client + 1 || r.textClip > 0);
        const narrow = res.rows.filter((r) => r.w <= 330);
        const wide = res.rows.filter((r) => r.w >= 340);
        check(bad.length === 0, '260~440 全宽度不横向溢出、按钮内文字不被裁',
            bad.length ? JSON.stringify(bad) : `${res.rows.length} 个宽度全部通过`);
        check(narrow.every((r) => r.cols === 3), '窄侧栏（≤330）退成 3 列',
            narrow.map((r) => r.w + ':' + r.cols).join(' '));
        check(wide.every((r) => r.cols === 4), '常规/加宽（≥340）仍是 4 列',
            wide.map((r) => r.w + ':' + r.cols).join(' '));
    } else {
        check(false, '拼图布局按钮存在', JSON.stringify(res));
    }
    console.log('─'.repeat(72));
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

main().catch((e) => { console.error(e); app.exit(1); });
