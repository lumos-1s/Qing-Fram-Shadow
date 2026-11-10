// 艺术卡右下角色卡：必须随调色实时更新。
// 根因：调色后 photoSrcOf 返回 Canvas（没有 src），样式引擎的 imgKey 只按 src+尺寸，
// 所有调色画面共用一个取色缓存 → 色卡永远停在第一次取色，拖滑块"不能实时调整"。
// 用法: node tools/run-electron.js tools/test-art-card-palette.js
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
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

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
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(600);

    const r = await exec(`(async () => {
        const A = window.App;
        await A.loadPresets();

        // 一张高饱和多色图，保证色卡能取到明显的主色
        const c = document.createElement('canvas'); c.width = 800; c.height = 600;
        const g = c.getContext('2d');
        const cols = ['#d83b3b', '#e8a13a', '#3fa96b', '#3b6fd8', '#8b4bd8'];
        cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 160, 0, 160, 600); });
        const im = new Image();
        await new Promise((res) => { im.onload = res; im.onerror = res; im.src = c.toDataURL('image/png'); });

        const item = { el: im, name: 'a.png', w: 800, h: 600, exif: {}, customSettings: null, grade: null };
        A.images = [item]; A.image = item; A.currentIdx = 0; A.selectedIdx = [0];
        A.imageTemplates = new Map();
        if (A.invalidateGrade) A.invalidateGrade(item);

        const t = A.defaultTemplate();
        t.photoFrameStyle = 'ART_CARD';
        t.photoFrameBorderSize = 80;
        t.templateName = '艺术卡';
        A.template = t;
        A.setTpl(item, A.template);
        A.normalizeTemplate();
        A.refreshUI();
        if (A.switchTab) A.switchTab('border');
        await A.flushRender();

        const cv = A.dom.canvas;
        // 用引擎给出的照片矩形精确算出下沿，只取样下方的白纸带 + 色卡，
        // 避开照片本体：否则"照片变黑白"会伪装成"色卡变了"。
        const pr = A._photoRect || { y: 0, h: cv.height };
        const sc = A._canvasScale || 1;
        const photoBottom = (pr.y + pr.h) * sc;
        const y0 = Math.min(cv.height - 2, Math.max(0, Math.round(photoBottom) + 2));
        const stats = () => {
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            const x0 = Math.floor(cv.width * 0.5);
            let color = 0, sumSat = 0, n = 0;
            for (let y = y0; y < cv.height; y++) {
                for (let x = x0; x < cv.width; x++) {
                    const i = (y * cv.width + x) * 4;
                    const r = d[i], gg = d[i + 1], b = d[i + 2];
                    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
                    const sat = mx - mn;
                    sumSat += sat; n++;
                    if (sat > 40 && mx > 60) color++;
                }
            }
            return { color, avgSat: Math.round(sumSat / Math.max(1, n) * 10) / 10 };
        };

        const before = stats();
        const src0 = window.photoSrcOf(item);
        const ver0 = src0 && src0._qfsGradeKey;

        // 调成黑白：色卡必须跟着变灰（实时跟随调色结果）
        A.setGrade({ sat: -100 });
        A.rebuildGrade('full');
        await A.flushRender();
        const gray = stats();
        const src1 = window.photoSrcOf(item);
        const ver1 = src1 && src1._qfsGradeKey;

        // 调回中性：photoSrcOf 回到原图，色卡应恢复
        A.setGrade({ sat: 0 });
        A.rebuildGrade('full');
        await A.flushRender();
        const restored = stats();
        const src2 = window.photoSrcOf(item);
        const ver2 = src2 && src2._qfsGradeKey;

        // 缓存上限压力：连续换 20 组参数（每组都会新增一批 imgKey），
        // 超过上限后缓存轮换，取色结果仍必须正确、不能崩。
        let stressErr = '';
        try {
            for (let i = 0; i < 20; i++) {
                A.setGrade({ sat: -90 + i * 4 });
                await A.flushRender();
            }
            A.setGrade({ sat: 0 });
            await A.flushRender();
        } catch (e) { stressErr = String(e && e.message || e); }
        const stressed = stats();

        return { before, gray, restored, stressed, stressErr, ver0, ver1, ver2,
            srcKinds: [src0 && src0.tagName, src1 && src1.tagName, src2 && src2.tagName],
            geom: { cw: cv.width, ch: cv.height, pr, sc, y0 } };
    })()`);

    check(r.before.color > 20, '艺术卡右下角色卡确实画出来了（有彩色像素）', JSON.stringify(r.before));
    check(r.srcKinds[1] === 'CANVAS', '调色后取源是烘焙 Canvas', JSON.stringify(r.srcKinds));
    check(!!r.ver1 && r.ver1 !== r.ver0, '烘焙画布带着随调色变化的内容签名',
        JSON.stringify({ v0: r.ver0, v1: r.ver1 }));
    check(r.gray.color < r.before.color * 0.5 || r.gray.avgSat < r.before.avgSat * 0.6,
        '调成黑白后色卡跟着变灰（实时跟随调色）',
        JSON.stringify({ before: r.before, gray: r.gray }));
    check(r.restored.color > r.gray.color * 1.5 || r.restored.avgSat > r.gray.avgSat * 1.4,
        '调回中性后色卡恢复（缓存没有把旧结果钉死）',
        JSON.stringify({ gray: r.gray, restored: r.restored, src2: r.srcKinds[2] }));
    check(!r.stressErr && Math.abs(r.stressed.color - r.before.color) < r.before.color * 0.15,
        '连续 20 组调色后取色仍正确（缓存有上限、不会无限堆）',
        JSON.stringify({ err: r.stressErr, before: r.before.color, stressed: r.stressed.color }));

    console.log(failures.length
        ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('')
        : '\nALL PASS');
    app.quit();
    process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error('FAIL', e); app.quit(); process.exit(1); });
