// 调色页签参数栏截图（改版前/后对照用）。
// 用法：QF_SHOT_OUT=<目录> node tools/run-electron.js tools/shot-grade-panel.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'design', 'home-prototype-assets', 'samples');
const OUT = process.env.QF_SHOT_OUT
    ? path.resolve(process.env.QF_SHOT_OUT)
    : path.join(ROOT, '.tmp', 'grade-panel');
const SAMPLES = ['city.webp', 'desert.webp', 'forest.webp', 'portrait.webp'];
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const datas = SAMPLES.map((name) => 'data:image/webp;base64,' + fs.readFileSync(path.join(SAMPLE_DIR, name)).toString('base64'));
    const win = new BrowserWindow({
        width: 1500,
        height: 1000,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(400);
    win.showInactive();
    win.setContentSize(1500, 1000);
    await exec(`(() => {
        try {
            localStorage.setItem('qfs_intro_done', '1');
            // 截图只演示默认态：清掉别的用例留下的侧栏模式与分组展开记录
            localStorage.removeItem('qfs_side_mode');
            localStorage.removeItem('qfs_preset_groups');
        } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        if (window.App && App.setSideMode) App.setSideMode('border');
        if (window.App && App.buildTree) App.buildTree('');
        return true;
    })()`);
    await sleep(1600);

    const setup = await exec(`(async () => {
        const App = window.App;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 80 && (!App.presets || App.presets.length < 6); i++) await wait(100);
        const srcs = ${JSON.stringify(datas)};
        const names = ['city.jpg', 'desert.jpg', 'forest.jpg', 'portrait.jpg'];
        const imgs = [];
        for (let i = 0; i < srcs.length; i++) {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('sample failed'));
                img.src = srcs[i];
            });
            imgs.push({
                el: img, name: names[i], w: img.naturalWidth, h: img.naturalHeight,
                exif: { make: 'SONY', model: 'ILCE-7RM4', iso: '100', focal: '18-300@300 毫米', aperture: 'f/8', shutter: '1/100 秒' },
                thumb: srcs[i], customSettings: null
            });
        }
        App.images = imgs;
        App.currentIdx = 0;
        App.image = imgs[0];
        App.selectedIdx = [0];
        App.batchSel = [];
        App.imageTemplates = new Map();
        const useDefault = ${JSON.stringify(process.env.QF_SHOT_TPL === 'default')};
        imgs.forEach((im) => {
            // 默认取第一个预设（3D卡片，相框样式）：光效行现在在所有管线里都露出，
            // 所以两种模板都能拍到完整的「效果」六行；QF_SHOT_TPL=default 只是换一张
            // 没有相框白边的底图，便于对比调色/效果本身。
            const tpl = useDefault ? App.defaultTemplate() : JSON.parse(JSON.stringify(App.presets[0]));
            im.customSettings = tpl;
            App.imageTemplates.set(im, tpl);
        });
        App.template = JSON.parse(JSON.stringify(App.imageTemplates.get(imgs[0])));
        App._followFit = false;
        App.buildThumbnails();
        App.updateEmptyState();
        App.afterImageSelect();
        App.switchTab('grade');
        await wait(300);
        let gradeErr = null;
        try {
            if (App.setGrade) App.setGrade({ exp: 0.35, con: 18, hi: -26, sh: 24, white: 8, black: -12, gam: 6, temp: 16, tint: 4, vib: 12, sat: 6 });
        } catch (e) { gradeErr = String((e && e.stack) || e); }
        if (App.rebuildGrade) App.rebuildGrade('low');
        if (App.scheduleRender) App.scheduleRender(true);
        await wait(1400);
        return { ok: true, gradeErr, exp: App.image && App.image.grade && App.image.grade.exp, slider: document.getElementById('slGradeExp').value };
    })()`);
    if (!setup || !setup.ok) throw new Error('setup failed');
    console.log('SETUP', JSON.stringify(setup));

    const shot = async (name, sel) => {
        const box = await exec(`(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        })()`);
        // 离屏窗口换主题/滚动后合成器可能留着上一帧：先丢掉一张暖机帧
        await win.webContents.capturePage(box && box.width > 10 ? box : undefined);
        await sleep(150);
        const image = await win.webContents.capturePage(box && box.width > 10 ? box : undefined);
        const file = path.join(OUT, name + '.png');
        fs.writeFileSync(file, image.toPNG());
        console.log('SHOT', file, box ? box.width + 'x' + box.height : '');
        return file;
    };

    await shot('window-full');
    // 设置弹窗里的密度三档
    await exec(`(() => { if (window.App && App.openSettings) App.openSettings(); return true; })()`);
    await sleep(500);
    await shot('settings-density', '#settingsModal');
    await exec(`(() => { if (window.App && App.closeSettings) App.closeSettings(); return true; })()`);
    await sleep(250);
    await shot('panel-top', '#inspector');
    // 「曲线」组：确认外框是正方形。展开后滚到该组顶部再拍。
    await exec(`(() => {
        const grp = document.getElementById('grpCurve');
        if (grp) grp.classList.remove('collapsed');
        const b = document.querySelector('.insp-body');
        const top = grp.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 8;
        b.scrollTop = Math.max(0, top);
        if (window.App && window.App.drawCurve) window.App.drawCurve();
        return true;
    })()`);
    await sleep(450);
    await shot('panel-curve', '#inspector');
    // 「更多」弹出菜单：确认不被 .insp-body 裁掉
    await exec(`(() => { const b = document.getElementById('btnTabMore'); if (b) b.click(); return true; })()`);
    await sleep(250);
    await shot('panel-menu', '#inspector');
    await exec(`(() => { const b = document.getElementById('btnTabMore'); if (b) b.click(); return true; })()`);
    // 滚到 颜色 / 效果 两段，看看滑块与渐变轨道
    for (const [name, top] of [['panel-color', 430], ['panel-fx', 700], ['panel-more', 980]]) {
        await exec(`(() => { const b = document.querySelector('.insp-body'); if (b) b.scrollTop = ${top}; return true; })()`);
        await sleep(500);
        // 滚动后强制一次重排，避免截到 Chromium 没来得及重绘的轨道
        await exec(`(() => { const el = document.getElementById('grpDet'); if (el) el.style.transform = 'translateZ(0)'; return true; })()`);
        await sleep(120);
        await shot(name, '#inspector');
    }
    await exec(`(() => { const b = document.querySelector('.insp-body'); if (b) b.scrollTop = 0; return true; })()`);
    // 「效果」段整段对准（默认模板下应当有六行：纹理/清晰度/去薄雾/晕影/羽化/颗粒）
    await exec(`(() => {
        const b = document.querySelector('.insp-body');
        const fx = document.querySelector('#grpGrade .pg-sub[data-sub="fx"]');
        if (!b || !fx) return false;
        const top = fx.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 48;
        b.scrollTop = Math.max(0, top);
        return true;
    })()`);
    await sleep(450);
    await shot('panel-fx-full', '#inspector');
    // 「校准」段：六条滑轨应按红/绿/蓝原色着色（色相是色环一段、饱和是灰→原色）
    await exec(`(() => {
        const cal = document.getElementById('grpCal');
        if (!cal) return false;
        // 折叠态先展开（.pg-title.collapsible 点击切换），否则截到的是标题
        const title = cal.querySelector('.pg-title');
        if (title && cal.classList.contains('collapsed')) title.click();
        const b = document.querySelector('.insp-body');
        const top = cal.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 8;
        b.scrollTop = Math.max(0, top);
        return true;
    })()`);
    await sleep(450);
    await shot('panel-cal', '#inspector');
    // 「曲线」右键菜单：确认五项 + 两条分隔线 + 粘贴禁用态。先在曲线空白处右键，
    // 浮层按 clientX/Y 定位到曲线框内，截全窗口才能拍到这个 fixed 浮层。
    await exec(`(() => {
        const grp = document.getElementById('grpCurve');
        if (grp) grp.classList.remove('collapsed');
        const b = document.querySelector('.insp-body');
        if (b) b.scrollTop = Math.max(0, (document.getElementById('grpCurve').getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop) - 8);
        const cv = document.getElementById('curveCanvas');
        const r = cv.getBoundingClientRect(); const pad = 8;
        cv.dispatchEvent(new MouseEvent('contextmenu',
            { clientX: r.left + pad + 0.12 * (r.width - pad * 2), clientY: r.top + (r.height - pad - 0.9 * (r.height - pad * 2)), bubbles: true, cancelable: true }));
        return true;
    })()`);
    await sleep(280);
    await shot('panel-curve-ctx', null);
    await exec(`(() => { const b = document.querySelector('.insp-body'); if (b) b.scrollTop = 0; return true; })()`);
    // 侧栏拖到最窄 / 最宽，确认标签与数值不打架
    for (const w of [260, 440]) {
        await exec(`(() => {
            const b = document.querySelector('.insp-body');
            if (b) b.scrollTop = 330;
            const insp = document.getElementById('inspector');
            if (insp) insp.style.width = '${w}px';
            if (window.QfsHistogram) QfsHistogram.redraw();
            return true;
        })()`);
        await sleep(400);
        await shot('panel-w' + w, '#inspector');
    }
    await exec(`(() => { const insp = document.getElementById('inspector'); if (insp) insp.style.width = ''; const b = document.querySelector('.insp-body'); if (b) b.scrollTop = 0; if (window.QfsHistogram) QfsHistogram.redraw(); return true; })()`);
    await sleep(300);

    // 剪切警告点亮态：临时换一张半黑半白图，两角应同时亮起，端点竖条也画出来
    await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas'); c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, 60, 80);
        g.fillStyle = '#fff'; g.fillRect(60, 0, 60, 80);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL(); });
        window.__shotOrig = A.image;
        A.image = { el, name: 'clip-test.png', w: 120, h: 80, exif: {}, grade: null };
        if (window.QfsHistogram) window.QfsHistogram.refresh(A.image);
        return true;
    })()`);
    await sleep(400);
    await exec(`(() => { const b = document.getElementById('gradeClipLo'); if (b && window.QfsHistogram && !window.QfsHistogram.clipMarked()) b.click(); return true; })()`);
    await sleep(350);
    await shot('panel-clip', '#inspector');
    await exec(`(() => {
        if (window.QfsHistogram && window.QfsHistogram.clipMarked()) {
            const b = document.getElementById('gradeClipLo'); if (b) b.click();
        }
        const A = window.App;
        A.image = window.__shotOrig;
        if (window.QfsHistogram) window.QfsHistogram.refresh(A.image);
        delete window.__shotOrig;
        return true;
    })()`);
    await sleep(350);

    // 浅色主题再看一眼：直方图恒深底，参数条与滑轨要跟着主题走
    const themeNow = await exec(`(() => { if (window.App && App.toggleTheme) App.toggleTheme(); return document.documentElement.className; })()`);
    const css = await exec(`(() => { const c = getComputedStyle(document.documentElement); return { root: document.documentElement.className, body: document.body.className, surface: c.getPropertyValue('--surface'), bg: c.getPropertyValue('--bg') }; })()`);
    console.log('THEME', themeNow, JSON.stringify(css));
    await sleep(400);
    // 离屏窗口换主题后合成器可能还留着上一帧，强制重绘再截
    await exec(`(() => { const b = document.body; b.style.opacity = '0.999'; void b.offsetHeight; return true; })()`);
    await sleep(120);
    await exec(`(() => { document.body.style.opacity = ''; return true; })()`);
    await sleep(600);
    await shot('panel-light-top', '#inspector');

    win.destroy();
    app.exit(0);
}

const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const presetNames = fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
ipcMain.handle('list-presets', () => presetNames);
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
for (const channel of ['save-image-base64', 'save-images-batch', 'save-template', 'load-template', 'delete-template',
    'rename-template', 'export-template', 'import-template', 'export-qfs', 'open-qfs', 'save-user', 'logout-user']) {
    ipcMain.handle(channel, () => ({ ok: true }));
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
