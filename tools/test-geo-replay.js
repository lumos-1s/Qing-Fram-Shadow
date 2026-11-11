// 几何编辑（旋转 / 裁切）的可撤销与可持久化回归。
// 以前这两个操作只把 im.el 换掉：Ctrl+Z 撤不掉、草稿恢复时从原文件重解码，
// 裁切和旋转静默丢失。现在记成数字日志，撤销和重启都从原图按序重放。
//
// 用法：node tools/run-electron.js tools/test-geo-replay.js
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
    'open-image']) ipcMain.handle(c, () => ({ canceled: true }));
ipcMain.handle('read-exif', () => ({}));
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
        const wait = (ms) => new Promise((r2) => setTimeout(r2, ms));
        const px = (el, sx, sy) => {
            const cc = document.createElement('canvas'); cc.width = 1; cc.height = 1;
            const gg = cc.getContext('2d');
            const W = el.naturalWidth || el.width, H = el.naturalHeight || el.height;
            gg.drawImage(el, Math.round(W * sx), Math.round(H * sy), 1, 1, 0, 0, 1, 1);
            return Array.from(gg.getImageData(0, 0, 1, 1).data);
        };
        // 四色象限底图：旋转/裁切后取样点颜色一定会变，能验证「真的重放了像素」
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const g = c.getContext('2d');
        g.fillStyle = '#cc3333'; g.fillRect(0, 0, 200, 150);
        g.fillStyle = '#33cc66'; g.fillRect(200, 0, 200, 150);
        g.fillStyle = '#3366cc'; g.fillRect(0, 150, 200, 150);
        g.fillStyle = '#cccc33'; g.fillRect(200, 150, 200, 150);
        const baseUrl = c.toDataURL('image/png');
        const baseEl = new Image();
        await new Promise((r2) => { baseEl.onload = r2; baseEl.onerror = r2; baseEl.src = baseUrl; });
        const im = { el: baseEl, name: 'geo.png', path: 'C:/fake/geo.png',
                     w: 400, h: 300, exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.updateEmptyState(); if (A._resetHistory) A._resetHistory(); A.buildThumbnails();

        const before = { w: im.w, h: im.h, p: px(im.el, 0.25, 0.25), ops: (im.geoOps || []).length };
        await A.rotateCurrentPhoto();
        await wait(100);
        const rotated = { w: im.w, h: im.h, ops: JSON.parse(JSON.stringify(im.geoOps || [])),
                          p: px(im.el, 0.25, 0.25), hasOrig: !!im.orig };
        A.undo(); await wait(100);
        const undone = { w: im.w, h: im.h, ops: (im.geoOps || []).length, p: px(im.el, 0.25, 0.25) };
        A.redo(); await wait(100);
        const redone = { w: im.w, h: im.h, ops: (im.geoOps || []).length, p: px(im.el, 0.25, 0.25) };

        // 斜角裁切：rad != 0，重放要按同一套几何算出同一张图
        A.openCrop(); await wait(220);
        A.setCropAngle(8); await wait(120);
        await A.applyCrop(); await wait(150);
        const cropped = { w: im.w, h: im.h, ops: JSON.parse(JSON.stringify(im.geoOps || [])),
                          p: px(im.el, 0.5, 0.5) };

        // 抓草稿对象（_persistDraft 走 IPC，这里只截获它拿到的 JSON）
        let captured = null;
        const origPersist = A._persistDraft;
        A._persistDraft = (d) => { captured = d; return Promise.resolve(); };
        A.saveDraftNow();
        A._persistDraft = origPersist;
        const draftGeo = captured && captured.images[0]
            ? JSON.parse(JSON.stringify(captured.images[0].geo || [])) : null;

        // 模拟「重启后从文件重放」：photoUrl 指回同一张原图
        A.photoUrl = () => baseUrl;
        const restored = captured ? await A.imageFromMeta(Object.assign({}, captured.images[0]), null) : null;
        const replay = restored ? { w: restored.w, h: restored.h,
            ops: (restored.geoOps || []).length, p: px(restored.el, 0.5, 0.5), hasOrig: !!restored.orig } : null;

        const origOk = A.restoreOriginalPhoto(im);
        const afterRestore = { ok: origOk, w: im.w, h: im.h,
            ops: (im.geoOps || []).length, hasOrig: !!im.orig };
        return { before, rotated, undone, redone, cropped, draftGeo, replay, afterRestore };
    })()`);

    const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
    check(r.before.w === 400 && r.before.h === 300 && r.before.ops === 0,
        '初始状态 400×300，无几何操作', JSON.stringify(r.before));
    check(r.rotated.w === 300 && r.rotated.h === 400 && r.rotated.ops.length === 1
        && r.rotated.ops[0].t === 'r' && r.rotated.hasOrig && !same(r.rotated.p, r.before.p),
        '旋转：宽高互换、日志记一条、原图留底、像素确实变了',
        `${r.rotated.w}×${r.rotated.h} ops=${JSON.stringify(r.rotated.ops)}`);
    check(r.undone.w === 400 && r.undone.h === 300 && r.undone.ops === 0
        && same(r.undone.p, r.before.p),
        'Ctrl+Z 能撤销旋转（位图与原始逐像素一致）', JSON.stringify(r.undone));
    check(r.redone.w === 300 && r.redone.h === 400 && r.redone.ops === 1
        && same(r.redone.p, r.rotated.p),
        'Ctrl+Y 能重做旋转', JSON.stringify(r.redone));
    check(r.cropped.ops.length === 2 && r.cropped.ops[1].t === 'c' && r.cropped.ops[1].rad !== 0,
        '斜角裁切也记成可重放的数字日志', JSON.stringify(r.cropped.ops[1]));
    check(r.draftGeo && r.draftGeo.length === 2 && r.draftGeo[0].t === 'r' && r.draftGeo[1].t === 'c',
        '草稿里带上了两条几何操作（不再只存 path + 调色）', JSON.stringify(r.draftGeo));
    check(r.replay && r.replay.w === r.cropped.w && r.replay.h === r.cropped.h
        && r.replay.ops === 2 && same(r.replay.p, r.cropped.p) && r.replay.hasOrig,
        '重启式恢复：从原文件重放出的位图与编辑时逐像素一致',
        `live=${r.cropped.w}×${r.cropped.h} replay=${r.replay && r.replay.w}×${r.replay && r.replay.h}`);
    check(r.afterRestore.ok && r.afterRestore.w === 400 && r.afterRestore.h === 300
        && r.afterRestore.ops === 0 && !r.afterRestore.hasOrig,
        '还原原图会清空日志与备份', JSON.stringify(r.afterRestore));

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });
