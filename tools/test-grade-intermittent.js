// 调色间歇失效回归：根因是「换底图/还原/重设时调色缓存被作废却没重建」+
// 「photoSrcOf 返回已失效的 low 画布」+「切回被 LRU 淘汰的已调色照片不重建」+
// 「导入照片(无 _grade 槽位)时 setGrade 因 !t._grade 提前返回,调色静默失效,加蒙版后才恢复」。
// 复现：applyCrop/rotateCurrentPhoto 只 invalidateGrade 不 rebuild → 旧 low 被当结果返回；
// selectImage 完全不重建 → 编辑超过 LRU_MAX(4) 张后切回早期图,调色像没了；
// imageFromPick 不给 _grade → 调色拖滑块毫无反应,直到添加蒙版把它建出来。
// 用法：node tools/run-electron.js tools/test-grade-intermittent.js
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
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

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
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    await exec(`(async () => { if (window.QfsAcr) await QfsAcr.ensure(); return QfsAcr && QfsAcr.ready(); })()`)
        .then((r) => console.log('ACR tables ready=' + r));
    // 同步合成补丁（与 test-grade.js 一致），避免隐藏窗口 rAF 节流导致采样同一帧
    await exec(`(() => {
        const A = window.App;
        if (!A || A.__syncRenderPatched) return true;
        A.__syncRenderPatched = true;
        const orig = A.scheduleRender.bind(A);
        let busy = false;
        A.scheduleRender = function (immediate) {
            orig(immediate);
            if (busy) return;
            busy = true;
            try { A._renderDirty = true; if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue(); }
            finally { busy = false; }
        };
        return true;
    })()`);

    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    // ── 场景 1：换底图(裁切/旋转)后,photoSrcOf 不得返回已失效的旧 low;重建后立即恢复 ──
    const s1 = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'g1', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        // 先调色(全分辨率) + 再补一张 low,确保 low/lowKey 就位
        A.setGrade({ exp: 1, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.rebuildGrade('low');
        const lowRef = im._grade.low;
        const lowKeyOk = !!im._grade.lowKey;
        // 模拟裁切/旋转：只作废缓存、换新底图、但不重建(修复前 applyCrop/rotate 就是这样)
        A.invalidateGrade(im);
        const srcStale = window.photoSrcOf(im);           // 期望 = im.el(原始,未调色),绝不能是旧 low
        const returnedStaleLow = (srcStale === lowRef);
        const returnedOriginal = (srcStale === im.el);
        // 修复后:立刻在新底图上重放
        A.rebuildGrade('full');
        const srcFixed = window.photoSrcOf(im);
        const restoredGraded = (srcFixed !== im.el) && (srcFixed && srcFixed.tagName === 'CANVAS');
        return { lowKeyOk, returnedStaleLow, returnedOriginal, restoredGraded,
                 hasCanvas: !!(im._grade && im._grade.canvas) };
    })()`);
    check(s1.lowKeyOk, '调色后 low 与 lowKey 已就位（场景1前置）', JSON.stringify(s1));
    check(!s1.returnedStaleLow && s1.returnedOriginal,
        '换底图作废后 photoSrcOf 不再返回已失效的旧 low（修复前会返回旧 low = 假死）', JSON.stringify(s1));
    check(s1.restoredGraded && s1.hasCanvas, '换底图后重建,调色立即恢复(取源变回离屏画布)', JSON.stringify(s1));

    // ── 场景 2：编辑超过 LRU_MAX(4) 张后,切回早期已调色照片,selectImage 必须重建 ──
    const s2 = await exec(`(async () => {
        const A = window.App;
        const N = 8;
        const imgs = [];
        for (let i = 0; i < N; i++) {
            const el = await window.__mk(600, 400);
            const im = { el, name: 'g' + i, path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
            A.images.push(im);
            A.image = im; A.currentIdx = A.images.length - 1;
            A.template = A.defaultTemplate(); A.setTpl(im, A.template);
            A.setGrade({ exp: 1, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        }
        // 此时 LRU 已满(LRU_MAX=4),最早的 4 张已被淘汰:canvas/low 置空
        const early = A.images[0];
        const evictedCanvas = !early._grade.canvas;
        const evictedLow = !early._grade.low;
        // 切回最早的图(修复前 selectImage 不重建 → 取源回退原图 = 调色没了)
        A.selectImage(0);
        await new Promise((r) => setTimeout(r, 120));
        const afterCanvas = !!(A.image._grade && A.image._grade.canvas);
        const src = window.photoSrcOf(A.image);
        const rebuiltGraded = (src !== A.image.el) && (src && src.tagName === 'CANVAS');
        return { evictedCanvas, evictedLow, afterCanvas, rebuiltGraded, count: A.images.length };
    })()`);
    check(s2.evictedCanvas && s2.evictedLow, 'LRU 淘汰后早期图的调色缓存已被清空（场景2前置）', JSON.stringify(s2));
    check(s2.afterCanvas && s2.rebuiltGraded,
        '切回被淘汰的已调色照片,selectImage 立即重建,调色恢复(取源变回离屏画布)', JSON.stringify(s2));

    // ── 场景 3：导入照片(没有 _grade 槽位)后拖调色滑块必须立即生效 ──
    // 复刻 imageFromPick 修复前的产物：对象里完全没有 _grade 字段。旧代码里
    // setGrade→invalidateFullGrade/rebuildGrade 都会因「!t._grade」提前返回，
    // 调色静默失效，直到某条会建 _grade 的路径(如添加蒙版)出现才恢复。
    const s3 = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'imported', path: null, w: 600, h: 400, exif: {}, customSettings: null };
        A.images.push(im);
        A.image = im; A.currentIdx = A.images.length - 1;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        delete im._grade;                                   // 强制模拟「修复前 imageFromPick 没给 _grade」
        const hadGradeBefore = !!im._grade;
        A.setGrade({ exp: 1, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const src = window.photoSrcOf(im);
        return {
            hadGradeBefore,
            createdSlot: !!im._grade,
            notNeutral: !!(im._grade && im._grade.neutral === false),
            bakedCanvas: !!(im._grade && im._grade.canvas),
            srcIsGraded: !!(src && src !== im.el && src.tagName === 'CANVAS')
        };
    })()`);
    check(!s3.hadGradeBefore, '复刻导入照片:修复前没有 _grade 槽位（场景3前置）', JSON.stringify(s3));
    check(s3.createdSlot && s3.notNeutral && s3.bakedCanvas && s3.srcIsGraded,
        '导入照片后拖滑块立即烘焙,photoSrcOf 取回离屏画布(调色生效)', JSON.stringify(s3));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
