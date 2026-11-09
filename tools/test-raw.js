// RAW 导入与显影：端到端用例（真的调 libraw-wasm 解一张 ARW，不是打桩）。
//
// 覆盖：
//  ① 导入 RAW 后拿到的是代理尺寸（长边 1600）而不是原图，面板出现在「调色」上方
//  ② 拖动曝光滑块：参数写进这张图，画面真的变亮（量画布平均亮度，不是看 DOM）
//  ③ 停手后 rawEnsureFull 能把同一张图升到全尺寸，参数不变
//  ④ 换回普通 JPEG：面板收起，不会对非 RAW 图做显影
//  ⑤ 草稿只存几个数字（显影参数），不存像素
//
// 样本：默认读 .tmp/rawspike/user.ARW，也可用 QF_RAW_SAMPLE 指定。
// 找不到样本时整条用例 SKIP（退出码 0）——RAW 解码需要真实文件，不适合造假数据。
//
// 用法：node tools/run-electron.js tools/test-raw.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const SAMPLE = process.env.QF_RAW_SAMPLE || path.join(ROOT, '.tmp', 'rawspike', 'user.ARW');
const RAW = require(path.join(ROOT, 'src', 'main', 'raw.js'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 测试窗口自己当 qflocal 的服务端：走的是产品里同一条 develop 路径，
// 所以「URL 里的参数 → 解码 → JPEG → <img>」整条链都被覆盖到。
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const CORS = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff'
};

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const OPEN_ITEMS = [];
ipcMain.handle('open-images', () => OPEN_ITEMS.slice());
ipcMain.handle('open-image', () => (OPEN_ITEMS[0] || null));
ipcMain.handle('read-exif', () => ({}));
for (const ch of ['list-presets', 'list-logos', 'list-textures', 'list-templates', 'list-wall-covers',
    'list-grade-presets', 'load-acr-tables']) {
    ipcMain.handle(ch, () => (ch === 'list-presets' ? [] : []));
}
ipcMain.handle('load-preset', () => null);
ipcMain.handle('load-acr-shadows', () => null);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir', 'save-image-base64', 'save-images-batch', 'externalize-draft',
    'save-grade-preset', 'delete-grade-preset', 'rename-grade-preset']) {
    ipcMain.handle(ch, () => ({ ok: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.24', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

async function main() {
    await app.whenReady();
    if (!fs.existsSync(SAMPLE)) {
        console.log('SKIP  没找到 RAW 样本（' + SAMPLE + '），跳过 RAW 用例');
        app.exit(0);
        return;
    }
    RAW.setCacheRoot(path.join(ROOT, '.tmp', 'raw-cache-test'));
    protocol.handle('qflocal', async (request) => {
        const u = new URL(request.url);
        const p = u.searchParams.get('p');
        if (!p || !RAW.isRaw(p)) return new Response('not raw', { status: 404, headers: CORS });
        let params = {};
        try { params = JSON.parse(u.searchParams.get('raw') || '{}'); } catch (e) { params = {}; }
        let crop = null;
        const cropParam = u.searchParams.get('crop');
        if (cropParam) {
            try { crop = JSON.parse(cropParam); } catch (e) { crop = null; }
        }
        const rotate = Math.max(0, Math.min(3, Math.round(Number(u.searchParams.get('rot')) || 0)));
        const edge = Math.max(0, Number(u.searchParams.get('q')) || 0);
        try {
            const out = await RAW.develop(p, { params, maxEdge: edge, halfSize: edge > 0, crop, rotate });
            return new Response(out.jpg, { headers: { ...CORS, 'content-type': 'image/jpeg' } });
        } catch (e) {
            return new Response('fail: ' + e.message, { status: 415, headers: CORS });
        }
    });

    OPEN_ITEMS.push({
        name: path.basename(SAMPLE), path: SAMPLE, size: fs.statSync(SAMPLE).size,
        raw: true, exif: { make: 'SONY', model: 'ILCE-6000', iso: 'ISO100', orientation: 1 }
    });

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
    await sleep(900);

    // ── ① 导入 ──
    const imported = await exec(`(async () => {
        const A = window.App;
        if (A.loadPresets) { try { await A.loadPresets(); } catch (_) {} }
        await A.openImages();
        const im = A.images[0];
        if (!im) return { error: '没有导入任何照片' };
        const panel = document.getElementById('grpRaw');
        return {
            n: A.images.length,
            hasRaw: !!im.raw,
            w: im.w, h: im.h,
            full: !!(im.raw && im.raw.full),
            params: im.raw && im.raw.params,
            panelHidden: panel ? panel.hidden : null,
            badge: (document.getElementById('rawBadge') || {}).textContent,
            state: (document.getElementById('rawState') || {}).textContent,
            emH: A.image === im ? 1 : 0
        };
    })()`);
    check(!imported.error && imported.n === 1, 'RAW 能导入并成为当前照片', JSON.stringify(imported));
    check(imported.hasRaw === true && imported.params && imported.params.highlights === 25,
        '导入时建立默认显影参数', JSON.stringify(imported.params));
    check(imported.w === 1600 && imported.full === false,
        '首屏是 1600px 代理，不是原图', `${imported.w}×${imported.h}`);
    check(imported.panelHidden === false && imported.badge === 'ARW',
        '「RAW 显影」面板出现，徽章显示 ARW', `badge=${imported.badge} state=${imported.state}`);

    // ── ② 拖曝光：参数生效且画面真变亮 ──
    const before = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const c = document.createElement('canvas');
        c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.drawImage(im.el, 0, 0, 120, 80);
        const d = g.getImageData(0, 0, 120, 80).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        return +(s / (d.length / 4)).toFixed(2);
    })()`);
    const after = await exec(`(async () => {
        const A = window.App;
        const sl = document.getElementById('slRawExp');
        sl.value = '1.5';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // 1100ms：代理已解完(220 防抖 + 约 500 解码)，但还没到自动升全尺寸的 1.1s 空闲点
        await wait(1100);
        await A.flushRender();
        const im = A.image;
        const c = document.createElement('canvas');
        c.width = 120; c.height = 80;
        const g = c.getContext('2d');
        g.drawImage(im.el, 0, 0, 120, 80);
        const d = g.getImageData(0, 0, 120, 80).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        return {
            mean: +(s / (d.length / 4)).toFixed(2),
            exposure: im.raw.params.exposure,
            label: (document.getElementById('lblRawExp') || {}).textContent,
            w: im.w,
            full: im.raw.full
        };
    })()`);
    check(after.exposure === 1.5 && after.label === '+1.50',
        '曝光参数写进这张图，数值标签同步', JSON.stringify(after));
    check(after.mean > before * 1.25,
        '拖曝光后画面确实变亮（不是只改了数字）', `${before} → ${after.mean}`);
    check(after.full === false && after.w === 1600,
        '拖动阶段仍然只解代理，不会每动一下就重解全尺寸', `w=${after.w} full=${after.full}`);

    // ── ③ 全尺寸显影 ──
    const full = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const t0 = Date.now();
        const ok = await A.rawEnsureFull(im);
        await A.flushRender();
        return { ok, w: im.w, h: im.h, full: im.raw.full, sec: ((Date.now() - t0) / 1000).toFixed(1),
                 state: (document.getElementById('rawState') || {}).textContent };
    })()`);
    // 不校验耗时：同一组参数可能命中上次跑留下的磁盘缓存（这正是缓存该做的事）
    check(full.ok && full.full === true && full.w > 3000,
        '停手后能升到全尺寸，导出不会只剩 1600px', JSON.stringify(full));
    check(/^\d+×\d+$/.test(String(full.state || '').trim()),
        '标题行右侧写明当前像素尺寸', full.state);

    // ── ④ RAW 裁切/旋转：参数化视图不能被下一次显影冲掉 ──
    const view = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const fullW = im.w, fullH = im.h;
        if (A.savePhotoOrigin) A.savePhotoOrigin(im);
        const okCrop = await A.rawRecordCrop(im, { W: fullW, H: fullH, turns: 0, useOrig: false },
            { x: 0, y: 0, w: Math.round(fullW / 2), h: Math.round(fullH / 2) });
        clearTimeout(A._rawFullTimer);
        const crop1 = im.raw.crop ? JSON.parse(JSON.stringify(im.raw.crop)) : null;
        const croppedW = im.w, croppedH = im.h;
        A.setGrade({ exp: 0.3 });
        const sl = document.getElementById('slRawCon');
        sl.value = '20';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1200);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            okCrop, fullW, fullH, croppedW, croppedH,
            crop1, crop2: im.raw.crop,
            w2: im.w, h2: im.h,
            contrast: im.raw.params.contrast,
            gradeNeutral: !!(im._grade && im._grade.neutral),
            gradeLowKey: !!(im._grade && im._grade.lowKey),
            gradeSrc: window.photoSrcOf(im) !== im.el
        };
    })()`);
    check(view.okCrop && view.crop1 && view.croppedW < view.fullW && view.croppedH < view.fullH,
        'RAW 裁切写进显影视图，代理按裁切后的尺寸重解',
        JSON.stringify({ full: [view.fullW, view.fullH], crop: [view.croppedW, view.croppedH] }));
    check(JSON.stringify(view.crop2) === JSON.stringify(view.crop1) &&
        view.w2 === view.croppedW && view.h2 === view.croppedH,
        '再拖显影滑块不会把裁切冲掉',
        JSON.stringify({ crop1: view.crop1, crop2: view.crop2, size: [view.w2, view.h2] }));
    check(view.gradeNeutral === false && view.gradeLowKey === true && view.gradeSrc === true,
        'RAW 重解后调色仍然生效（不是退回未调色原图）',
        JSON.stringify({ neutral: view.gradeNeutral, lowKey: view.gradeLowKey, src: view.gradeSrc }));
    check(view.contrast === 20, '显影滑块参数写入这张图', String(view.contrast));

    const rot = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const beforeW = im.w, beforeH = im.h;
        const crop = im.raw.crop ? JSON.stringify(im.raw.crop) : null;
        const ok = await A.rawRecordCrop(im, { W: beforeW, H: beforeH, turns: 1, useOrig: false },
            { x: 0, y: 0, w: beforeW, h: beforeH });
        clearTimeout(A._rawFullTimer);
        return { ok, beforeW, beforeH, w: im.w, h: im.h, rotate: im.rotate, crop,
            crop2: im.raw.crop ? JSON.stringify(im.raw.crop) : null };
    })()`);
    check(rot.ok && rot.rotate === 1 && rot.w === rot.beforeH && rot.h === rot.beforeW,
        '裁切弹层里的旋转记进显影视图，画面宽高对调', JSON.stringify(rot));
    check(rot.crop === rot.crop2, '旋转后裁切框仍指向同一块原图区域',
        JSON.stringify({ before: rot.crop, after: rot.crop2 }));

    // ── ⑤ 撤销：显影参数进撤销栈，一次拖动只压一张；撤销不能把裁切/旋转冲掉 ──
    const undo = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        A.undoStack = []; A.redoStack = [];
        const crop0 = im.raw.crop ? JSON.stringify(im.raw.crop) : null;
        const rot0 = im.rotate;
        const before = im.raw.params.exposure;
        const slider = document.getElementById('slRawExp');
        slider.value = '0.8';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        const pushedOne = A.undoStack.length;
        slider.value = '1.1';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        const pushedTwo = A.undoStack.length;
        await wait(1300);
        clearTimeout(A._rawFullTimer);
        const afterDrag = im.raw.params.exposure;
        A.undo();
        await wait(1300);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            before, pushedOne, pushedTwo, afterDrag,
            exposure: im.raw.params.exposure,
            cropNow: im.raw.crop ? JSON.stringify(im.raw.crop) : null,
            rotNow: im.rotate, crop0, rot0
        };
    })()`);
    check(undo.pushedOne === 1 && undo.pushedTwo === 1,
        '一次拖动只压一张显影快照（连续 input 共用）',
        JSON.stringify({ first: undo.pushedOne, second: undo.pushedTwo }));
    check(Math.abs(undo.afterDrag - 1.1) < 1e-6 && Math.abs(undo.before - 1.5) < 1e-6,
        '拖动过程参数连续写入，停在最后一档', JSON.stringify({ before: undo.before, after: undo.afterDrag }));
    check(Math.abs(undo.exposure - undo.before) < 1e-6,
        '撤销回到拖动前的显影参数', JSON.stringify({ now: undo.exposure, before: undo.before }));
    check(undo.cropNow === undo.crop0 && undo.rotNow === undo.rot0,
        '撤销不会把裁切与旋转一起带回去（视图跟参数分开存）',
        JSON.stringify({ crop0: undo.crop0, cropNow: undo.cropNow, rot0: undo.rot0, rotNow: undo.rotNow }));

    // ── ⑥ 普通 JPEG：面板收起 ──
    const plain = await exec(`(async () => {
        const A = window.App;
        const c = document.createElement('canvas');
        c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#7a9bbd'; g.fillRect(0, 0, 600, 400);
        const el = new Image();
        await new Promise((r) => { el.onload = r; el.src = c.toDataURL('image/jpeg', 0.9); });
        const im = { el, name: 'plain.jpg', path: 'C:/fake/plain.jpg', w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images.push(im);
        A.buildThumbnails();
        A.selectImage(A.images.length - 1);
        A.refreshUI();
        const panel = document.getElementById('grpRaw');
        // 只看 hidden 属性不够：.param-group 若被 CSS 设了 display，属性会被压过去
        return { hidden: panel.hidden, display: getComputedStyle(panel).display, hasRaw: !!A.image.raw };
    })()`);
    check(plain.hidden === true && plain.display === 'none' && plain.hasRaw === false,
        '换成普通 JPEG 后面板收起（display:none），不会误显影', JSON.stringify(plain));

    // ── ⑦ 草稿只存参数与视图 ──
    const draft = await exec(`(async () => {
        const A = window.App;
        A.selectImage(0);
        let captured = null;
        A._persistDraft = async (d) => { captured = d; };
        A.saveDraftNow();
        const row = (captured && captured.images || []).find((r) => r && r.raw);
        return {
            has: !!row,
            params: row && row.raw && row.raw.params,
            keys: row ? Object.keys(row.raw) : [],
            crop: row && row.raw.crop,
            rotate: row && row.raw.rotate,
            bytes: captured ? JSON.stringify(captured).length : 0
        };
    })()`);
    check(draft.has && draft.params && draft.params.exposure === 1.5 &&
        draft.keys.length === 3 && draft.crop && draft.rotate === 1,
        '草稿只记显影参数与视图（几个数字），不存像素',
        JSON.stringify({ keys: draft.keys, rotate: draft.rotate, bytes: draft.bytes }));

    // ── ⑧ 还原原图：RAW 回到最初的显影视图，而不是换回一张旧代理 ──
    const restored = await exec(`(async () => {
        const A = window.App; const im = A.image;
        const ok = A.restoreOriginalPhoto(im);
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1200);
        clearTimeout(A._rawFullTimer);
        await A.flushRender();
        return {
            ok, crop: im.raw.crop, rotate: im.rotate, hasOrig: !!im.orig,
            w: im.w, h: im.h
        };
    })()`);
    check(restored.ok && !restored.crop && restored.rotate === 0 && restored.hasOrig === false,
        'RAW「还原原图」清掉裁切/旋转并按原图重解', JSON.stringify(restored));

    // ── ⑨ 连续全尺寸显影：wasm 堆只涨不缩，解几张之后会把线程吃死 ──
    // 复现过的现场：连续十几次显影后线程 RSS 到 2.4GB，再解就抛 "[object Object]"，
    // 全尺寸失败 → 导出只能拿 1600px 代理。修法是解满定额就换掉整个线程。
    {
        const before = RAW.stats();
        let okCount = 0, err = '';
        const t0 = Date.now();
        // 参数带一点随机抖动：否则第二次跑会命中上一次留下的磁盘缓存，
        // 根本没有解码，也就测不到「线程会不会被吃死」。
        const jitter = (Date.now() % 1000) / 100000;
        for (let i = 0; i < 3; i++) {
            try {
                const out = await RAW.develop(SAMPLE, {
                    params: { exposure: -0.6 + i * 0.37 + jitter, contrast: 5, highlights: 20, temperature: -8, tint: 3 },
                    maxEdge: 0,
                    halfSize: false
                });
                if (out.width > 3000 && out.height > 2000) okCount++;
            } catch (e) { err = String((e && e.message) || e); }
        }
        // 回收是延迟 1.2s 做的（避免用户刚拖完滑块就重建 wasm），等它落地
        await sleep(1600);
        const after = RAW.stats();
        check(okCount === 3 && !err,
            '连续 3 张全尺寸显影都成功（线程不会被 wasm 堆吃死）',
            `${okCount}/3 ${err} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        check(after.recycles > before.recycles,
            '解满定额后解码线程被回收，内存真正还给系统',
            JSON.stringify({ before: before.recycles, after: after.recycles, rss: after.rss }));
    }

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await sleep(120);
    await win.destroy();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error('FAIL 用例异常：', e && e.stack || e);
    app.exit(1);
});
