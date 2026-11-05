// 量化「同一张图 + 同一 XMP」在本软件与 Lightroom 之间的成像差异。
//   ① 用软件真实调色管线渲染（AppXmp.mapXmp → template → canvas）
//   ② 与 LR 导出、软件自身导出三方对比（平均色/亮度分位/饱和度）
//   ③ 只统计中心 88% 区域，避开边框与暗角对均值的干扰
// 用法: node tools/run-electron.js tools/analyze-xmp-diff.js
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
const ROOT = path.join(__dirname, '..');
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const SRC = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-250Z-7bc108c8.jpg'; // 原图
const LR = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-248Z-41ebf587.jpg';
const APP_OUT = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-244Z-460e442c.jpg';

const b64 = (f) => fs.readFileSync(f).toString('base64');
const dataUrl = (f) => 'data:image/jpeg;base64,' + b64(f);

ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
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
    const w = new BrowserWindow({
        width: 1400, height: 900, show: true,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false }
    });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsColor)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const xmpText = fs.readFileSync(XMP, 'utf8');
    const out = await w.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        A.saveCurrentTemplate = () => {};
        const src = new Image();
        await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = ${JSON.stringify(dataUrl(SRC))}; });
        const im = { name: 'raw', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
        A.template = A.defaultTemplate();
        A.template.photoFrameStyle = 'SIMPLE';

        // UI 导入前会等 ACR 实测表就绪(参数曲线/校准矩阵要用它),脚本必须同样等待
        if (window.QfsAcr && window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
        const mapped = window.AppXmp.mapXmp(${JSON.stringify(xmpText)});

        A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
        await A.flushRender(); await sleep(300);
        // 调色参数挂在图上(im.grade),必须走 setGrade 才会真正烘焙
        A.setGrade(mapped.patch, { replace: true, full: true });
        await A.flushRender(); await sleep(2500);
        if (window.ensureFullGrade) window.ensureFullGrade(A.image);
        await A.flushRender(); await sleep(600);
        window.__render(A, false);
        await sleep(300);
        const cv = A.dom.canvas;
        const stats = (img, w2, h2) => {
            const c = document.createElement('canvas'); c.width = w2; c.height = h2;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0, w2, h2);
            const x0 = Math.round(w2 * 0.06), y0 = Math.round(h2 * 0.06);
            const ww = Math.round(w2 * 0.88), hh = Math.round(h2 * 0.88);
            const d = g.getImageData(x0, y0, ww, hh).data;
            const n = ww * hh;
            let sr = 0, sg = 0, sb = 0, sat = 0;
            const hist = new Uint32Array(256);
            for (let i = 0; i < d.length; i += 4) {
                const r = d[i], gg = d[i + 1], b = d[i + 2];
                sr += r; sg += gg; sb += b;
                const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
                sat += mx === 0 ? 0 : (mx - mn) / mx;
                hist[Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b)]++;
            }
            const pct = (p) => { const t = n * p; let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i; } return 255; };
            return { mean: [sr / n, sg / n, sb / n].map(v => Math.round(v)), lum: [pct(0.05), pct(0.25), pct(0.5), pct(0.75), pct(0.95)], sat: Math.round(sat / n * 1000) / 10 };
        };
        const load = async (u) => { const i = new Image(); await new Promise(r => { i.onload = r; i.src = u; }); return i; };
        const lrImg = await load(${JSON.stringify(dataUrl(LR))});
        const appImg = await load(${JSON.stringify(dataUrl(APP_OUT))});

        return JSON.stringify({
            patch: mapped.patch,
            applied: mapped.applied,
            skipped: mapped.skipped,
            engine: stats(cv, 600, Math.round(600 * cv.height / cv.width)),
            baked: (function(){ const b = A.image && A.image._grade && A.image._grade.canvas; if (!b) return null; return stats(b, 600, Math.round(600 * b.height / b.width)); })(),
            lr: stats(lrImg, 600, Math.round(600 * lrImg.naturalHeight / lrImg.naturalWidth)),
            app: stats(appImg, 600, Math.round(600 * appImg.naturalHeight / appImg.naturalWidth))
        });
    })()`);

    const r = JSON.parse(out);
    console.log('应用到的项:', r.applied.join(' / '));
    console.log('跳过:', (r.skipped || []).join(' / ') || '无');
    console.log('patch:', JSON.stringify(r.patch).slice(0, 600));
    console.log('');
    console.log('来源        平均RGB          亮度 5/25/50/75/95      饱和%');
    for (const k of ['lr', 'app', 'engine', 'baked']) {
        const v = r[k];
        if (!v) { console.log(label.padEnd(10), '(无)'); continue; }
        const label = { lr: 'LR 导出', app: '软件导出', engine: '预览画布', baked: '烘焙全图' }[k];
        console.log(label.padEnd(10), ('(' + v.mean.join(',') + ')').padEnd(16), v.lum.join('/').padEnd(24), String(v.sat).padStart(5));
    }
    const d = (a, b) => r[b].mean.map((v, i) => v - r[a].mean[i]).join(',');
    console.log('');
    console.log('本次渲染 - LR      RGB 偏差:', d('lr', 'engine'));
    console.log('本次渲染 - LR      亮度偏差:', r.engine.lum.map((v, i) => v - r.lr.lum[i]).join('/'), ' 饱和:', (r.engine.sat - r.lr.sat).toFixed(1));
    console.log('软件导出 - LR      RGB 偏差:', d('lr', 'app'));
    app.exit(0);
}).catch(e => { console.error(e && e.stack || e); app.exit(1); });
