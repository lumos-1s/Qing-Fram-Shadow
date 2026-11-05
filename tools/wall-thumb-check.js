// 边框墙「本图预览」的实际渲染复现：走 _renderWallPhotoThumb（displayMax=560, dpr=1），
// 用来核对引擎改动（通道平衡 / 高光收口 / 锐化）对墙上缩略图的影响有多大。
//   node tools/run-electron.js tools/wall-thumb-check.js            # 当前代码
//   OUTNAME=wall_old ...                                            # 换名
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const OUT = path.join(__dirname, 'out');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

// 挑几个风格差异大的预设，覆盖面广一些
const PICKS = ['001-滨田英明调色 [霜绝预设]', '3D卡片', 'NOMO复古相机', '仿古邮票'];

ipcMain.handle('load-acr-tables', () => {
    const raw = fs.readFileSync(ACR);
    const planes = zlib.inflateSync(raw.slice(10));
    return {
        size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
        data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
    };
});
ipcMain.handle('load-acr-shadows', () => {
    const raw = fs.readFileSync(SHD);
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
    const w = new BrowserWindow({
        show: false, width: 1200, height: 800,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
    });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsAcr)')) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    const PRICKS = PICKS;

const LOADED = PICKS.map((name) => {
    const fp = path.join(ROOT, 'shared', 'presets', name + '.json');
    if (!fs.existsSync(fp)) return null;
    try {
        const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
        d._fileName = name;
        return d;
    } catch (e) { return null; }
}).filter(Boolean);
    const out = await w.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const A = window.App;
        A.saveCurrentTemplate = () => {};
        const raw = new Image();
        await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
        const im = { name: 'DSC09381', el: raw, w: raw.naturalWidth, h: raw.naturalHeight, exif: {} };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
        A.template = A.defaultTemplate();
        if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
        if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
        for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);
        // ★ 关键：墙上缩略图用的是「用户调完色的照片」（photoSrcOf → im._grade.canvas），
        //   不是原图。所以必须先把这张照片调成用户当前的状态，才复现得出他看到的画面。
        const applyGrade = ${process.env.NO_GRADE ? 'false' : 'true'};
        let gradeInfo = null;
        if (applyGrade) {
            const xmpText = ${JSON.stringify(fs.readFileSync('D:/预设/001-滨田英明调色 [霜绝预设].xmp', 'utf8'))};
            const p = window.AppXmp.mapXmp(xmpText).patch;
            A.setGrade(p, { replace: true, full: true });
            await A.flushRender(); await sleep(300);
            if (window.ensureFullGrade) window.ensureFullGrade(im);
            await A.flushRender(); await sleep(1200);
            gradeInfo = { det: p.det || null, temp: p.temp, tint: p.tint, exp: p.exp };
        }
        A.presets = ${JSON.stringify(LOADED)};
        const picks = ${JSON.stringify(PICKS)};
        const res = [];
        for (const name of picks) {
            const preset = (A.presets || []).find((p) => String(p._fileName || '').replace(/\\.json$/i, '') === name);
            if (!preset) { res.push({ name, error: 'not found' }); continue; }
            const src = A._renderWallPhotoThumb(preset, im);
            await sleep(30);
            const det = (im.grade && im.grade.det) || null;
            const meta = window.QfsSharpen && window.QfsSharpen.paramsOf
                ? window.QfsSharpen.paramsOf(det || {}, 560, Math.max(raw.naturalWidth, raw.naturalHeight))
                : null;
            res.push({ name, src: src || '', len: (src || '').length, det, gradeInfo, P: meta });
        }
        return res;
    })()`);
    const tag = process.env.OUTNAME || 'wall_new';
    let n = 0;
    for (const r of out) {
        if (!r.src) { console.log(r.name, '渲染失败', r.error || ''); continue; }
        const b64 = r.src.slice(r.src.indexOf(',') + 1);
        const head = r.src.slice(0, r.src.indexOf(','));
        const ext = head.indexOf('webp') >= 0 ? '.webp' : '.jpg';
        const f = path.join(OUT, tag + '_' + (n++) + ext);
        fs.writeFileSync(f, Buffer.from(b64, 'base64'));
        console.log(tag, r.name, '→', path.basename(f), '锐化', JSON.stringify(r.P), '调色', JSON.stringify(r.gradeInfo));
    }
    app.quit();
});
