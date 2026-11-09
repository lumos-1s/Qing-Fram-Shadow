// 草稿恢复：调过色的照片必须一恢复就看到调色后的画面，而不是等用户动一下滑块。
// 用法：node tools/run-electron.js tools/test-draft-grade.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net, nativeImage } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp', 'draft-grade');
fs.mkdirSync(TMP, { recursive: true });

// 三张同样的中灰图：当前张调色 / 非当前张调色 / 完全没调色
function grayPng(name) {
    const w = 48, h = 32;
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
        buf[i] = 128; buf[i + 1] = 128; buf[i + 2] = 128; buf[i + 3] = 255;
    }
    const png = nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
    const p = path.join(TMP, name);
    fs.writeFileSync(p, png);
    return p;
}
const PATHS = [grayPng('g0.png'), grayPng('g1.png'), grayPng('g2.png')];

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'list-grade-presets', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : (c.startsWith('load') ? null : { ok: true })));
}
ipcMain.handle('read-exif', () => ({}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const P = ${JSON.stringify(PATHS)};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const load = (src) => new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = src;
    });
    const px = (src) => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0, 8, 8);
        return g.getImageData(4, 4, 1, 1).data[0];
    };

    // ── 构造一次「调过色」的会话并落草稿 ──
    const els = await Promise.all(P.map((p) => load(A.photoUrl(p))));
    if (els.some((e) => !e)) return { error: 'qflocal 图片没加载出来' };
    const ims = els.map((el, i) => ({
        el, name: 'g' + i + '.png', path: P[i], w: 48, h: 32,
        exif: {}, customSettings: null, grade: null
    }));
    A.images = ims; A.currentIdx = 0; A.image = ims[0];
    A.selectedIdx = [0]; A.batchSel = [];
    A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    ims.forEach((im) => A.setTpl(im, JSON.parse(JSON.stringify(A.template))));
    A.updateEmptyState(); A.refreshUI();
    A.setGrade({ exp: 1.5 });
    // 第二张也调色，但恢复后它不是当前张
    A.image = ims[1]; A.setGrade({ exp: 1.5 });
    A.image = ims[0]; A.syncGradeUI();
    A.saveDraftNow();
    let draft = null;
    for (let i = 0; i < 40 && !draft; i++) {
        await wait(50);
        try { const raw = localStorage.getItem(A._draftKey); if (raw) draft = JSON.parse(raw); } catch (_) {}
    }
    if (!draft) return { error: '草稿没写进 localStorage' };
    const draftExps = draft.images.map((m) => m.grade && m.grade.exp);

    // ── 模拟重启：清空当前会话，只留草稿 ──
    A.images = []; A.image = null; A.currentIdx = 0;
    A._resetHistory && A._resetHistory();
    await A.restoreDraft();
    await wait(350);

    const cur = A.image;
    const src = window.photoSrcOf(cur);
    const origPx = px(cur.el);
    const outPx = src ? px(src) : 0;
    const curSrcIsCanvas = !!(src && src.tagName === 'CANVAS');
    const other = A.images[1];
    const otherSrc = window.photoSrcOf(other);
    const neutral = A.images[2];
    const neutralSrc = window.photoSrcOf(neutral);

    // 全程没有再调用 setGrade：面板参数来自草稿，画面也必须来自草稿
    return {
        count: A.images.length,
        currentIdx: A.currentIdx,
        exp: cur && cur.grade && cur.grade.exp,
        slider: (document.getElementById('slGradeExp') || {}).value,
        draftExps,
        curSrcIsCanvas, origPx, outPx,
        otherIsCanvas: !!(otherSrc && otherSrc.tagName === 'CANVAS'),
        neutralIsOriginal: neutralSrc === neutral.el,
        thumbsQueued: A.images.filter((im) => im.grade && !im._grade.neutral).length,
        title: (document.getElementById('stInfo') || {}).textContent
    };
})()`;

async function main() {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (_) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    let res = null;
    try { res = await win.webContents.executeJavaScript(PROBE); }
    catch (e) { check(false, '探针执行', String(e && e.message)); }
    if (res) {
        if (res.error) check(false, '构造草稿', res.error);
        check(res.count === 3 && res.draftExps[0] === 1.5 && res.draftExps[1] === 1.5 && !res.draftExps[2],
            '草稿只存调色记录值（前两张有 exp，第三张为空）', JSON.stringify(res.draftExps));
        check(res.exp === 1.5 && String(res.slider) === '1.5',
            '恢复后面板参数回显（这正是「参数在、画面没在」的对照组）',
            `grade=${res.exp} slider=${res.slider}`);
        check(res.curSrcIsCanvas,
            '恢复后当前张立刻拿到烘焙画布（不再是原图）', `canvas=${res.curSrcIsCanvas}`);
        check(res.outPx > res.origPx + 20,
            '恢复后画面真的变亮了（曝光 +1.5 已重放，无需动滑块）',
            `${res.origPx} → ${res.outPx}`);
        check(res.otherIsCanvas,
            '非当前张也补了降采样烘焙，切过去第一帧不会闪回原图');
        check(res.neutralIsOriginal,
            '没调色的照片仍然直接用原图，不做无谓烘焙');
    }

    console.log('─'.repeat(72));
    win.destroy();
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
