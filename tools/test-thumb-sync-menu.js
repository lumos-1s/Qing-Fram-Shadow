// 缩略图右键菜单的三条同步：只调色 / 边框+调色 / 只边框。
// 重点验证「各自只搬自己该搬的东西」，以及右键落点的口径：
//   落在已多选的缩略图上 → 整批；否则 → 只有右键那一张。
//
// 用法：node tools/run-electron.js tools/test-thumb-sync-menu.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; } });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
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
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

async function main() {
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500); win.showInactive();
    const exec = (x) => win.webContents.executeJavaScript(x);
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_){}
        if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(1000);

    const r = await exec(`(async () => {
        const A = window.App;
        window.confirm = () => true;          // 「同步边框」批量时会问一次是否覆盖
        const imgs = [];
        for (let k = 0; k < 4; k++) {
            const c = document.createElement('canvas'); c.width = 200; c.height = 140;
            const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 200, 140);
            const el = new Image();
            await new Promise((r2) => { el.onload = r2; el.onerror = r2; el.src = c.toDataURL('image/png'); });
            imgs.push({ el, name: 'p' + k + '.png', path: null, w: 200, h: 140,
                        grade: { exp: 0, con: 0 }, exif: {}, customSettings: null });
        }
        A.images = imgs; A.image = imgs[0]; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.updateEmptyState();
        for (let i = 0; i < 4; i++) {
            const t = A.defaultTemplate(); t.baseMargin.marginTop = (i === 0 ? 77 : 10 + i);
            A.setTpl(imgs[i], t);
        }
        A.template = A.getTpl(imgs[0]);
        imgs[0].grade = { exp: 0.55, con: 20 };
        A.buildThumbnails();
        const snap = () => A.images.map((im) => {
            const t = A.getTpl(im);
            return { exp: Number((im.grade || {}).exp) || 0,
                     con: Number((im.grade || {}).con) || 0,
                     mt: t && t.baseMargin ? t.baseMargin.marginTop : null };
        });
        const reset = () => {
            for (let i = 1; i < 4; i++) {
                imgs[i].grade = { exp: 0, con: 0 };
                const t = A.getTpl(imgs[i]);
                if (t && t.baseMargin) t.baseMargin.marginTop = 10 + i;
            }
        };
        const openMenu = (idx) => {
            A.closeCtx();
            const w = document.querySelectorAll('#thumbStrip .thumb-item')[idx];
            w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
            return Array.from(document.querySelectorAll('.ctx-menu button'));
        };
        const click = (idx, prefix) => {
            const items = openMenu(idx);
            const labels = items.map((b) => b.textContent);
            const titles = items.map((b) => b.title || '');
            const sep = document.querySelectorAll('.ctx-menu .ctx-sep').length;
            const b = items.find((x) => x.textContent.indexOf(prefix) === 0);
            if (b) b.click();
            A.closeCtx();
            return { labels, titles, sep, found: !!b, snap: snap(), status: A.statusMsg || '' };
        };

        // 全选 4 张，右键落在第 2 张上 → 目标是全部 4 张（源是第 1 张，实际写入 3 张）
        A.selectedIdx = [0, 1, 2, 3]; A.batchSel = [0, 1, 2, 3]; A.buildThumbnails();
        const menu = click(1, '__none__');    // 只取菜单结构，不点任何项
        reset();
        const gradeOnly = click(1, '同步调色参数');
        reset();
        const borderOnly = click(1, '同步边框（');
        reset();
        const both = click(1, '同步边框 + 调色');

        // 单选状态：右键第 3 张 → 只影响那一张
        reset();
        A.selectedIdx = [0]; A.batchSel = [0]; A.buildThumbnails();
        const single = click(2, '同步调色参数');
        return { menu, gradeOnly, borderOnly, both, single };
    })()`);

    check(r.menu.labels.length === 4
        && /^同步调色参数（3 张）$/.test(r.menu.labels[0])
        && /^同步边框 \+ 调色（3 张）$/.test(r.menu.labels[1])
        && /^同步边框（3 张）$/.test(r.menu.labels[2])
        && /^删除选中 4 张$/.test(r.menu.labels[3]),
        '右键菜单：三条同步 + 删除，批量文案带张数', JSON.stringify(r.menu.labels));
    check(r.menu.sep === 1 && r.menu.titles.slice(0, 3).every((t) => t.length > 4),
        '同步项与删除之间有分隔线，且三条都有悬停说明',
        `sep=${r.menu.sep} titles=${JSON.stringify(r.menu.titles.slice(0, 3))}`);
    check(r.gradeOnly.found && r.gradeOnly.snap.slice(1).every((s) => s.exp === 0.55 && s.con === 20)
        && r.gradeOnly.snap.slice(1).every((s, k) => s.mt === 11 + k),
        '同步调色参数：只改调色，边框保持各图原样', JSON.stringify(r.gradeOnly.snap));
    check(r.borderOnly.found && r.borderOnly.snap.slice(1).every((s) => s.mt === 77)
        && r.borderOnly.snap.slice(1).every((s) => s.exp === 0),
        '同步边框：只改边框，调色参数不动', JSON.stringify(r.borderOnly.snap));
    check(r.both.found && r.both.snap.slice(1).every((s) => s.mt === 77 && s.exp === 0.55 && s.con === 20)
        && r.both.status.indexOf('边框 + 调色参数同步到 3 张') >= 0,
        '同步边框 + 调色：一次搬两样，只报一条状态',
        `${JSON.stringify(r.both.snap)} status=${r.both.status}`);
    check(r.single.found && r.single.labels[0] === '同步调色参数'
        && r.single.snap[2].exp === 0.55 && r.single.snap[1].exp === 0 && r.single.snap[3].exp === 0,
        '未多选时右键：只同步到右键那一张，菜单不带「（N 张）」',
        `${JSON.stringify(r.single.labels)} ${JSON.stringify(r.single.snap)}`);

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });
