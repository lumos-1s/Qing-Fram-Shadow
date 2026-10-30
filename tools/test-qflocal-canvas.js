// qflocal 图片必须能用于导出（画布不能被 taint）。
//
// 背景：页面是 file://、照片是 qflocal://，两者不同源。若 <img> 不设 crossOrigin，
// 画进 canvas 后画布被标记 tainted，getImageData / toBlob / toDataURL 全部抛
//   SecurityError: Tainted canvases may not be exported
// 表现：调色读不到像素、裁切点确定报错、导出直接失败。线上 0.1.22 就栽在这。
//
// 两道防线：
//   ① 静态：源码里不许出现裸 `new Image()`，必须走 window.qfsImage()；
//   ② 端到端：用带 CORS 头的 qflocal 协议加载一张真图，drawImage 后 toBlob 必须成功。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const IMG = path.join(ROOT, 'shared', 'textures', 'denim.png');

const failures = [];
const check = (ok, label, extra) => {
    if (ok) console.log('PASS  ' + label + (extra ? ' | ' + extra : ''));
    else { console.log('FAIL  ' + label + (extra ? ' | ' + extra : '')); failures.push(label); }
};

// ── ① 静态检查：不许有裸 new Image() ──
const jsDir = path.join(ROOT, 'src', 'renderer', 'js');
const offenders = [];
for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    // 允许 qfs-img.js 自己（它就该 new Image）
    if (f === 'qfs-img.js') continue;
    if (/new\s+Image\s*\(\s*\)/.test(src)) offenders.push(f);
}
check(offenders.length === 0, '渲染层没有裸 new Image()（必须用 window.qfsImage）', offenders.join(','));
check(fs.readFileSync(path.join(jsDir, 'qfs-img.js'), 'utf8').includes("crossOrigin = 'anonymous'"),
    'qfsImage 里设置了 crossOrigin=anonymous');

// ── ② 端到端：带 CORS 头的 qflocal 加载 → 绘制 → 导出 ──
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);
ipcMain.handle('load-acr-tables', () => null);
const EMPTY = () => [];
for (const c of ['list-presets', 'list-logos', 'list-textures', 'list-marks', 'list-custom-icons', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, EMPTY);
const CANCEL = () => ({ canceled: true });
for (const c of ['save-prefs', 'save-user', 'open-external', 'copy-text', 'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir', 'open-images', 'open-image', 'read-exif']) ipcMain.handle(c, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: '0.0.0', platform: 'win32', packaged: false }));

async function main() {
    await app.whenReady();
    // 与主进程真实实现一致：响应必须带 ACAO，否则设了 crossOrigin 反而加载失败
    protocol.handle('qflocal', async () => {
        const res = await net.fetch(pathToFileURL(IMG).href);
        const headers = new Headers(res.headers);
        headers.set('access-control-allow-origin', '*');
        headers.set('cross-origin-resource-policy', 'cross-origin');
        return new Response(res.body, { status: res.status, headers });
    });
    const win = new BrowserWindow({ show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: true } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);
    const out = await win.webContents.executeJavaScript(`(async () => {
        const url = 'qflocal://img?p=' + encodeURIComponent(${JSON.stringify(IMG)});
        const r = {};
        const im = window.qfsImage(url);
        await new Promise((res) => { im.onload = res; im.onerror = res; });
        r.loaded = !!im.naturalWidth;
        r.crossOrigin = im.crossOrigin;
        const cv = document.createElement('canvas'); cv.width = 120; cv.height = 120;
        const g = cv.getContext('2d');
        g.drawImage(im, 0, 0, 120, 120);
        try { g.getImageData(0, 0, 1, 1); r.getImageData = 'ok'; } catch (e) { r.getImageData = e.name; }
        try {
            await new Promise((res, rej) => { try { cv.toBlob((b) => (b ? res() : rej(new Error('null'))), 'image/png'); } catch (e) { rej(e); } });
            r.toBlob = 'ok';
        } catch (e) { r.toBlob = e.name + ': ' + e.message; }
        try { cv.toDataURL(); r.toDataURL = 'ok'; } catch (e) { r.toDataURL = e.name; }
        return r;
    })()`);
    check(out.loaded, 'qflocal 图片能加载', JSON.stringify(out));
    check(out.getImageData === 'ok', '画布未被 taint：getImageData 可读', out.getImageData);
    check(out.toBlob === 'ok', '画布可导出：toBlob 成功', out.toBlob);
    check(out.toDataURL === 'ok', '画布可导出：toDataURL 成功', out.toDataURL);
    await win.close();
    console.log('');
    if (failures.length) { console.log(`FAILURE  ${failures.length} 项未通过`); app.exit(1); }
    else { console.log('ALL PASS'); app.exit(0); }
}
main().catch((e) => { console.error(e && e.stack || e); app.exit(1); });
