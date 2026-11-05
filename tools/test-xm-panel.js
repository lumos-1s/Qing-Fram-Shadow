// 联名水印(XIAOMI_LEICA)右侧面板回归:
//   这类「控件忘了接线」的 bug 只有端到端才测得出:onSliderCustom 里写着分支,
//   但 id 没加进 bindRanges/onEdit 列表 → 拖滑块毫无反应,单测模板字段永远发现不了。
//   ① 位置下拉(左下/居中/右下)是否真的改变渲染位置;
//   ② 每个滑块 / 开关 / 色块改动后,画布是否真的变化(整图像素指纹比对,任何视觉变化都能捕捉);
//   ③ 同时打印模板里的字段,区分「链路没通」与「链路通了但当前素材不可见」。
// 用法: npm run test:xmpanel
//       env -u ELECTRON_RUN_AS_NODE node tools/run-electron.js tools/test-xm-panel.js
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const LOGO_DIR = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'qingframe-web', 'brandlogos');
const EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(n => n.endsWith('.json')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', name), 'utf8')); } catch (_) { return null; }
});
ipcMain.handle('list-logos', () => {
    if (!fs.existsSync(LOGO_DIR)) return [];
    return fs.readdirSync(LOGO_DIR).filter(n => EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => ({ name: n, dataUrl: 'data:image/' + path.extname(n).slice(1) + ';base64,' + fs.readFileSync(path.join(LOGO_DIR, n)).toString('base64') }));
});
for (const c of ['list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'list-wall-covers', 'open-wall-covers-dir']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (_) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 950, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const raw = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        A.saveCurrentTemplate = () => {};

        const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
        const g = c.getContext('2d'); g.fillStyle = '#333333'; g.fillRect(0, 0, 1400, 1000);
        const img = new Image();
        await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
        const im = {
            name: 'diag', el: img, w: 1400, h: 1000,
            exif: { make: 'SONY', model: 'ILCE-7CM2', focal: '35mm', aperture: 'f/2.8', iso: 'ISO 100', shutter: '1/200' }
        };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();

        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'XIAOMI_LEICA';
        A.template.brandLogo = 1;
        A.template.xmLeica = Object.assign({}, A.template.xmLeica, {
            partnerBrand: '', line2: 'CLASSIC · 影像定制', showScrim: 1, scrim: 45, showDiv: 1, align: 1
        });
        A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
        await A.flushRender(); await sleep(300);

        const shot = () => {
            const cv = A.dom.canvas;
            const ctx = cv.getContext('2d');
            const w = cv.width, h = cv.height;
            const d = ctx.getImageData(0, 0, w, h).data;
            const fp = [];
            let minX = w, maxX = -1, minY = h, maxY = -1;
            for (let i = 0; i < d.length; i += 4) {
                const px = (i / 4) % w, py = Math.floor((i / 4) / w);
                fp.push(d[i] + d[i + 1] * 3 + d[i + 2] * 7);
                if (d[i] > 150 && d[i + 1] > 150 && d[i + 2] > 150) {
                    if (px < minX) minX = px; if (px > maxX) maxX = px;
                    if (py < minY) minY = py; if (py > maxY) maxY = py;
                }
            }
            return { w, h, fp, left: minX === w ? -1 : minX, right: maxX < 0 ? -1 : (w - 1 - maxX), top: minY === h ? -1 : minY, bottom: maxY < 0 ? -1 : (h - 1 - maxY) };
        };
        const diff = (a, b) => {
            let n = 0;
            for (let i = 0; i < a.fp.length; i++) if (Math.abs(a.fp[i] - b.fp[i]) > 8) n++;
            return n;
        };
        const tpl = () => {
            const x = A.template.xmLeica;
            return { brand: x.brandScale, line: x.lineScale, logo: x.logoScale, opacity: x.logoOpacity,
                pad: x.padScale, scrim: x.scrim, div: x.showDiv, scrimOn: x.showScrim, align: x.align };
        };

        const out = { steps: {} };
        const base = shot();
        out.steps['base'] = { left: base.left, right: base.right, top: base.top, bottom: base.bottom };

        // ── 位置三档 ──
        for (const al of [0, 1, 2]) {
            const sel = document.getElementById('cbXmAlign');
            sel.value = String(al);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await A.flushRender(); await sleep(220);
            const m = shot();
            out.steps['align-' + al] = { left: m.left, right: m.right, tplAlign: A.template.xmLeica.align, dom: sel.value };
        }
        const sel0 = document.getElementById('cbXmAlign');
        sel0.value = '1'; sel0.dispatchEvent(new Event('change', { bubbles: true }));
        await A.flushRender(); await sleep(220);

        const setRange = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); };
        const setChk = (id, v) => { const el = document.getElementById(id); el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); };

        const reset = async () => {
            A.template.xmLeica = Object.assign({}, A.template.xmLeica, {
                brandScale: 1, lineScale: 1, logoScale: 1, logoOpacity: 100, padScale: 1,
                scrim: 45, showDiv: 1, showScrim: 1, align: 1, textColor: '#ffffff',
                fontFamily: 'Courier New', brandTracking: 0.16, lineWeight: 600, logoColor: '#ffffff', logoRaw: 1
            });
            A.refreshUI(); await A.flushRender(); await sleep(220);
        };

        const cases = [
            ['brandSize 160', () => setRange('slXmBrandSize', 160)],
            ['lineSize 160', () => setRange('slXmLineSize', 160)],
            ['logoSize 160', () => setRange('slXmLogoSize', 160)],
            ['logoOpacity 30', () => setRange('slXmLogoOpacity', 30)],
            ['pad 180', () => setRange('slXmPad', 180)],
            ['scrim 100', () => setRange('slXmScrim', 100)],
            ['hideDiv', () => setChk('chkXmShowDiv', false)],
            ['hideScrim', () => setChk('chkXmShowScrim', false)],
            ['font Arial', () => { const el = document.getElementById('cbXmFont'); el.value = 'Arial'; el.dispatchEvent(new Event('change', { bubbles: true })); }],
            ['brandTracking 45', () => setRange('slXmBrandTrack', 45)],
            ['lineWeight 300', () => { const el = document.getElementById('cbXmLineWeight'); el.value = '300'; el.dispatchEvent(new Event('change', { bubbles: true })); }],
            ['logo tint', () => { const raw = document.getElementById('chkXmLogoRaw'); raw.checked = false; raw.dispatchEvent(new Event('change', { bubbles: true })); const c = document.getElementById('cpXmLogo'); c.value = '#ff0000'; c.dispatchEvent(new Event('input', { bubbles: true })); }]
        ];
        for (const [name, fn] of cases) {
            await reset();
            const b = shot();
            fn();
            await A.flushRender(); await sleep(260);
            const m = shot();
            out.steps[name] = { d: diff(b, m), left: m.left, right: m.right, top: m.top, bottom: m.bottom, tpl: tpl() };
        }

        // ── 配色三项 ──
        const colors = [['cpXmText', '#ff0000', 'text'], ['cpXmSub', '#00ff00', 'sub'], ['cpXmDiv', '#ffcc00', 'div']];
        for (const [id, hex, key] of colors) {
            await reset();
            const b = shot();
            const el = document.getElementById(id);
            el.value = hex; el.dispatchEvent(new Event('input', { bubbles: true }));
            await A.flushRender(); await sleep(260);
            out.steps['color-' + key] = { d: diff(b, shot()), tpl: A.template.xmLeica[key + 'Color'] };
        }
        // ── 手势期间画布尺寸:低清预览不能改变显示尺寸,否则拖滑块会「跳一下缩小」 ──
        await reset();
        const snapSize = () => ({
            cw: A.dom.canvas.width, ch: A.dom.canvas.height,
            logW: A.dom.canvas._logW, logH: A.dom.canvas._logH,
            cssW: parseFloat(A.dom.canvas.style.width) || 0,
            cssH: parseFloat(A.dom.canvas.style.height) || 0,
            zoom: Math.round(A.zoom * 1000) / 1000
        });
        const before = snapSize();
        A.beginGesture();
        await A.flushRender(); await sleep(260);
        const during = snapSize();
        A.template.xmLeica.brandScale = 1.6;
        await A.flushRender(); await sleep(260);
        const during2 = snapSize();
        A.endGesture();
        await A.flushRender(); await sleep(260);
        const after = snapSize();
        out.gesture = { before, during, during2, after };

        return JSON.stringify(out);
    })()`);

    const out = JSON.parse(raw);
    const failures = [];
    const ok = (cond, label, extra) => {
        console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
        if (!cond) failures.push(label);
    };

    console.log('base:', JSON.stringify(out.steps.base));
    for (const [k, v] of Object.entries(out.steps)) {
        if (k === 'base') continue;
        console.log(k.padEnd(16), JSON.stringify(v));
    }

    console.log('gesture:', JSON.stringify(out.gesture));
    const s = out.steps;
    // ① 位置三档:居中必须左右留白相等,左下/右下必须各自贴边
    ok(s['align-0'].left < s['align-0'].right - 100, '位置=左下 靠左', JSON.stringify(s['align-0']));
    ok(Math.abs(s['align-1'].left - s['align-1'].right) <= 2, '位置=底部居中 左右对称', JSON.stringify(s['align-1']));
    ok(s['align-2'].right < s['align-2'].left - 100, '位置=右下 靠右', JSON.stringify(s['align-2']));
    ok(s['align-1'].tplAlign === 1 && s['align-1'].dom === '1', '下拉值写回模板');

    // ② 每个调节项都必须真的改变画面(整图像素差异)
    const MIN_DIFF = 50;
    const controls = [
        ['brandSize 160', '字标字号'], ['lineSize 160', '文案字号'],
        ['logoSize 160', 'Logo 大小'], ['logoOpacity 30', 'Logo 不透明度'],
        ['pad 180', '边距'], ['scrim 100', '渐变强度'],
        ['hideDiv', '竖线开关'], ['hideScrim', '渐变开关'],
        ['color-text', '主文字配色'], ['color-sub', '副文字配色'], ['color-div', '竖线配色'],
        ['font Arial', '字体下拉(切 Arial)'],
        ['brandTracking 45', '字标字距(槽级)'],
        ['lineWeight 300', '文案字重(槽级)'],
        ['logo tint', 'Logo 上色']
    ];
    for (const [key, label] of controls) {
        const v = s[key];
        ok(!!v && v.d > MIN_DIFF, label + ' 生效', v ? 'diff=' + v.d : 'missing');
    }
    // ③ 边距:居中时水平不动,但整体要上移
    ok(s['pad 180'].top < s['base'].top - 10, '边距 180 让水印上移', `${s['base'].top} → ${s['pad 180'].top}`);
    // ④ 滑块值确实写进模板(区分"链路没通"和"素材不可见")
    ok(s['brandSize 160'].tpl.brand === 1.6 && s['logoOpacity 30'].tpl.opacity === 30, '滑块值写回模板');

    // ⑤ 手势期(拖滑块)画布与显示尺寸都不能变 —— 否则就是「跳动缩小」
    const g = out.gesture;
    ok(g.during.logW === g.before.logW && g.during.logH === g.before.logH,
        '手势期间显示逻辑尺寸不变', `${g.before.logW}x${g.before.logH} → ${g.during.logW}x${g.during.logH}`);
    ok(g.during.cw <= g.before.cw + 1 && g.during.ch <= g.before.ch + 1,
        '手势期仍走低清(像素不涨)', `${g.before.cw}x${g.before.ch} → ${g.during.cw}x${g.during.ch}`);
    ok(Math.abs(g.during.cssW - g.before.cssW) <= 1 && Math.abs(g.during.cssH - g.before.cssH) <= 1,
        '手势期间显示尺寸不缩小', `${g.before.cssW}x${g.before.cssH} → ${g.during.cssW}x${g.during.cssH}`);
    ok(Math.abs(g.after.cssW - g.before.cssW) <= 1 && Math.abs(g.after.cssH - g.before.cssH) <= 1,
        '松手后显示尺寸不跳变', `${g.before.cssW}x${g.before.cssH} → ${g.after.cssW}x${g.after.cssH}`);
    ok(g.during2.cssW === g.during.cssW, '拖动中改字号也不缩放');

    console.log('─'.repeat(60));
    if (failures.length) { console.log(failures.length + ' FAILURE(S)'); app.exit(1); }
    console.log('✓ 全部通过');
    app.exit(0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
