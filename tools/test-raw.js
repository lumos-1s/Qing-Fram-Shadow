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
        const edge = Math.max(0, Number(u.searchParams.get('q')) || 0);
        try {
            const out = await RAW.develop(p, { params, maxEdge: edge, halfSize: edge > 0 });
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

    // ── ④ 普通 JPEG：面板收起 ──
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

    // ── ⑤ 草稿只存参数 ──
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
            bytes: captured ? JSON.stringify(captured).length : 0
        };
    })()`);
    check(draft.has && draft.params && draft.params.exposure === 1.5 && draft.keys.length === 1,
        '草稿只记显影参数（几个数字），不存像素', JSON.stringify({ keys: draft.keys, bytes: draft.bytes }));

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await sleep(120);
    await win.destroy();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error('FAIL 用例异常：', e && e.stack || e);
    app.exit(1);
});
