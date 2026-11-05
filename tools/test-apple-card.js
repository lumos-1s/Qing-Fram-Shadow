// 苹果信息卡(CARD_APPLE)自定义面板回归:
//   · 23 个专属行 + 说明条只在 CARD_APPLE 显形,切到别的风格整组收起;
//   · 文本 / 滑块 / 勾选 / 颜色 → 真的写进 template.appleCard;
//   · refreshUI 能把模板值回填到控件(切换预设/撤销后不回退)。
// 用法: node tools/run-electron.js tools/test-apple-card.js
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const fails = [];
const ok = (c, label, extra) => { console.log((c ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : '')); if (!c) fails.push(label); };

protocol.registerSchemesAsPrivileged([{ scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.StyleCaps)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const res = await win.webContents.executeJavaScript(`(async () => {
        const out = [];
        const A = window.App;
        // 桩:不真渲染/不落盘,只验证 DOM ↔ 模型
        A.scheduleRender = () => {};
        A.saveCurrentTemplate = () => {};
        A.autoSaveState = () => {};
        const cv = document.createElement('canvas'); cv.width = 800; cv.height = 900;
        A.image = { el: cv, exif: { make: 'Apple', model: 'iPhone 18 Pro Max', focal: '24mm', aperture: 'f/1.88', iso: 'ISO 102', shutter: '1/4132' } };
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'CARD_APPLE';
        A.refreshUI();
        const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
        out.push(['row visible', vis('rowAppleDate') && vis('rowAppleFont') && vis('rowAppleShow') && vis('rowAppleColors')]);
        out.push(['group visible', getComputedStyle(document.getElementById('rowAppleDate').closest('.param-group')).display !== 'none']);
        // 上/左/右贴边后没有四周留白可调:「边距大小」必须收起,不能留个死滑块
        out.push(['margin row hidden', !vis('rowGlobalMargin')]);
        // 日期(品牌/型号/参数由下方「相机参数(自动识别)」驱动,不再有上方输入)
        const td = document.getElementById('tfAppleDate');
        td.value = '2024.07.10 14:35:17';
        td.dispatchEvent(new Event('input', { bubbles: true }));
        out.push(['text date', A.template.appleCard.dateText === '2024.07.10 14:35:17', A.template.appleCard.dateText]);
        // 滑块
        const sl = document.getElementById('slAppleLogoSize');
        sl.value = '200';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        out.push(['slider logo', A.template.appleCard.logoScale === 2, String(A.template.appleCard.logoScale)]);
        // 勾选
        const ck = document.getElementById('chkAppleShowDate');
        ck.checked = false;
        ck.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(['check date', A.template.appleCard.showDate === 0, String(A.template.appleCard.showDate)]);
        // 颜色
        const cp = document.getElementById('cpAppleText');
        cp.value = '#123456';
        cp.dispatchEvent(new Event('input', { bubbles: true }));
        out.push(['color text', A.template.appleCard.textColor === '#123456', A.template.appleCard.textColor]);
        // 字体
        const cbf = document.getElementById('cbAppleFont');
        cbf.value = 'Georgia';
        cbf.dispatchEvent(new Event('change', { bubbles: true }));
        out.push(['font family', A.template.appleCard.fontFamily === 'Georgia', A.template.appleCard.fontFamily]);
        // 回填:改模板 → refreshUI → 读 DOM
        A.template.appleCard.dateText = 'CUSTOM DATE';
        A.template.appleCard.lineScale = 2.5;
        A.template.appleCard.showDate = 0;
        A.template.appleCard.barBg = '#abcdef';
        A.template.appleCard.fontFamily = 'Bodoni MT';
        A.refreshUI();
        out.push(['refresh text', document.getElementById('tfAppleDate').value === 'CUSTOM DATE']);
        out.push(['refresh font', document.getElementById('cbAppleFont').value === 'Bodoni MT', document.getElementById('cbAppleFont').value]);
        out.push(['refresh slider', document.getElementById('slAppleLineWidth').value === '250', document.getElementById('slAppleLineWidth').value]);
        out.push(['refresh chk', document.getElementById('chkAppleShowDate').checked === false]);
        out.push(['refresh color', document.getElementById('cpAppleBarBg').value === '#abcdef']);
        // 切到别的风格:整组应收起
        A.template.photoFrameStyle = 'CARD_SIMPLE';
        A.updatePersonalVisibility();
        out.push(['hidden on other style', !vis('rowAppleDate')]);
        out.push(['group collapsed', getComputedStyle(document.getElementById('rowAppleDate').closest('.param-group')).display === 'none']);
        return out;
    })()`);
    for (const [label, pass, extra] of res) ok(pass, label, extra);
    console.log(fails.length ? '✖ ' + fails.length + ' 项失败' : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
