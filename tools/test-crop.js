// 裁切工具回归：开合、比例锁定、拖框/越界夹取、旋转、应用后的位图尺寸、取消不改图。
// 用法：node tools/run-electron.js tools/test-crop.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── IPC mock：渲染进程的 presets.js / 草稿 / 缩略图都要能跑 ──
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

// 页面里可复用的造图函数：800×600 四色象限，裁完能看出取的是哪一块
const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 800; c.height = h || 600;
    const g = c.getContext('2d');
    g.fillStyle = '#c33'; g.fillRect(0, 0, c.width / 2, c.height / 2);
    g.fillStyle = '#3c3'; g.fillRect(c.width / 2, 0, c.width / 2, c.height / 2);
    g.fillStyle = '#33c'; g.fillRect(0, c.height / 2, c.width / 2, c.height / 2);
    g.fillStyle = '#cc3'; g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
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
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    // 造一张 800×600 的当前图，并把编辑器状态摆成"已导入一张照片"
    const setupImage = () => exec(`(async () => {
        const A = window.App;
        const makeImage = ${MAKE_IMAGE};
        const el = await makeImage(800, 600);
        const im = { el, name: '测试图.png', path: null, w: 800, h: 600, exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.setTpl(im, A.template);
        A.updateEmptyState();
        A.scheduleRender(true);
        return { w: im.el.naturalWidth, h: im.el.naturalHeight, hasCrop: typeof A.openCrop === 'function' };
    })()`);

    const s0 = await setupImage();
    check(s0.w === 800 && s0.h === 600 && s0.hasCrop, '裁切模块已加载，当前图 800×600',
        `w=${s0.w} h=${s0.h} openCrop=${s0.hasCrop}`);

    // 0. 入口位置：右侧栏「画布 → 照片」组，不在顶部工具栏（顶部留给文件级操作）
    const place = await exec(`(async () => {
        const b = document.getElementById('btnCrop');
        const r = document.getElementById('btnRestoreOriginal');
        const grp = b && b.closest('.param-group');
        const grpTitle = grp ? (grp.querySelector('.pg-title') || {}).textContent : '';
        const tab = b && b.closest('.tab-panel');
        const info = {
            inToolbar: !!(b && b.closest('#toolbar')),
            inCanvas: !!(b && b.closest('#panel-canvas')),
            tab: tab ? tab.id : '',
            group: grpTitle || '',
            visible: !!(b && b.offsetParent),
            label: b ? b.textContent.trim() : '',
            restoreHidden: !!(r && r.hidden)
        };
        b.click();
        await new Promise((x) => setTimeout(x, 260));
        const opened = !!(window.App._crop && window.App._crop.open);
        window.App.closeCrop();
        await new Promise((x) => setTimeout(x, 80));
        return Object.assign(info, { opened });
    })()`);
    check(!place.inToolbar && place.inCanvas && place.tab === 'panel-canvas' && place.group.indexOf('照片') >= 0,
        '裁切按钮在右侧栏「画布 → 照片」组里', `tab=${place.tab} group=${place.group} toolbar=${place.inToolbar}`);
    check(place.visible && place.label.indexOf('裁切') >= 0 && place.opened,
        '点侧栏按钮能打开裁切弹层', `label=${place.label} opened=${place.opened}`);
    check(place.restoreHidden, '没有备份时「还原原图」不占位');

    // 1. 打开：弹层可见、裁切框铺满整张、画布按弹层尺寸分配
    const open = await exec(`(async () => {
        const A = window.App;
        const ok = A.openCrop();
        await new Promise((r) => setTimeout(r, 260));
        const ov = document.getElementById('cropModal');
        const cv = document.getElementById('cropCanvas');
        const st = A._crop;
        return { ok, display: getComputedStyle(ov).display, open: st.open,
                 box: { ...st.box }, W: st.W, H: st.H, fit: st.fit,
                 cw: cv.width, ch: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight,
                 sizeText: document.getElementById('cropSize').textContent };
    })()`);
    check(open.ok && open.open && open.display !== 'none', '裁切弹层可以打开（openCrop）',
        `display=${open.display}`);
    check(open.box.x === 0 && open.box.y === 0 && open.box.w === 800 && open.box.h === 600,
        '裁切框默认铺满整张（不白丢画面）', JSON.stringify(open.box));
    check(open.cw > 100 && open.ch > 100 && open.cssW > 100, '画布按弹层可用尺寸分配（DPR 缩放）',
        `backing=${open.cw}×${open.ch} css=${open.cssW}×${open.cssH} dpr=${(open.cw / open.cssW).toFixed(2)}`);
    check(open.sizeText.indexOf('800 × 600') === 0, '尺寸标签显示 800 × 600', open.sizeText);

    // 2. 比例锁定：1:1 → 正方形居中；4:3 保持比例
    const ratio = await exec(`(async () => {
        const A = window.App;
        const click = (sel) => document.querySelector('#cropRatios [data-r="' + sel + '"]').click();
        click('1:1');
        await new Promise((r) => setTimeout(r, 60));
        const sq = { ...A._crop.box };
        const chipOn = document.querySelector('#cropRatios [data-r="1:1"]').classList.contains('is-on');
        click('4:3');
        await new Promise((r) => setTimeout(r, 60));
        const r43 = { ...A._crop.box };
        return { sq, chipOn, r43, ratio: A._crop.ratio };
    })()`);
    check(Math.abs(ratio.sq.w - ratio.sq.h) < 0.5, '1:1 → 正方形', `${ratio.sq.w.toFixed(1)}×${ratio.sq.h.toFixed(1)}`);
    check(Math.abs(ratio.sq.w - 600) < 0.5 && Math.abs(ratio.sq.x - 100) < 0.5,
        '1:1 取短边、水平居中', `w=${ratio.sq.w.toFixed(1)} x=${ratio.sq.x.toFixed(1)}`);
    check(ratio.chipOn, '比例按钮高亮同步');
    check(Math.abs(ratio.r43.w / ratio.r43.h - 4 / 3) < 0.002, '4:3 → 宽高比 1.333',
        (ratio.r43.w / ratio.r43.h).toFixed(3));

    // 3. 拖右下角手柄：框变小、左上角锚点不动
    const resize = await exec(`(async () => {
        const A = window.App;
        document.querySelector('#cropRatios [data-r="free"]').click();
        A._crop.box = { x: 100, y: 100, w: 600, h: 400 };
        A.drawCrop();
        const st = A._crop;
        const cv = document.getElementById('cropCanvas');
        const r = cv.getBoundingClientRect();
        const px = r.left + st.ox + (st.box.x + st.box.w) * st.fit;
        const py = r.top + st.oy + (st.box.y + st.box.h) * st.fit;
        const before = { ...st.box };
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: px - 2, clientY: py - 2, bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: px - 200, clientY: py - 120, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((r2) => setTimeout(r2, 40));
        return { before, after: { ...st.box }, fit: st.fit };
    })()`);
    check(resize.after.w < resize.before.w - 50 && resize.after.h < resize.before.h - 50,
        '拖右下角手柄框会缩小', `${resize.before.w}×${resize.before.h} → ${resize.after.w.toFixed(0)}×${resize.after.h.toFixed(0)}`);
    check(Math.abs(resize.after.x - 100) < 0.5 && Math.abs(resize.after.y - 100) < 0.5,
        '缩放时左上角锚点不动（框不漂）', `x=${resize.after.x.toFixed(1)} y=${resize.after.y.toFixed(1)}`);

    // 4. 框内拖动越界：夹在图片里，不出现负坐标
    const move = await exec(`(async () => {
        const A = window.App;
        const st = A._crop;
        const cv = document.getElementById('cropCanvas');
        const r = cv.getBoundingClientRect();
        const cx = r.left + st.ox + (st.box.x + st.box.w / 2) * st.fit;
        const cy = r.top + st.oy + (st.box.y + st.box.h / 2) * st.fit;
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx - 5000, clientY: cy - 5000, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((r2) => setTimeout(r2, 40));
        const atLeftTop = { ...st.box };
        // 再往右下拖出界：右下角不能越出图片
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 5000, clientY: cy + 5000, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((r2) => setTimeout(r2, 40));
        const atRightBottom = { ...st.box };
        return { atLeftTop, atRightBottom, W: st.W, H: st.H };
    })()`);
    check(move.atLeftTop.x === 0 && move.atLeftTop.y === 0, '框内往左上拖：停在 0,0（不越出照片）',
        `x=${move.atLeftTop.x} y=${move.atLeftTop.y}`);
    check(Math.abs(move.atRightBottom.x + move.atRightBottom.w - move.W) < 0.5
        && Math.abs(move.atRightBottom.y + move.atRightBottom.h - move.H) < 0.5,
        '框内往右下拖：右下角贴住照片边界',
        `${(move.atRightBottom.x + move.atRightBottom.w).toFixed(1)},${(move.atRightBottom.y + move.atRightBottom.h).toFixed(1)} vs ${move.W},${move.H}`);

    // 5. 框外拖动 = 重新框选
    const fresh = await exec(`(async () => {
        const A = window.App;
        const st = A._crop;
        // 先把框挪成中间一小块，四周留出"框外"
        st.box = { x: 300, y: 200, w: 200, h: 150 };
        A.drawCrop();
        const cv = document.getElementById('cropCanvas');
        const r = cv.getBoundingClientRect();
        const at = (x, y) => ({ clientX: r.left + st.ox + x * st.fit, clientY: r.top + st.oy + y * st.fit });
        const a = at(40, 40), b = at(260, 200);
        cv.dispatchEvent(new MouseEvent('mousedown', { ...a, bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { ...b, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((r2) => setTimeout(r2, 40));
        return { ...st.box };
    })()`);
    check(Math.abs(fresh.x - 40) < 2 && Math.abs(fresh.y - 40) < 2
        && Math.abs(fresh.w - 220) < 3 && Math.abs(fresh.h - 160) < 3,
        '框外拖拽重新框选（起点跟手）',
        `x=${fresh.x.toFixed(1)} y=${fresh.y.toFixed(1)} w=${fresh.w.toFixed(1)} h=${fresh.h.toFixed(1)}`);

    // 6. 应用：位图换成裁好的，宽高同步，弹层关闭
    const applied = await exec(`(async () => {
        const A = window.App;
        const st = A._crop;
        st.box = { x: 100, y: 50, w: 400, h: 300 };
        A.drawCrop();
        const before = A.image.el;
        // 直接 await：.click() + 固定 700ms 会在首次 PNG 编码较慢时读到还没换的位图（假红）
        const ret = await A.applyCrop();
        await new Promise((r) => setTimeout(r, 120));
        const im = A.image;
        return { ret, beforeSame: before === im.el, w: im.w, h: im.h,
                 nw: im.el && im.el.naturalWidth, nh: im.el && im.el.naturalHeight,
                 open: A._crop.open, display: getComputedStyle(document.getElementById('cropModal')).display,
                 status: A.statusMsg || '' };
    })()`);
    check(!applied.beforeSame && applied.nw === 400 && applied.nh === 300,
        '应用后照片位图变成 400×300', `natural=${applied.nw}×${applied.nh} beforeSame=${applied.beforeSame}`);
    check(applied.w === 400 && applied.h === 300, 'im.w/h 与位图一致', `${applied.w}×${applied.h}`);
    check(!applied.open && applied.display === 'none', '应用后弹层关闭');

    // 7. 再开：框铺满新图（不会还留着上一次的 400×300 坐标系）
    const reopen = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 240));
        return { box: { ...A._crop.box }, W: A._crop.W, H: A._crop.H };
    })()`);
    check(reopen.box.w === reopen.W && reopen.box.h === reopen.H && reopen.W === 400,
        '重新打开时框铺满当前（已裁过的）照片', JSON.stringify(reopen));

    // 8. 未改动点应用：不重编码，位图对象不变
    const noop = await exec(`(async () => {
        const A = window.App;
        const before = A.image.el;
        const ret = await A.applyCrop();
        await new Promise((r) => setTimeout(r, 120));
        return { ret, same: before === A.image.el, open: A._crop.open,
                 status: A.statusMsg || '' };
    })()`);
    check(noop.ret === false && noop.same && !noop.open, '没动框直接应用：不重编码、位图不变', noop.status);

    // 9. 取消 / Esc 不改图
    const cancel = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 200));
        const before = A.image.el;
        A._crop.box = { x: 10, y: 10, w: 100, h: 80 };
        A.drawCrop();
        document.getElementById('cropDiscard').click();
        await new Promise((r) => setTimeout(r, 120));
        const afterCancel = { same: before === A.image.el, open: A._crop.open };
        A.openCrop();
        await new Promise((r) => setTimeout(r, 200));
        A._crop.box = { x: 10, y: 10, w: 100, h: 80 };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 120));
        const afterEsc = { same: before === A.image.el, open: A._crop.open };
        return { afterCancel, afterEsc };
    })()`);
    check(cancel.afterCancel.same && !cancel.afterCancel.open, '取消：关闭且不改图');
    check(cancel.afterEsc.same && !cancel.afterEsc.open, 'Esc：关闭且不改图');

    // 10. 旋转 90° 后在弹层内应用：宽高互换
    const rotated = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 220));
        const before = { W: A._crop.W, H: A._crop.H };
        document.getElementById('cropRotate').click();
        await new Promise((r) => setTimeout(r, 80));
        const afterRotate = { W: A._crop.W, H: A._crop.H, box: { ...A._crop.box } };
        document.getElementById('cropApply').click();
        const t0 = Date.now();
        while (A._crop.open && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 80));
        return { before, afterRotate, nw: A.image.el.naturalWidth, nh: A.image.el.naturalHeight, w: A.image.w, h: A.image.h };
    })()`);
    check(rotated.afterRotate.W === rotated.before.H && rotated.afterRotate.H === rotated.before.W,
        '弹层内旋转 90°：工作图宽高互换',
        `${rotated.before.W}×${rotated.before.H} → ${rotated.afterRotate.W}×${rotated.afterRotate.H}`);
    check(rotated.nw === rotated.before.H && rotated.nh === rotated.before.W,
        '旋转后应用：位图宽高互换', `${rotated.nw}×${rotated.nh}`);

    // 11. 还原：清掉旋转与框选，回到当前位图本身
    const reset = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 220));
        const base = { W: A._crop.W, H: A._crop.H };
        document.querySelector('#cropRatios [data-r="1:1"]').click();
        document.getElementById('cropRotate').click();
        await new Promise((r) => setTimeout(r, 60));
        const changed = { W: A._crop.W, H: A._crop.H, key: A._crop.ratioKey };
        document.getElementById('cropRevert').click();
        await new Promise((r) => setTimeout(r, 60));
        const back = { W: A._crop.W, H: A._crop.H, key: A._crop.ratioKey, box: { ...A._crop.box } };
        A.closeCrop();
        return { base, changed, back };
    })()`);
    check(reset.changed.W === reset.base.H && reset.changed.key === '1:1',
        '旋转 + 1:1 同时生效', JSON.stringify({ w: reset.changed.W, h: reset.changed.H }));
    check(reset.back.W === reset.base.W && reset.back.H === reset.base.H && reset.back.key === 'free'
        && reset.back.box.w === reset.base.W,
        '还原：宽高与比例回到初始', JSON.stringify(reset.back));

    // 12. 键盘微调：方向键 1px、Shift 10px
    const nudge = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 200));
        A._crop.box = { x: 50, y: 50, w: 100, h: 100 };
        A.drawCrop();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, shiftKey: true }));
        await new Promise((r) => setTimeout(r, 30));
        const box = { ...A._crop.box };
        A.closeCrop();
        return box;
    })()`);
    check(nudge.x === 51 && nudge.y === 60, '方向键微调：→ 1px，Shift+↓ 10px',
        `x=${nudge.x} y=${nudge.y}`);

    // 13. 取的是"对的那一块"：四色象限图裁左上 → 裁出来的位图应该整块是红色
    //     （只验宽高不验内容的话，把 drawImage 的源坐标写反也照样全绿）
    await setupImage();
    const content = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 220));
        A._crop.box = { x: 0, y: 0, w: 400, h: 300 };
        A.drawCrop();
        await A.applyCrop();
        await new Promise((r) => setTimeout(r, 200));
        const im = A.image;
        const c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        const g = c.getContext('2d');
        g.drawImage(im.el, 0, 0, 8, 8);
        const d = g.getImageData(0, 0, 8, 8).data;
        const px = [d[0], d[1], d[2]];
        return { w: im.el.naturalWidth, h: im.el.naturalHeight, px };
    })()`);
    check(content.w === 400 && content.h === 300, '裁左上角：尺寸 400×300', `${content.w}×${content.h}`);
    check(Math.abs(content.px[0] - 204) < 8 && Math.abs(content.px[1] - 51) < 8 && Math.abs(content.px[2] - 51) < 8,
        '裁左上角：像素内容确实是左上那块（#CC3333 象限）', `rgb=${content.px.join(',')}`);

    // 14. 裁成正方形后画布跟着变方：证明引擎拿的是新位图，不是缓存里的旧图
    await setupImage();
    const square = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 220));
        document.querySelector('#cropRatios [data-r="1:1"]').click();
        await A.applyCrop();
        await new Promise((r) => setTimeout(r, 900));
        const cv = A.dom.canvas;
        return { iw: A.image.w, ih: A.image.h, cw: cv.width, ch: cv.height, ratio: cv.width / cv.height };
    })()`);
    check(square.iw === 600 && square.ih === 600, '1:1 裁切后照片是 600×600', `${square.iw}×${square.ih}`);
    check(Math.abs(square.ratio - 1) < 0.06, '画布按新比例重排（引擎没吃旧缓存）',
        `canvas=${square.cw}×${square.ch} ratio=${square.ratio.toFixed(3)}`);

    // 15. 自定义比例：5:7 / 2.35 / 全角冒号都能用；非法输入只标红不动框
    await setupImage();
    const custom = await exec(`(async () => {
        const A = window.App;
        A.openCrop();
        await new Promise((r) => setTimeout(r, 220));
        const inp = document.getElementById('cropRatioCustom');
        const type = async (text) => {
            inp.focus();
            inp.value = text;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 50));
        };
        await type('5:7');
        const five7 = { box: { ...A._crop.box }, ratio: A._crop.ratio, key: A._crop.ratioKey,
                        on: inp.classList.contains('is-on'),
                        chipsOn: document.querySelectorAll('#cropRatios .crop-chip.is-on').length };
        await type('2.35');
        const num = { ratio: A._crop.ratio, key: A._crop.ratioKey, box: { ...A._crop.box } };
        await type('5：7');
        const full = { ratio: A._crop.ratio, key: A._crop.ratioKey };
        inp.value = 'abc';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 40));
        const bad = { ratio: A._crop.ratio, bad: inp.classList.contains('is-bad'), key: A._crop.ratioKey };
        document.querySelector('#cropRatios [data-r="1:1"]').click();
        await new Promise((r) => setTimeout(r, 40));
        const afterChip = { val: inp.value, key: A._crop.ratioKey, on: inp.classList.contains('is-on') };
        return { five7, num, full, bad, afterChip, W: A._crop.W, H: A._crop.H };
    })()`);
    check(Math.abs(custom.five7.ratio - 5 / 7) < 0.001 && custom.five7.key === 'custom' && custom.five7.on,
        '自定义 5:7 生效并点亮输入框', `ratio=${custom.five7.ratio.toFixed(4)} key=${custom.five7.key}`);
    check(Math.abs(custom.five7.box.w / custom.five7.box.h - 5 / 7) < 0.002 && custom.five7.chipsOn === 0,
        '自定义比例下框就是 5:7，且预设 chip 全部熄灭',
        `${custom.five7.box.w.toFixed(1)}×${custom.five7.box.h.toFixed(1)} chips=${custom.five7.chipsOn}`);
    check(Math.abs(custom.num.ratio - 2.35) < 0.001 && custom.num.box.w <= custom.W + 0.5,
        '小数比例 2.35 生效并夹在照片宽度内',
        `ratio=${custom.num.ratio} w=${custom.num.box.w.toFixed(1)}`);
    check(Math.abs(custom.full.ratio - 5 / 7) < 0.001, '全角冒号「5：7」也认', `ratio=${custom.full.ratio.toFixed(4)}`);
    check(custom.bad.ratio === custom.full.ratio && custom.bad.bad && custom.bad.key === 'custom',
        '非法输入只标红、不动已有比例', `ratio=${custom.bad.ratio.toFixed(4)} bad=${custom.bad.bad}`);
    check(custom.afterChip.val === '' && custom.afterChip.key === '1:1' && !custom.afterChip.on,
        '点预设比例会清空自定义输入', `val="${custom.afterChip.val}" key=${custom.afterChip.key}`);

    // 16. 点「应用」时的失焦不能把用户拖好的框重置成最大框
    const blurGuard = await exec(`(async () => {
        const A = window.App;
        const inp = document.getElementById('cropRatioCustom');
        inp.focus(); inp.value = '1:1';
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 60));
        A._crop.box = { x: 50, y: 50, w: 200, h: 200 };
        A.drawCrop();
        inp.blur();                       // 模拟点按钮时输入框失焦
        await new Promise((r) => setTimeout(r, 60));
        const afterBlur = { ...A._crop.box };
        const ret = await A.applyCrop();
        await new Promise((r) => setTimeout(r, 120));
        return { afterBlur, w: A.image.w, h: A.image.h, ret };
    })()`);
    check(Math.abs(blurGuard.afterBlur.w - 200) < 0.5 && Math.abs(blurGuard.afterBlur.h - 200) < 0.5,
        '失焦不会重置已拖好的框', `${blurGuard.afterBlur.w.toFixed(0)}×${blurGuard.afterBlur.h.toFixed(0)}`);
    check(blurGuard.w === 200 && blurGuard.h === 200, '按拖好的框裁切（不是按 1:1 最大框）',
        `${blurGuard.w}×${blurGuard.h}`);

    // 17. 还原原图：裁过之后必须能回到最初那张（用户反馈"确认后回不去了"）
    await setupImage();
    const restore = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const origEl = im.el;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        A.openCrop(); await wait(220);
        A._crop.box = { x: 0, y: 0, w: 400, h: 300 };
        A.drawCrop();
        await A.applyCrop(); await wait(600);
        const afterCrop = { w: im.w, h: im.h, hasOrig: !!im.orig,
                            origIsOrig: !!(im.orig && im.orig.el === origEl),
                            sideVisible: !document.getElementById('btnRestoreOriginal').hidden };
        // 侧栏的「还原原图」：不打开弹层也能一键回到原图
        document.getElementById('btnRestoreOriginal').click();
        await wait(500);
        const sideRestore = { w: im.w, h: im.h, hasOrig: !!im.orig,
                              sameEl: im.el === origEl,
                              sideHidden: document.getElementById('btnRestoreOriginal').hidden };
        // 再裁一次，走弹层里的「还原原图」路径
        A.openCrop(); await wait(220);
        A._crop.box = { x: 0, y: 0, w: 400, h: 300 };
        A.drawCrop();
        await A.applyCrop(); await wait(600);
        A.openCrop(); await wait(240);
        const btn = document.getElementById('cropRestoreOriginal');
        const btnVisible = !!btn && !btn.hidden;
        btn.click(); await wait(140);
        const afterClick = { W: A._crop.W, H: A._crop.H, useOrig: !!A._crop.useOrig,
                             box: { ...A._crop.box },
                             status: A.statusMsg || '' };
        await A.applyCrop(); await wait(600);
        const afterApply = { w: im.w, h: im.h, hasOrig: !!im.orig,
                             sameEl: im.el === origEl, open: A._crop.open,
                             status: A.statusMsg || '' };
        return { afterCrop, sideRestore, btnVisible, afterClick, afterApply };
    })()`);
    check(restore.afterCrop.w === 400 && restore.afterCrop.hasOrig && restore.afterCrop.origIsOrig,
        '裁切后自动保留原图备份（同一 Image 对象）', JSON.stringify(restore.afterCrop));
    check(restore.afterCrop.sideVisible && restore.sideRestore.w === 800 && restore.sideRestore.sameEl
        && !restore.sideRestore.hasOrig && restore.sideRestore.sideHidden,
        '侧栏「还原原图」：一键换回 800×600 且按钮自己收起来',
        JSON.stringify(restore.sideRestore));
    check(restore.btnVisible, '重开裁切时「还原原图」按钮可见');
    check(restore.afterClick.W === 800 && restore.afterClick.H === 600 && restore.afterClick.useOrig
        && restore.afterClick.box.w === 800,
        '点「还原原图」：工作底图回到 800×600 整张', JSON.stringify(restore.afterClick.box));
    check(restore.afterApply.w === 800 && restore.afterApply.h === 600
        && !restore.afterApply.hasOrig && restore.afterApply.sameEl,
        '应用后照片真的回到原图（位图对象相同，没重新编码）',
        `${restore.afterApply.w}×${restore.afterApply.h} same=${restore.afterApply.sameEl}`);
    check(restore.afterApply.status.indexOf('还原') >= 0, '状态栏提示已还原', restore.afterApply.status);

    // 18. 右键菜单里的「还原原图」（连裁两次也只回到最初那张）
    const rename = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const box of [{ w: 500, h: 400 }, { w: 300, h: 200 }]) {
            A.openCrop(); await wait(200);
            A._crop.box = { x: 0, y: 0, w: box.w, h: box.h };
            A.drawCrop();
            await A.applyCrop(); await wait(500);
        }
        const twice = { w: im.w, h: im.h, origW: im.orig && im.orig.w, origH: im.orig && im.orig.h };
        const ok = A.restoreOriginalPhoto();
        await wait(300);
        return { twice, ok, w: im.w, h: im.h, hasOrig: !!im.orig, status: A.statusMsg || '' };
    })()`);
    check(rename.twice.w === 300 && rename.twice.origW === 800 && rename.twice.origH === 600,
        '连裁两次：原图备份仍是最初的 800×600', JSON.stringify(rename.twice));
    check(rename.ok && rename.w === 800 && rename.h === 600 && !rename.hasOrig,
        '右键「还原原图」直接把照片换回原图', `${rename.w}×${rename.h} orig=${rename.hasOrig}`);

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
