// 曲线编辑器：外框恒为正方形 + 右键菜单（单个控制点删除 / 通道菜单 / 复制粘贴通道设置）。
// 用法：node tools/run-electron.js tools/test-curve-ctx.js
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
ipcMain.handle('load-acr-shadows', () => {
    try {
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin'));
        if (raw.length < 34 || raw.slice(0, 4).toString('ascii') !== 'CRS2') return null;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
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

// 中灰底图，纯前端即可成像
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

    await exec(`(async () => { if (window.QfsAcr) await QfsAcr.ensure(); return true; })()`);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(800);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    // 建图 + 进调色页签 + 展开曲线组
    const s0 = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'c', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        if (A.invalidateGrade) A.invalidateGrade(im);
        A.scheduleRender(true);
        if (A.switchTab) A.switchTab('grade');
        const grp = document.getElementById('grpCurve');
        if (grp) grp.classList.remove('collapsed');
        await new Promise((r) => setTimeout(r, 350));
        const cv = document.getElementById('curveCanvas');
        return {
            hasApp: !!A.initCurve, hasCv: !!cv,
            w: cv ? cv.clientWidth : 0, h: cv ? cv.clientHeight : 0,
            active: document.getElementById('panel-grade').classList.contains('active')
        };
    })()`);
    check(s0.hasApp && s0.hasCv && s0.active, '曲线面板已就绪（调色页签激活、画布存在）', JSON.stringify(s0));

    // ① 外框恒为正方形
    check(s0.w > 40 && s0.h > 40, '曲线画布有真实布局尺寸（可测量）', `w=${s0.w} h=${s0.h}`);
    check(Math.abs(s0.w - s0.h) <= 2, '曲线外框恒为正方形（宽≈高，差≤2px）', `w=${s0.w} h=${s0.h}`);

    // ② 加一个中间控制点，右键它 → 菜单出现「删除此控制点」
    const menuOnPoint = await exec(`(async () => {
        const A = window.App;
        A.setCurve('rgb', [[0, 0], [0.5, 0.6], [1, 1]]);
        A.drawCurve();
        await new Promise((r) => setTimeout(r, 60));
        const cv = document.getElementById('curveCanvas');
        const r = cv.getBoundingClientRect();
        const pad = 8;
        const px = r.left + pad + 0.5 * (r.width - pad * 2);
        const py = r.top + (r.height - pad - 0.6 * (r.height - pad * 2));
        const ev = new MouseEvent('contextmenu', { clientX: px, clientY: py, bubbles: true, cancelable: true });
        cv.dispatchEvent(ev);
        const m = document.querySelector('.curve-ctx-menu');
        const items = m ? Array.prototype.slice.call(m.querySelectorAll('.curve-ctx-item')).map((x) => x.textContent) : [];
        return { hasMenu: !!m, items, count: (A.curveOf(A.image) || {}).rgb ? A.curveOf(A.image).rgb.length : 0 };
    })()`);
    check(menuOnPoint.hasMenu, '右键命中中间控制点 → 弹出右键菜单', JSON.stringify(menuOnPoint));
    check(menuOnPoint.items.length === 1 && /删除此控制点/.test(menuOnPoint.items[0]),
        '该菜单只有「删除此控制点」一项（端点不允许删）', JSON.stringify(menuOnPoint.items));
    check(menuOnPoint.count === 3, '右键前该通道有 3 个控制点（含端点）', `count=${menuOnPoint.count}`);

    // ③ 点菜单项删除 → 控制点回到 2 个
    const afterDel = await exec(`(async () => {
        const A = window.App;
        const item = document.querySelector('.curve-ctx-menu .curve-ctx-item');
        if (item) item.click();
        await new Promise((r) => setTimeout(r, 60));
        const m = document.querySelector('.curve-ctx-menu');
        const cv = A.curveOf(A.image);
        return { menuGone: !m, count: (cv && cv.rgb) ? cv.rgb.length : 0, noRgb: !cv || !cv.rgb };
    })()`);
    check(afterDel.menuGone, '点完菜单后浮层已关闭', JSON.stringify(afterDel));
    check(afterDel.noRgb || afterDel.count === 2, '删除后该通道回到 2 个端点（或整条回线性被清掉）', JSON.stringify(afterDel));

    // ④ 空白处右键 → 通道菜单（重置该通道 / 重置所有通道 / 复制通道设置 / 粘贴通道设置 / 显示所有曲线）
    const menuOnBlank = await exec(`(async () => {
        const A = window.App;
        // 先确保有可调曲线，便于验证「重置该通道」
        A.setCurve('rgb', [[0, 0], [0.5, 0.6], [1, 1]]);
        A.drawCurve();
        await new Promise((r) => setTimeout(r, 60));
        const cv = document.getElementById('curveCanvas');
        const r = cv.getBoundingClientRect();
        const pad = 8;
        // 取 (0.12, 0.9)：离两端点都远，且曲线在该处没有控制点 → 命中空白
        const px = r.left + pad + 0.12 * (r.width - pad * 2);
        const py = r.top + (r.height - pad - 0.9 * (r.height - pad * 2));
        const ev = new MouseEvent('contextmenu', { clientX: px, clientY: py, bubbles: true, cancelable: true });
        cv.dispatchEvent(ev);
        const m = document.querySelector('.curve-ctx-menu');
        const items = m ? Array.prototype.slice.call(m.querySelectorAll('.curve-ctx-item')) : [];
        const texts = items.map((x) => x.textContent);
        const paste = items.find((x) => /粘贴通道设置/.test(x.textContent));
        return {
            hasMenu: !!m, texts,
            pasteDisabled: !!(paste && paste.classList.contains('is-disabled')),
            seps: m ? m.querySelectorAll('.curve-ctx-sep').length : 0
        };
    })()`);
    check(menuOnBlank.hasMenu, '空白处右键 → 弹出通道菜单', JSON.stringify(menuOnBlank));
    check(menuOnBlank.texts.length === 5
          && /重置该通道/.test(menuOnBlank.texts[0])
          && /重置所有通道/.test(menuOnBlank.texts[1])
          && /复制通道设置/.test(menuOnBlank.texts[2])
          && /粘贴通道设置/.test(menuOnBlank.texts[3])
          && /显示所有曲线/.test(menuOnBlank.texts[4]),
        '通道菜单含「重置该通道 / 重置所有通道 / 复制通道设置 / 粘贴通道设置 / 显示所有曲线」五项', JSON.stringify(menuOnBlank.texts));
    check(menuOnBlank.seps === 2, '菜单有 2 条分隔线（重置组与复制粘贴组、复制粘贴组与显示组）', `seps=${menuOnBlank.seps}`);
    check(menuOnBlank.pasteDisabled, '还没复制过时「粘贴通道设置」为灰色禁用态', JSON.stringify(menuOnBlank));

    // ⑤ 复制通道设置 / 粘贴通道设置：把 R 通道的曲线复制到 G 通道
    const copyPaste = await exec(`(async () => {
        const A = window.App;
        const cv = document.getElementById('curveCanvas');
        const open = (x, y) => cv.dispatchEvent(new MouseEvent('contextmenu',
            { clientX: x, clientY: y, bubbles: true, cancelable: true }));
        const rect = () => cv.getBoundingClientRect();
        const blankPt = () => {
            const r = rect(); const pad = 8;
            return { x: r.left + pad + 0.12 * (r.width - pad * 2), y: r.top + (r.height - pad - 0.9 * (r.height - pad * 2)) };
        };
        const clickItem = (re) => {
            const items = Array.prototype.slice.call(document.querySelectorAll('.curve-ctx-menu .curve-ctx-item'));
            const it = items.find((x) => re.test(x.textContent));
            if (it && !it.classList.contains('is-disabled')) { it.click(); return true; }
            return false;
        };
        // 给 R 通道一个特征曲线，切到 R
        A.setCurve('r', [[0, 0], [0.25, 0.7], [0.75, 0.3], [1, 1]]);
        A._curveChan = 'r';
        A.drawCurve();
        await new Promise((r) => setTimeout(r, 40));
        let p = blankPt(); open(p.x, p.y);
        await new Promise((r) => setTimeout(r, 20));
        const copied = clickItem(/复制通道设置/);
        const bufLen = A._curveCopyBuf ? A._curveCopyBuf.length : 0;
        // 切到 G，先确保 G 是直线，再粘贴
        A.setCurve('g', [[0, 0], [1, 1]]);
        A._curveChan = 'g';
        A.drawCurve();
        await new Promise((r) => setTimeout(r, 40));
        p = blankPt(); open(p.x, p.y);
        await new Promise((r) => setTimeout(r, 20));
        const pasted = clickItem(/粘贴通道设置/);
        const g = (A.curveOf(A.image) || {}).g || null;
        return {
            copied, bufLen, pasted,
            gLen: g ? g.length : 0,
            gSame: g && g.length === 4
                && Math.abs(g[1][0] - 0.25) < 1e-6 && Math.abs(g[1][1] - 0.7) < 1e-6
                && Math.abs(g[2][0] - 0.75) < 1e-6 && Math.abs(g[2][1] - 0.3) < 1e-6,
            rSameG: (() => {
                const r2 = (A.curveOf(A.image) || {}).r || [];
                return g && r2.length === 4
                    && Math.abs(g[1][0] - r2[1][0]) < 1e-6 && Math.abs(g[1][1] - r2[1][1]) < 1e-6
                    && Math.abs(g[2][0] - r2[2][0]) < 1e-6 && Math.abs(g[2][1] - r2[2][1]) < 1e-6;
            })()
        };
    })()`);
    check(copyPaste.copied && copyPaste.bufLen === 4, '右键「复制通道设置」把当前通道（R，4 点）存入缓冲', JSON.stringify(copyPaste));
    check(copyPaste.pasted && copyPaste.gLen === 4, '右键「粘贴通道设置」把缓冲套到当前通道（G）', JSON.stringify(copyPaste));
    check(copyPaste.gSame && copyPaste.rSameG, '粘贴后 G 通道曲线与复制的 R 完全一致（含中间点坐标）', JSON.stringify(copyPaste));

    // ⑥ 点「显示所有曲线」→ 开关翻转
    const toggle = await exec(`(async () => {
        const A = window.App;
        const cv = document.getElementById('curveCanvas');
        const r = cv.getBoundingClientRect(); const pad = 8;
        cv.dispatchEvent(new MouseEvent('contextmenu',
            { clientX: r.left + pad + 0.12 * (r.width - pad * 2), clientY: r.top + (r.height - pad - 0.9 * (r.height - pad * 2)), bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 20));
        const items = Array.prototype.slice.call(document.querySelectorAll('.curve-ctx-menu .curve-ctx-item'));
        const showAll = items.find((x) => /显示所有曲线/.test(x.textContent));
        if (showAll) showAll.click();
        await new Promise((r) => setTimeout(r, 40));
        return { showAll: !!A._curveShowAll, menuGone: !document.querySelector('.curve-ctx-menu') };
    })()`);
    check(toggle.showAll, '点「显示所有曲线」后开关置真（drawCurve 会画全部通道）', JSON.stringify(toggle));
    check(toggle.menuGone, '通道菜单点完也关闭', JSON.stringify(toggle));

    // ⑥ 越界 / 外部点击关闭
    const outside = await exec(`(async () => {
        const A = window.App;
        const cv = document.getElementById('curveCanvas');
        const r = cv.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', { clientX: r.left + 4, clientY: r.top + 4, bubbles: true, cancelable: true });
        cv.dispatchEvent(ev);
        const opened = !!document.querySelector('.curve-ctx-menu');
        // 在画布外点一下 → 应自动关闭
        document.body.dispatchEvent(new MouseEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
        return { opened, closed: !document.querySelector('.curve-ctx-menu') };
    })()`);
    check(outside.opened && outside.closed, '右键打开菜单后，在外部点一下能自动关闭', JSON.stringify(outside));

    await exec(`(() => { if (window.App && window.App._closeCurveCtxMenu) window.App._closeCurveCtxMenu(); return true; })()`);
    console.log(failures.length ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('') : '\nALL PASS');
    app.quit();
    process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error('FAIL', e); app.quit(); process.exit(1); });
