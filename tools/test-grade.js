// 基础调色回归：7 个滑块 → 一条 CSS filter → 烘焙进离屏画布 → 渲染/导出取源。
// 用法：node tools/run-electron.js tools/test-grade.js
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
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 中灰底 + 纯黑/纯白两个角：用来验证「高光/阴影两端不动」
const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000000'; g.fillRect(0, 0, c.width / 2, c.height / 2);
    g.fillStyle = '#ffffff'; g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
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
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    await exec(`window.__mk = ${MAKE_IMAGE}; true`);
    const setup = `async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'g', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        if (A.invalidateGrade) A.invalidateGrade(im);
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 400));
        return { has: !!A.GRADE_FIELDS, sliders: A.GRADE_FIELDS.map(f => !!document.getElementById('slGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1))) };
    }`;

    // ── 1. 模块与控件 ──
    const s0 = await exec(`(${setup})()`);
    check(s0.has && s0.sliders.every(Boolean), '调色模块已加载，9 个滑块都在「调色」页签',
        `sliders=${s0.sliders.join(',')}`);
    const grp = await exec(`(() => {
        const g = document.getElementById('grpGrade');
        const tab = document.querySelector('#inspTabs .tab[data-tab="grade"]');
        if (tab) tab.click();
        const lightGrps = Array.prototype.slice.call(document.querySelectorAll('#panel-grade .ctl-grp-light'));
        return { inGrade: !!g.closest('#panel-grade'), inToolbar: !!g.closest('#toolbar'),
                 hasTab: !!tab, isToolTab: !!(tab && tab.classList.contains('tab-tool')),
                 active: document.getElementById('panel-grade').classList.contains('active'),
                 canvasStill: document.getElementById('panel-canvas').classList.contains('active'),
                 lightGroups: lightGrps.length,
                 lightInGrade: lightGrps.every((x) => !!x.closest('#panel-grade')),
                 noLightPanel: !document.getElementById('panel-light'),
                 noLightTab: !document.querySelector('#inspTabs [data-tab="light"]'),
                 title: (g.querySelector('.pg-title') || {}).textContent || '' };
    })()`);
    check(grp.inGrade && !grp.inToolbar && grp.hasTab && !grp.isToolTab
          && grp.active && !grp.canvasStill && /调色/.test(grp.title),
        '调色挂在「画布」这一行的页签里（不再属于工具行），点击能切到面板', JSON.stringify(grp));
    check(grp.lightGroups === 3 && grp.lightInGrade && grp.noLightPanel && grp.noLightTab,
        '原「光影」三组（暗角/漏光/颗粒）已并入调色页签，独立页签与面板已移除',
        JSON.stringify({ n: grp.lightGroups, inGrade: grp.lightInGrade, noPanel: grp.noLightPanel, noTab: grp.noLightTab }));
    await exec(`(() => { if (window.App.switchTab) window.App.switchTab('canvas'); })()`);

    // ── 2. 中性时不烘焙，取源就是原图 ──
    const neutral = await exec(`(() => {
        const A = window.App, im = A.image;
        const src = window.photoSrcOf(im);
        return { same: src === im.el, hasCache: !!(im._grade && im._grade.canvas) };
    })()`);
    check(neutral.same && !neutral.hasCache, '没调色时零开销：取源就是原图、不建缓存',
        JSON.stringify(neutral));

    // ── 3. 曝光：真把像素提亮了 ──
    const exp = await exec(`(async () => {
        const A = window.App;
        const px = (src) => { const c = document.createElement('canvas'); c.width = 4; c.height = 4;
            const g = c.getContext('2d'); g.drawImage(src, 0, 0, 4, 4);
            return Array.from(g.getImageData(2, 2, 1, 1).data).slice(0, 3); };
        const before = px(A.image.el);
        A.setGrade({ exp: 60, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const src = window.photoSrcOf(A.image);
        // 采样点必须落在右上那块中灰（左上黑、右下白是锚点，动不得）
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const mid = Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
        return { before, mid, isCanvas: src !== A.image.el, tag: src && src.tagName,
                 nw: src && src.naturalWidth, nh: src && src.naturalHeight };
    })()`);
    check(exp.isCanvas && exp.tag === 'CANVAS', '调色后取源变成离屏画布', `tag=${exp.tag}`);
    check(exp.nw === 600 && exp.nh === 400, '烘焙画布补了 naturalWidth/naturalHeight（引擎靠它算比例）',
        `${exp.nw}×${exp.nh}`);
    check(exp.mid[0] > 150 && exp.mid[0] > 128 + 15, '曝光 +60：中灰确实变亮',
        `灰 128 → ${exp.mid.join(',')}`);

    // ── 4. 高光/阴影两端不动 ──
    const ends = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
        const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
        return { black: at(20, 20), white: at(580, 380), mid: at(450, 100) };
    })()`);
    check(ends.black[0] <= 1 && ends.white[0] >= 254,
        '阴影/高光满档也不动纯黑纯白（两端锚死）', `黑=${ends.black[0]} 白=${ends.white[0]}`);
    check(ends.mid[0] > 128 + 60, '阴影满档把中间调明显抬起', `中灰 128 → ${ends.mid[0]}`);

    // ── 5. 色温：暖 → R 升 B 降 ──
    const temp = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 100, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
        const p = Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
        return p;
    })()`);
    check(temp[0] > 128 + 8 && temp[2] < 128 - 8, '色温 +100（暖）：R 升 B 降', `rgb=${temp.join(',')}`);

    // ── 6. 饱和度 -100 = 黑白 ──
    const gray = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 0, con: 0, sat: -100, temp: 100, tint: 0, hi: 0, sh: 0 }, { full: true });
        await new Promise((r) => setTimeout(r, 120));
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d'); g.drawImage(window.photoSrcOf(A.image), 0, 0);
        return Array.from(g.getImageData(450, 100, 1, 1).data).slice(0, 3);
    })()`);
    check(Math.abs(gray[0] - gray[1]) <= 2 && Math.abs(gray[1] - gray[2]) <= 2,
        '饱和度 -100 得到灰阶', `rgb=${gray.join(',')}`);

    // ── 7. 渲染真的用了调色画布 ──
    const render = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 100, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const cv = A.dom.canvas;
        const c = document.createElement('canvas'); c.width = 40; c.height = 40;
        const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 40, 40);
        const d = g.getImageData(0, 0, 40, 40).data;
        let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i];
        const bright = Math.round(sum / (d.length / 4));
        A.setGrade({ exp: -100, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 900));
        const g2 = c.getContext('2d'); g2.clearRect(0, 0, 40, 40); g2.drawImage(cv, 0, 0, 40, 40);
        const d2 = g2.getImageData(0, 0, 40, 40).data;
        let sum2 = 0; for (let i = 0; i < d2.length; i += 4) sum2 += d2[i];
        return { bright, dark: Math.round(sum2 / (d2.length / 4)) };
    })()`);
    check(render.bright > render.dark + 8, '曝光 ±100 在画布上看得出差别（渲染走的是调色源）',
        `亮=${render.bright} 暗=${render.dark}`);

    // ── 8. 每张照片独立 ──
    const perImage = await exec(`(async () => {
        const A = window.App;
        const el2 = await window.__mk(600, 400);
        const im2 = { el: el2, name: 'g2', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [A.image, im2];
        A.setGrade({ exp: 80, con: 0, sat: 40, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const p1 = JSON.parse(JSON.stringify(A.image.grade));
        A.image = im2; A.currentIdx = 1;
        if (A.invalidateGrade) A.invalidateGrade(im2);
        if (A.syncGradeUI) A.syncGradeUI();
        const uiExp = document.getElementById('slGradeExp').value;
        const p2 = JSON.parse(JSON.stringify(A.gradeOf(im2)));
        return { p1, p2, uiExp };
    })()`);
    check(perImage.p1.exp === 80 && perImage.p2.exp === 0, '调色参数挂在照片上，互不串台',
        `图1=${perImage.p1.exp} 图2=${perImage.p2.exp}`);
    check(perImage.uiExp === '0', '切图后滑块回显新照片的参数', `滑块=${perImage.uiExp}`);

    // ── 8.5 精确数字框跟随（syncGradeUI 必须走 updateLabel） ──
    const numSync = await exec(`(() => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 33, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        const num = document.querySelector('#rowGradeExp .pval-num');
        const val = num && !num.hidden ? num.value : null;
        const lbl = document.getElementById('lblGradeExp').textContent;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        return { val, lbl };
    })()`);
    check(numSync.val === '33' && numSync.lbl === '+33',
        '编程设值后数字框与标签同步（走 updateLabel）', JSON.stringify(numSync));

    // ── 9. 应用到全部 ──
    const all = await exec(`(async () => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 55, con: 20, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.applyGradeToAll();
        return A.images.map((im) => (im.grade ? im.grade.exp : null));
    })()`);
    check(all.length === 2 && all.every((v) => v === 55), '「应用到全部」把参数复制给其余照片',
        JSON.stringify(all));

    // ── 10. 重置 ──
    const reset = await exec(`(async () => {
        const A = window.App;
        document.getElementById('btnGradeReset').click();
        await new Promise((r) => setTimeout(r, 200));
        const im = A.image;
        return { neutral: A.isNeutralGrade(im.grade), same: window.photoSrcOf(im) === im.el,
                 ui: document.getElementById('slGradeExp').value,
                 status: A.statusMsg || '' };
    })()`);
    check(reset.neutral && reset.same && reset.ui === '0',
        '重置：参数归零、取源回到原图、滑块回 0', JSON.stringify(reset));

    // ── 11. 拖动用降采样，松手补全分辨率 ──
    const levels = await exec(`(async () => {
        const A = window.App, im = A.image;
        const big = await window.__mk(3000, 2000);
        im.el = big; im.w = 3000; im.h = 2000;
        A.invalidateGrade(im);
        A.setGrade({ exp: 30, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        await new Promise((r) => setTimeout(r, 60));
        const low = im._grade.low ? [im._grade.low.width, im._grade.low.height] : null;
        // 取源报的照片尺寸必须恒等于原图:引擎按它算 EXIF 自适应字号
        // (档位 × clamp(照片宽/1200)),报成 1600 会让相机型号在拖动过程中变小。
        const lowNat = window.photoSrcOf(im)
            ? [window.photoSrcOf(im).naturalWidth, window.photoSrcOf(im).naturalHeight] : null;
        A.rebuildGrade('full');
        await new Promise((r) => setTimeout(r, 60));
        const full = im._grade.canvas ? [im._grade.canvas.width, im._grade.canvas.height] : null;
        const fullNat = window.photoSrcOf(im)
            ? [window.photoSrcOf(im).naturalWidth, window.photoSrcOf(im).naturalHeight] : null;
        return { low, full, lowGone: !im._grade.low, lowNat, fullNat };
    })()`);
    check(levels.low && levels.low[0] === 1600, '拖动中先出 1600px 降采样（不然每帧烘焙 600 万像素）',
        `low=${levels.low && levels.low.join('×')}`);
    check(levels.full && levels.full[0] === 3000 && levels.full[1] === 2000,
        '松手后补成原图尺寸（导出的「原图」档位不会缩水）',
        `full=${levels.full && levels.full.join('×')}`);
    check(levels.lowNat && levels.lowNat[0] === 3000 && levels.lowNat[1] === 2000
          && levels.fullNat && levels.fullNat[0] === 3000 && levels.fullNat[1] === 2000,
        '降采样/全分辨率都报原图尺寸（EXIF 自适应字号不随拖动跳变）',
        `low=${levels.lowNat && levels.lowNat.join('×')} full=${levels.fullNat && levels.fullNat.join('×')}`);

    // ── 12. 草稿能存下参数 ──
    const draft = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ exp: 42, con: 0, sat: -15, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const im = A.image;
        return { has: !!(im.grade && !A.isNeutralGrade(im.grade)), exp: im.grade && im.grade.exp,
                 serializable: JSON.stringify(im.grade) };
    })()`);
    check(draft.has && draft.exp === 42 && /"exp":42/.test(draft.serializable),
        '调色是纯数字，可以原样存进草稿（重启后重放，无损）', draft.serializable);

    // ── 13. 相框样式管线也必须吃调色 ──
    // 带 photoFrameStyle 的预设走 engine-styles.js 的 renderPhotoFrame,那条管线曾经
    // 直取 app.image.el,套了这类预设后调色滑块完全不起作用。
    const framed = await exec(`(async () => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'VINTAGE';
        A.setTpl(A.image, A.template);
        const sample = () => {
            const cv = A.dom.canvas;
            const c = document.createElement('canvas'); c.width = 60; c.height = 60;
            const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 60, 60);
            const d = g.getImageData(0, 0, 60, 60).data;
            let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
            return Math.round(s / (d.length / 4) / 3);
        };
        const at = async (exp) => {
            A.setGrade({ exp, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
            A.scheduleRender(true);
            await new Promise((r) => setTimeout(r, 900));
            return sample();
        };
        const mid = await at(0), bright = await at(100), dark = await at(-100);
        const used = A.template.photoFrameStyle;
        A.template.photoFrameStyle = 'NONE';
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        A.scheduleRender(true);
        return { mid, bright, dark, used };
    })()`);
    check(framed.bright > framed.mid + 4 && framed.mid > framed.dark + 4,
        '相框样式（photoFrameStyle）管线同样吃调色', JSON.stringify(framed));

    // ── 14. 调色后胶片条缩略图跟着重画（否则用户以为“调了没变化”） ──
    const thumbSync = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        if (A.renderFramedThumb) A.renderFramedThumb(im);
        const before = im.thumb || '';
        const s = document.getElementById('slGradeExp');
        s.value = '80';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
        const after = im.thumb || '';
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 });
        return { hasBefore: before.length > 100, changed: before !== after };
    })()`);
    check(thumbSync.hasBefore && thumbSync.changed,
        '停手后胶片条缩略图重画成调色后的样子', JSON.stringify(thumbSync));

    // ── 15. 双击滑块：该档归零，其余档不受牵连 ──
    const dbl = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 60, con: 40, sat: -30, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        const s = document.getElementById('slGradeExp');
        const numEl = document.querySelector('#rowGradeExp .pval-num');
        const before = { v: s.value, lbl: document.getElementById('lblGradeExp').textContent };
        s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        return { before, after: { v: s.value, lbl: document.getElementById('lblGradeExp').textContent,
                 num: numEl && numEl.value, exp: im.grade.exp, con: im.grade.con, sat: im.grade.sat } };
    })()`);
    check(dbl.before.v === '60' && dbl.after.v === '0' && dbl.after.exp === 0
          && dbl.after.con === 40 && dbl.after.sat === -30 && dbl.after.lbl === '0'
          && dbl.after.num === '0',
        '双击滑块：该档归零，其余档不动', JSON.stringify(dbl));

    // ── 16. 曲线编辑器 ──
    const curveUi = await exec(`(() => {
        const cv = document.getElementById('curveCanvas');
        const btns = Array.prototype.slice.call(document.querySelectorAll('#curveChans .curve-chan'));
        const b = btns.find(x => x.dataset.chan === 'b');
        if (b) b.click();
        return { has: !!cv, chans: btns.map(x => x.dataset.chan), cur: window.App._curveChan,
                 hasReset: !!document.getElementById('btnCurveReset') };
    })()`);
    check(curveUi.has && curveUi.chans.join(',') === 'rgb,r,g,b' && curveUi.cur === 'b' && curveUi.hasReset,
        '曲线控件：画布 + RGB/红/绿/蓝 四个通道可切换', JSON.stringify(curveUi));

    // 抬黑点：RGB 曲线左下角抬到 0.3 → 纯黑区变成灰
    const lift = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.3], [1, 1]] } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const src = window.photoSrcOf(im);
        // 前面的用例把照片换成了 3000×2000：按原图尺寸取样，别写死坐标
        const W = src.naturalWidth || 600, H = src.naturalHeight || 400;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        const at = (fx, fy) => Array.from(g.getImageData(Math.round(W * fx), Math.round(H * fy), 1, 1).data).slice(0, 3);
        const black = at(0.25, 0.25);     // 左上 = 纯黑象限
        const white = at(0.75, 0.75);     // 右下 = 纯白象限
        return { black, white, isCanvas: src !== im.el, W, H };
    })()`);
    check(lift.isCanvas && lift.black[0] > 60 && lift.black[0] < 95 && lift.white[0] > 245,
        '曲线抬黑点：纯黑区变灰、纯白不动', JSON.stringify(lift));

    // 单通道曲线：只动红
    const chanCurve = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { r: [[0, 0], [0.5, 0.8], [1, 1]] } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const src = window.photoSrcOf(im);
        const W = src.naturalWidth || 600, H = src.naturalHeight || 400;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0);
        // 右上 = 中灰（128）象限
        return { px: Array.from(g.getImageData(Math.round(W * 0.75), Math.round(H * 0.25), 1, 1).data).slice(0, 3) };
    })()`);
    check(chanCurve.px[0] > 185 && Math.abs(chanCurve.px[1] - 128) <= 3 && Math.abs(chanCurve.px[2] - 128) <= 3,
        '红通道曲线只动红色，绿蓝不动', JSON.stringify(chanCurve.px));

    // 单调插值：不过冲（Catmull-Rom 会冲出控制点范围，单调插值不会）
    const mono = await exec(`(() => {
        const C = window.QfsCurve;
        const pts = [[0, 0], [0.25, 0.9], [0.5, 0.95], [1, 1]];
        const t = C.monotoneTable(pts);
        let maxV = -1, minV = 2, bad = 0;
        for (const v of t) { if (!isFinite(v)) bad++; if (v > maxV) maxV = v; if (v < minV) minV = v; }
        return { n: t.length, bad, maxV: +maxV.toFixed(4), minV: +minV.toFixed(4), end: +t[255].toFixed(3) };
    })()`);
    check(mono.n === 256 && mono.bad === 0 && mono.maxV <= 1.0001 && mono.minV >= -0.0001 && mono.end === 1,
        '曲线用单调插值：不过冲、不越界', JSON.stringify(mono));

    // 曲线参与中性判断 + 重置
    const curveReset = await exec(`(async () => {
        const A = window.App, im = A.image;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.2], [1, 1]] } });
        const dirty = !A.isNeutralGrade(im.grade);
        document.getElementById('btnCurveReset').click();
        await new Promise((r) => setTimeout(r, 200));
        return { dirty, after: A.isNeutralGrade(im.grade), curve: im.grade.curve,
                 srcIsOrig: window.photoSrcOf(im) === im.el };
    })()`);
    check(curveReset.dirty && curveReset.after && !curveReset.curve && curveReset.srcIsOrig,
        '曲线算「已调整」，重置后归零并回到原图取源', JSON.stringify(curveReset));

    // 模拟鼠标：在空白处按下 = 加控制点并跟着拖动
    const dragCurve = await exec(`(() => {
        const A = window.App;
        const rgbBtn = Array.prototype.slice.call(document.querySelectorAll('#curveChans .curve-chan'))
            .find(x => x.dataset.chan === 'rgb');
        if (rgbBtn) rgbBtn.click();
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0, curve: null });
        A.switchTab('grade');            // 面板必须可见，否则画布没有布局尺寸
        const el = document.getElementById('curveCanvas');
        const r = el.getBoundingClientRect();
        const pad = 8;
        const at = (fx, fy) => ({ x: r.left + pad + fx * (r.width - pad * 2),
                                  y: r.top + r.height - pad - fy * (r.height - pad * 2) });
        const ev = (type, p) => el.dispatchEvent(new PointerEvent(type,
            { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }));
        const p0 = at(0.5, 0.7);        // 中间偏上：往上提亮中间调
        ev('pointerdown', p0);
        const n1 = A.curvePoints('rgb').length;
        const p1 = at(0.5, 0.85);
        ev('pointermove', p1);
        const pts = A.curvePoints('rgb');
        ev('pointerup', p1);
        return { n1, n2: pts.length, mid: pts[1], graded: !!A.image.grade.curve };
    })()`);
    check(dragCurve.n1 === 3 && dragCurve.n2 === 3 && dragCurve.graded
          && Math.abs(dragCurve.mid[0] - 0.5) < 0.02 && dragCurve.mid[1] > 0.8,
        '鼠标在曲线画布上按下即加点、拖动改形', JSON.stringify(dragCurve));

    // 「应用到全部」：曲线必须深拷贝，不能多张共用一份控制点
    const curveCopy = await exec(`(() => {
        const A = window.App;
        A.image = A.images[0]; A.currentIdx = 0;
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0,
                     curve: { rgb: [[0, 0.15], [1, 1]] } });
        A.applyGradeToAll();
        const a = A.images[0].grade.curve, b = A.images[1].grade.curve;
        a.rgb[0][1] = 0.9;                      // 只改第一张
        return { same: a === b, b0: b.rgb[0][1], j: JSON.stringify(A.images[1].grade).indexOf('curve') > 0 };
    })()`);
    check(!curveCopy.same && curveCopy.b0 === 0.15 && curveCopy.j,
        '「应用到全部」深拷贝曲线（改一张不串台，可存草稿）', JSON.stringify(curveCopy));

    // ══ 扩展档位：细节 / 校准 / 混色器 ══════════════════════════

    // 纯红/纯绿/纯蓝/中灰四象限，用来验证按色相的作用范围
    await exec(`window.__mkc = async () => {
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#ff0000'; g.fillRect(0, 0, 300, 200);
        g.fillStyle = '#00ff00'; g.fillRect(300, 0, 300, 200);
        g.fillStyle = '#0000ff'; g.fillRect(0, 200, 300, 200);
        g.fillStyle = '#808080'; g.fillRect(300, 200, 300, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        return el;
    }; true`);

    const sampleQuads = `(() => {
        const src = window.photoSrcOf(window.App.image);
        const c = document.createElement('canvas'); c.width = 300; c.height = 200;
        const g = c.getContext('2d'); g.drawImage(src, 0, 0, 300, 200);
        const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
        return { red: at(75, 50), green: at(225, 50), blue: at(75, 150), gray: at(225, 150) };
    })()`;

    // ── 17. 三组新滑块都挂在面板上 ──
    const extUi = await exec(`(() => {
        const ids = ['slDetClar', 'slDetTex', 'slDetDhz', 'slCalRH', 'slCalRS', 'slCalGH',
            'slCalGS', 'slCalBH', 'slCalBS'];
        const mixIds = ['slMixRH', 'slMixOS', 'slMixYL', 'slMixGS', 'slMixAH', 'slMixBS', 'slMixPH', 'slMixML'];
        const all = ids.concat(mixIds);
        const tabs = Array.prototype.slice.call(document.querySelectorAll('#mixMetrics .curve-chan'));
        const grp = document.getElementById('grpMix');
        if (grp) grp.dataset.m = 's';
        const visS = getComputedStyle(document.getElementById('slMixRS').closest('.param-row')).display !== 'none';
        const visH = getComputedStyle(document.getElementById('slMixRH').closest('.param-row')).display === 'none';
        if (grp) grp.dataset.m = 'h';
        const numBox = !!document.querySelector('#grpDet .pval-num');
        return { missing: all.filter((id) => !document.getElementById(id)),
                 tabs: tabs.map((t) => t.dataset.m), visS, visH, numBox,
                 gl: !!(window.QfsMix && window.QfsMix.available()),
                 mixNa: grp && grp.classList.contains('mix-na') };
    })()`);
    check(extUi.missing.length === 0 && extUi.tabs.join(',') === 'h,s,l'
          && extUi.visS && extUi.visH && extUi.numBox,
        '细节/校准/混色器三组滑块齐全，混色器三个子页切换正常',
        JSON.stringify(extUi));
    check(extUi.gl !== extUi.mixNa, 'WebGL 可用则混色器启用，不可用则整组标记降级',
        `gl=${extUi.gl} mixNa=${extUi.mixNa}`);

    // ── 18. 校准：灰永不偏色，红·饱和 -100 压红 ──
    await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        const el = await window.__mkc();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        await new Promise((r) => setTimeout(r, 150));
        return true;
    })()`);
    const calGray = await exec(sampleQuads);
    check(Math.abs(calGray.gray[0] - 128) <= 3 && Math.abs(calGray.gray[1] - 128) <= 3,
        '校准恒等矩阵不动灰', JSON.stringify(calGray.gray));
    const calRed = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ cal: { rh: 0, rs: -100, gh: 0, gs: 0, bh: 0, bs: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return ${sampleQuads};
    })()`);
    const redMuted = calRed.red[0] - calRed.red[1];
    check(calRed.red[1] > 40 && redMuted < 120 && Math.abs(calRed.gray[0] - 128) <= 4,
        '校准红·饱和 -100：红色显著去饱和，灰背景不偏色',
        `红=${calRed.red} 灰=${calRed.gray}`);
    const calHue = await exec(`(async () => {
        const A = window.App;
        A.setGrade({ cal: { rh: 100, rs: 0, gh: 0, gs: 0, bh: 0, bs: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return ${sampleQuads};
    })()`);
    check(calHue.red[1] > 60 && calHue.red[2] < 40,
        '校准红·色相 +100：红往黄(加绿)转、不往蓝跑', JSON.stringify(calHue.red));

    // ── 19. 细节：清晰度提边缘反差，平坦区不动 ──
    // （边缘用 64/191 灰阶而不是纯黑白：纯黑纯白侧会被 USM 过冲钳位，看不出变化）
    const clarity = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#404040'; g.fillRect(0, 0, 300, 400);
        g.fillStyle = '#bfbfbf'; g.fillRect(300, 0, 300, 400);
        g.fillStyle = '#808080'; g.fillRect(340, 300, 160, 80);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const edgeL = Array.from(gg.getImageData(292, 100, 1, 1).data)[0];
            const edgeR = Array.from(gg.getImageData(308, 100, 1, 1).data)[0];
            const flat = Array.from(gg.getImageData(400, 340, 1, 1).data)[0];
            return { edgeL, edgeR, flat };
        };
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 150));
        const before = await grab();
        A.setGrade({ det: { clar: 100, tex: 0, dhz: 0 } }, { full: true });
        await new Promise((r) => setTimeout(r, 300));
        const after = await grab();
        return { before, after };
    })()`);
    check(clarity.after.edgeL < clarity.before.edgeL - 6
          && clarity.after.edgeR > clarity.before.edgeR + 6
          && Math.abs(clarity.after.flat - 128) <= 5,
        '清晰度 +100：边缘反差变大、平坦灰基本不动',
        `边 ${clarity.before.edgeL}/${clarity.before.edgeR} → ${clarity.after.edgeL}/${clarity.after.edgeR} 平坦=${clarity.after.flat}`);

    // ── 20. 去除薄雾：正档压黑提通透，负档起雾抬黑 ──
    const dhz = await exec(`(async () => {
        const A = window.App;
        // 暗灰 64 做敏感探针：纯黑只会被负档抬动，正档压不动
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const s = document.createElement('canvas'); s.width = 600; s.height = 400;
            const gg = s.getContext('2d'); gg.drawImage(src, 0, 0);
            const low = Array.from(gg.getImageData(150, 340, 1, 1).data)[0];    // 暗灰 64 探针
            const black = Array.from(gg.getImageData(60, 100, 1, 1).data)[0];
            const mid = Array.from(gg.getImageData(450, 100, 1, 1).data)[0];
            return { low, black, mid };
        };
        A.resetGrade();
        // 重画：纯黑/纯白 + 一条 64 暗灰做探针
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, 300, 200);
        g.fillStyle = '#fff'; g.fillRect(300, 0, 300, 200);
        g.fillStyle = '#404040'; g.fillRect(0, 200, 600, 200);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        await new Promise((r) => setTimeout(r, 150));
        const before = await grab();
        A.setGrade({ det: { clar: 0, tex: 0, dhz: 80 } }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const plus = await grab();
        A.setGrade({ det: { clar: 0, tex: 0, dhz: -80 } }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const minus = await grab();
        return { before, plus, minus };
    })()`);
    check(dhz.plus.low < dhz.before.low - 10 && dhz.minus.low > dhz.before.low + 10
          && dhz.plus.black <= 8 && dhz.minus.black > 12,
        '去除薄雾 ±80：正档压暗部提通透、纯黑不动，负档起雾把黑抬灰',
        `暗灰 ${dhz.before.low} → +${dhz.plus.low} / -${dhz.minus.low}；黑 ${dhz.before.black} → +${dhz.plus.black} / -${dhz.minus.black}`);

    // ── 21. 混色器（WebGL 前置级）：只动目标色相带 ──
    await exec(`(async () => {
        const A = window.App;
        const el = await window.__mkc();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        A.setGrade({ det: null, mix: null }, { full: true });
        await new Promise((r) => setTimeout(r, 150));
        return true;
    })()`);
    if (extUi.gl) {
        const mixRed = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 100, s: 0, l: 0 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        check(mixRed.red[1] > 90 && mixRed.green[1] > 200 && mixRed.blue[2] > 200
              && Math.abs(mixRed.gray[0] - 128) <= 4,
            '混色器红·色相 +100：只有红带转橙，绿蓝灰不动', JSON.stringify(mixRed));
        const mixSat = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 0, s: -100, l: 0 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        const r = mixSat.red;
        check(Math.abs(r[0] - r[1]) <= 6 && Math.abs(r[1] - r[2]) <= 6 && mixSat.green[1] > 200,
            '混色器红·饱和 -100：红色带变灰，其它带不动', JSON.stringify(mixSat));
        const mixLum = await exec(`(async () => {
            const A = window.App;
            A.setGrade({ mix: { r: { h: 0, s: 0, l: -80 } } }, { full: true });
            await new Promise((r) => setTimeout(r, 250));
            return ${sampleQuads};
        })()`);
        check(mixLum.red[0] < 180 && mixLum.green[1] > 200,
            '混色器红·明亮度 -80：红带压暗，绿带不动', JSON.stringify(mixLum));
    } else {
        console.log('SKIP  混色器像素测试（此环境无 WebGL，降级路径已在 17 验证）');
    }

    // ── 22. 扩展参数的持久化 / 中性判断 / 深拷贝 / 重置 ──
    const extPersist = await exec(`(() => {
        const A = window.App;
        A.setGrade({ mix: { r: { h: 20, s: 0, l: 0 }, b: { h: 0, s: -30, l: 0 } },
                     cal: { rh: 0, rs: -20, gh: 0, gs: 0, bh: 10, bs: 0 },
                     det: { clar: 25, tex: 0, dhz: 15 } });
        const im = A.image;
        const neutral = A.isNeutralGrade(im.grade);
        const j = JSON.stringify(im.grade);
        const keeps = j.includes('"mix"') && j.includes('"cal"') && j.includes('"det"');
        // 批量应用：mix 是两层嵌套，必须深拷贝
        A.applyGradeToAll();
        const a = A.images[0].grade.mix, b = A.images[1].grade.mix;
        const deep = a !== b;
        const z0 = A.images[1].grade.mix.b.s;
        if (a.b) a.b.s = -99;
        const z1 = A.images[1].grade.mix.b.s;
        A.setGrade({ mix: null, cal: null, det: null });
        const after = A.isNeutralGrade(im.grade) && window.photoSrcOf(im) === im.el;
        return { neutral, keeps, deep, z0, z1, after };
    })()`);
    check(!extPersist.neutral && extPersist.keeps,
        '扩展参数随草稿持久化（JSON 可序列化）且计入「已调整」', JSON.stringify(extPersist));
    check(extPersist.deep && extPersist.z0 === -30 && extPersist.z1 === -30,
        '「应用到全部」深拷贝混色器（改一张不串台）', JSON.stringify(extPersist));
    check(extPersist.after, '扩展参数全部清零后回到原图取源（零开销）');

    // ── 23. 氛围三组：滑块常开（无复选框）、默认 0、排在曲线上方 ──
    const moodUi = await exec(`(() => {
        const A = window.App;
        A.template = A.defaultTemplate();
        if (A.refreshUI) A.refreshUI();
        const grp = document.getElementById('panel-grade');
        const light = Array.prototype.slice.call(grp.querySelectorAll('.ctl-grp-light'));
        const chks = grp.querySelectorAll('.ctl-grp-light input[type=checkbox]');
        const vals = ['slVignetteStrength', 'slLeakOpacity', 'slFilmGrain'].map((id) => {
            const el = document.getElementById(id);
            return el ? el.value : null;
        });
        const curveEl = document.getElementById('grpCurve');
        const above = light.length > 0
            && !!(light[0].compareDocumentPosition(curveEl) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { n: light.length, chks: chks.length, vals, above,
                 titles: light.map((x) => ((x.querySelector('.pg-title') || {}).textContent || '').trim()) };
    })()`);
    check(moodUi.n === 3 && moodUi.chks === 0 && moodUi.vals.every((v) => v === '0'),
        '氛围三组改为常开滑块：没有开关复选框、默认全 0', JSON.stringify(moodUi));
    check(moodUi.above, '「氛围」排在「曲线」上方', JSON.stringify(moodUi.titles));

    // 滑块即开关：>0 自动启用、回 0 自动关闭（enable 是引擎唯一认的标志）
    const moodToggle = await exec(`(() => {
        const A = window.App;
        const s = document.getElementById('slVignetteStrength');
        const fire = () => {
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
        };
        s.value = '60'; fire();
        const on = Object.assign({}, A.template.lightEffect);
        s.value = '0'; fire();
        const off = Object.assign({}, A.template.lightEffect);
        return { onEn: on.vignetteEnable, onVal: on.vignetteStrength,
                 offEn: off.vignetteEnable, offVal: off.vignetteStrength };
    })()`);
    check(moodToggle.onEn === 1 && moodToggle.onVal === 60 && moodToggle.offEn === 0
          && moodToggle.offVal === 0,
        '滑块即开关：拖到 60 自动启用，回 0 自动关闭', JSON.stringify(moodToggle));

    // 老预设（enable:0 + 强度:35 的模板默认值）载入后必须显示 0，不能凭空冒出暗角
    const legacyMood = await exec(`(() => {
        const A = window.App;
        A.template.lightEffect = Object.assign({}, A.template.lightEffect,
            { vignetteEnable: 0, vignetteStrength: 35 });
        A.refreshUI();
        const shownOff = document.getElementById('slVignetteStrength').value;
        A.template.lightEffect.vignetteEnable = 1;
        A.refreshUI();
        const shownOn = document.getElementById('slVignetteStrength').value;
        A.template.lightEffect.vignetteEnable = 0;
        A.template.lightEffect.vignetteStrength = 0;
        A.refreshUI();
        return { shownOff, shownOn };
    })()`);
    check(legacyMood.shownOff === '0' && legacyMood.shownOn === '35',
        '老预设 enable:0+强度:35 载入显示 0（观感不变）；enable:1 时正常回显 35',
        JSON.stringify(legacyMood));

    // 真画出来：强度 85 时四角相对中心明显变暗，归零后恢复
    const vigPix = await exec(`(async () => {
        const A = window.App;
        A.template = A.defaultTemplate();
        A.template.lightEffect.vignetteEnable = 1;
        A.template.lightEffect.vignetteStrength = 85;
        A.setTpl(A.image, A.template);
        if (A.refreshUI) A.refreshUI();
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 800));
        const sample = () => {
            const cv = A.dom.canvas;
            const c = document.createElement('canvas'); c.width = 80; c.height = 80;
            const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 80, 80);
            const block = (x0, y0) => {
                let s = 0, n = 0;
                for (let y = y0; y < y0 + 10; y++) for (let x = x0; x < x0 + 10; x++) {
                    const d = g.getImageData(x, y, 1, 1).data;
                    s += (d[0] + d[1] + d[2]) / 3; n++;
                }
                return s / n;
            };
            const corner = (block(2, 2) + block(68, 2) + block(2, 68) + block(68, 68)) / 4;
            return { corner: +corner.toFixed(1), center: +block(35, 35).toFixed(1) };
        };
        const on = sample();
        A.template.lightEffect.vignetteEnable = 0;
        A.template.lightEffect.vignetteStrength = 0;
        A.setTpl(A.image, A.template);
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 800));
        const off = sample();
        return { on, off, onRatio: +(on.corner / Math.max(1, on.center)).toFixed(3),
                 offRatio: +(off.corner / Math.max(1, off.center)).toFixed(3) };
    })()`);
    check(vigPix.onRatio < vigPix.offRatio - 0.04,
        '强度 85 时暗角真实生效（四角/中心亮度比明显下降），归零后恢复',
        JSON.stringify(vigPix));

    // ── 24. 每个分组都能折叠（曲线/混色器曾因 CSS 白名单漏项折不动）──
    const collapse = await exec(`(() => {
        const A = window.App;
        A.switchTab('grade');
        const pick = (id, g) => id === 'grpCurve' ? g.querySelector('.curve-bar')
            : id === 'grpMix' ? g.querySelector('#mixRows')
                : g.querySelector('.param-row');
        const out = {};
        for (const id of ['grpCurve', 'grpMix', 'grpDet']) {
            const g = document.getElementById(id);
            const title = g && g.querySelector('.pg-title.collapsible');
            const target = g && pick(id, g);
            if (!title || !target) { out[id] = { missing: true }; continue; }
            title.click();
            const hidden = getComputedStyle(target).display === 'none';
            const stillTitle = getComputedStyle(title).display !== 'none';
            title.click();
            const shown = getComputedStyle(target).display !== 'none';
            const cv = id === 'grpCurve' ? g.querySelector('#curveCanvas') : null;
            out[id] = { hidden, shown, stillTitle,
                canvasW: cv ? cv.width : null,
                fitW: cv ? Math.round(cv.clientWidth * Math.min(3, window.devicePixelRatio || 1)) : null };
        }
        return out;
    })()`);
    const collapseOk = ['grpCurve', 'grpMix', 'grpDet'].every((id) => {
        const r = collapse[id] || {};
        return r.hidden && r.shown && r.stillTitle
            && (id !== 'grpCurve' || (r.canvasW > 0 && r.canvasW === r.fitW));
    });
    check(collapseOk, '曲线/混色器/细节组都能折叠再展开，曲线画布展开后按真实尺寸重画',
        JSON.stringify(collapse));

    // ── 25. 白色/黑色（黑场白场）：白点并合高光、黑点抬/压暗部 ──
    const wb = await exec(`(async () => {
        const A = window.App;
        // 四段灰阶：0 / 64 / 128 / 224，用来分别观察黑场、暗部、中间调、亮部
        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        const bands = ['#000000', '#404040', '#808080', '#e0e0e0'];
        bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 150, 0, 150, 400); });
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
        A.resetGrade();
        A.image.el = el; A.image.w = 600; A.image.h = 400;
        A.invalidateGrade(A.image);
        const grab = async () => {
            const src = window.photoSrcOf(A.image);
            const sc = document.createElement('canvas'); sc.width = 600; sc.height = 400;
            const gg = sc.getContext('2d'); gg.drawImage(src, 0, 0);
            const at = (x) => Array.from(gg.getImageData(x, 200, 1, 1).data)[0];
            return { black: at(75), dark: at(225), mid: at(375), bright: at(525) };
        };
        const base = await grab();
        A.setGrade({ white: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const wUp = await grab();
        A.setGrade({ white: -100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const wDown = await grab();
        A.setGrade({ white: 0, black: 100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const bUp = await grab();
        A.setGrade({ white: 0, black: -100 }, { full: true });
        await new Promise((r) => setTimeout(r, 250));
        const bDown = await grab();
        A.setGrade({ white: 0, black: 0 });
        return { base, wUp, wDown, bUp, bDown };
    })()`);
    check(wb.wUp.bright > wb.base.bright + 8 && wb.wUp.black <= 2 && Math.abs(wb.wUp.mid - wb.base.mid) < 22
          && wb.wDown.bright < wb.base.bright - 15 && wb.wDown.black <= 2,
        '白色：+100 高光并合到纯白（纯黑不动），-100 压暗亮部',
        `亮 ${wb.base.bright} → ${wb.wUp.bright} / ${wb.wDown.bright}`);
    check(wb.bUp.black > 40 && wb.bUp.black < 90 && Math.abs(wb.bUp.bright - wb.base.bright) < 12
          && wb.bDown.dark < wb.base.dark - 15 && wb.bDown.black <= 2,
        '黑色：+100 抬黑起雾（亮部几乎不动），-100 压死暗部',
        `黑 ${wb.base.black} → ${wb.bUp.black} / ${wb.bDown.black}；暗 ${wb.base.dark} → ${wb.bDown.dark}`);

    console.log('');
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
