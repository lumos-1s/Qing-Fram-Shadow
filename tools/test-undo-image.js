// 撤销/重做必须按图片隔离 —— UI 回归(真实 Electron 渲染进程)
//   node tools/run-electron.js tools/test-undo-image.js
//
// 背景:undoStack/redoStack 原来只有一份。切图后按 Ctrl+Z 会把上一张照片的
// 模板/调色快照应用到当前照片，并 saveCurrentTemplate() 落盘，属于数据覆盖。
// 现在快照带 __image，selectImage 时交换每张图自己的栈。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

ipcMain.handle('list-presets', () => fs.existsSync(PRESET_DIR)
    ? fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, ''))
    : []);
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
for (const c of ['save-prefs', 'save-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'copy-text', 'save-diagnostics', 'check-for-updates',
    'start-update-download', 'quit-and-install', 'list-wall-covers', 'open-wall-covers-dir',
    'open-external']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location',
    'write-export-files', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
ipcMain.handle('load-acr-shadows', () => null);

const fails = [];
let total = 0;
const check = (ok, label, detail) => {
    total++;
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label);
    if (detail) console.log('       ' + detail);
    if (!ok) fails.push(label);
};

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const p = new URL(req.url).searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (_) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript(
            '!!(window.App && window.App.dom && window.App.defaultTemplate && window.App.cloneTemplate)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    let out;
    try {
        out = await win.webContents.executeJavaScript(`(${runInPage.toString()})()`);
    } catch (e) {
        console.log('FAIL 渲染侧脚本异常: ' + (e && e.message || e));
        app.exit(1);
        return;
    }

    console.log('撤销/重做按图片隔离');
    console.log('─'.repeat(76));
    for (const row of out.rows) check(row.ok, row.label, row.detail);
    if (out.errors && out.errors.length) check(false, '渲染侧无异常', out.errors.join(' | '));
    console.log('─'.repeat(76));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);

    app.exit(fails.length ? 1 : 0);
}).catch((e) => {
    console.error('FAIL', e);
    app.exit(1);
});

// 在渲染进程里执行:全部断言基于真实 App 实例的方法，不渲染像素。
function runInPage() {
    const A = window.App;
    const rows = [];
    const errors = [];
    const statuses = [];
    const ok = (cond, label, detail) => rows.push({ ok: !!cond, label, detail: detail || '' });

    // 只替换与撤销无关的副作用(缩略图/渲染/UI 刷新/状态栏)，保留撤销栈与模板存取的真实实现。
    A.saveCurrentTemplate = function () {
        if (!this.image) return;
        this.setTpl(this.image, this.cloneTemplate());
    };
    A.buildThumbnails = () => {};
    A.afterImageSelect = () => {};
    A.scheduleRender = () => {};
    A.invalidateStyleCaches = () => {};
    A.rebuildGrade = () => {};
    A.syncGradeUI = () => {};
    A.refreshUI = () => {};
    A.queueThumb = () => {};
    A.scheduleDraft = () => {};
    A.updateHistoryButtons = () => {};
    A.setStatus = (m) => { statuses.push(String(m)); };

    const mkImage = (name) => ({ name, w: 100, h: 80, exif: {} });
    const imA = mkImage('A');
    const imB = mkImage('B');
    A.images = [imA, imB];
    A.image = imA;
    A.currentIdx = 0;
    A.undoStack = [];
    A.redoStack = [];
    A.historyByImage = new WeakMap();
    A.template = A.defaultTemplate();
    A.saveCurrentTemplate();

    // ── ① 同图内撤销/重做仍然正常 ──
    A.template.baseMargin.marginTop = 111;
    A.saveCurrentTemplate();
    A.pushUndo();
    A.template.baseMargin.marginTop = 222;
    A.saveCurrentTemplate();
    A.undo();
    ok(A.template.baseMargin.marginTop === 111, '同图撤销恢复到上一状态',
        'marginTop=' + A.template.baseMargin.marginTop);
    A.redo();
    ok(A.template.baseMargin.marginTop === 222, '同图重做回到撤销前状态',
        'marginTop=' + A.template.baseMargin.marginTop);

    // ── ② 切到 B 后按撤销:不能把 A 的快照写到 B 上 ──
    A.selectImage(1);
    const bBefore = JSON.stringify(A.cloneTemplate());
    const bUndoLen = A.undoStack.length;
    A.undo();
    ok(A.template.baseMargin.marginTop !== 111 && A.template.baseMargin.marginTop !== 222,
        '切图后撤销不应用上一张照片的快照',
        'B.marginTop=' + A.template.baseMargin.marginTop);
    ok(JSON.stringify(A.cloneTemplate()) === bBefore, '切图后撤销不修改当前照片模板');
    ok(bUndoLen === 0 && A.undoStack.length === 0, '新照片从空撤销栈开始',
        'len=' + A.undoStack.length);

    // ── ③ 切回 A:历史还在，且能继续撤销 ──
    A.selectImage(0);
    ok(A.template.baseMargin.marginTop === 222, '切回照片恢复它自己的模板',
        'A.marginTop=' + A.template.baseMargin.marginTop);
    ok(A.undoStack.length === 1, '切回照片恢复它自己的撤销栈',
        'len=' + A.undoStack.length);
    A.undo();
    ok(A.template.baseMargin.marginTop === 111, '切回后撤销仍作用于自己的历史',
        'A.marginTop=' + A.template.baseMargin.marginTop);

    // ── ④ A 的重做记录不能在 B 上生效 ──
    A.selectImage(1);
    const bBeforeRedo = JSON.stringify(A.cloneTemplate());
    const redoLen = A.redoStack.length;
    A.redo();
    ok(redoLen === 0 && JSON.stringify(A.cloneTemplate()) === bBeforeRedo,
        '切图后重做不会应用另一张照片的记录');
    A.selectImage(0);
    A.redo();
    ok(A.template.baseMargin.marginTop === 222, '切回后重做恢复自己的状态',
        'A.marginTop=' + A.template.baseMargin.marginTop);

    // ── ⑤ 兜底:快照 __image 与当前图不符时,applyUndoSnapshot 直接拒绝 ──
    A.selectImage(0);
    const snapA = A.cloneTemplate();
    A.selectImage(1);
    A.template.baseMargin.marginTop = 333;
    A.saveCurrentTemplate();
    const bBeforeGuard = JSON.stringify(A.cloneTemplate());
    A.undoStack.push(snapA);
    A.undo();
    ok(JSON.stringify(A.cloneTemplate()) === bBeforeGuard, '错图快照被 __image 守卫拦截');
    ok(statuses.some(s => s.indexOf('另一张照片') >= 0), '拦截时给出可见提示',
        'status=' + (statuses[statuses.length - 1] || ''));

    // ── ⑥ 渲染纠错路径 _reconcileCurrentImage 也要换栈 ──
    // 先给 B 一份干净历史(⑤ 里的 push 改写了 B 的栈对象，避免影响本段断言)
    A.historyByImage.set(imB, { undo: [], redo: [] });
    A.undoStack = [snapA];
    A.redoStack = [];
    A.image = imA;          // 人为制造 image 与 currentIdx 错位
    A.currentIdx = 1;
    const fixed = A._reconcileCurrentImage();
    ok(fixed && A.image === imB, '_reconcileCurrentImage 切到 currentIdx 指向的图片');
    ok(A.undoStack.length === 0, '纠错切图后使用目标图自己的空历史',
        'len=' + A.undoStack.length);
    A.currentIdx = 0;
    A._reconcileCurrentImage();
    ok(A.image === imA && A.undoStack.length === 1, '纠错切回后恢复原图历史',
        'len=' + A.undoStack.length);

    // ── ⑦ 打开工程/恢复草稿替换整批图片时清空历史 ──
    A._resetHistory();
    ok(A.undoStack.length === 0 && A.redoStack.length === 0, '_resetHistory 清空撤销与重做栈');

    // ── ⑧ 快照里的 __image 不进入模板序列化 ──
    const snap = A.cloneTemplate();
    ok(snap.__image === imA, '快照记录所属图片');
    ok(JSON.stringify(snap).indexOf('__image') < 0, '__image 不参与 JSON 序列化');

    return { rows, errors };
}
