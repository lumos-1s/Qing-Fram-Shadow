// 整窗拖入：真的派发一次系统拖放（Input.dispatchDragEvent + 真实文件路径），
// 不是假造 DragEvent —— 只有真实派发才能覆盖 webUtils.getPathForFile 这一段。
//
// 背景：拖放原先只绑在中间画布 #canvasPane 上。把照片拖到左侧素材栏、右侧参数栏
// 或底部胶片条上时没人 preventDefault，Chromium 会按默认行为导航到那个 file:// URL，
// 整个界面被一张图替换 —— 用户看到的就是「不支持拖入」。
//
// 覆盖：
//  ① 拖到左栏（画布之外）会出现整窗遮罩，且遮罩真的盖住整个视口
//  ② 在左栏松手能导入：collect-images 收到真实路径、照片进胶片条、遮罩收起
//  ③ 应用内拖动（不带 Files 类型）既不显示遮罩也不导入
//  ④ 卡片这类自己处理 drop 的区域（preventDefault）不会被窗口再导入一次
//  ⑤ 遮罩元素挂在 body 上（三栏都能盖住，不受 #canvasPane 的 overflow 裁切）
//
// 用法：node tools/run-electron.js tools/test-dragdrop.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, nativeImage } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// 临时样本：1×1 PNG 转成 JPEG，够 <img> 解码出 naturalWidth，不依赖仓库里的素材。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-drop-'));
const SAMPLE = path.join(tmp, '拖入样本.jpg');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
fs.writeFileSync(SAMPLE, nativeImage.createFromBuffer(Buffer.from(PNG_B64, 'base64')).toJPEG(92));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const collectCalls = [];
ipcMain.handle('collect-images', (_e, paths) => {
    collectCalls.push(Array.isArray(paths) ? paths.slice() : paths);
    const items = (paths || []).map((p) => {
        let size = 0;
        try { size = fs.statSync(p).size; } catch (e) { /* ignore */ }
        return { name: path.basename(p), path: p, size, raw: false, exif: { orientation: 1 } };
    });
    return { items, skipped: 0 };
});

for (const ch of ['list-presets', 'list-logos', 'list-textures', 'list-templates', 'list-wall-covers',
    'list-grade-presets', 'load-acr-tables', 'load-acr-shadows', 'pick-grade-xmp-files']) {
    ipcMain.handle(ch, () => []);
}
for (const ch of ['load-preset', 'load-all-presets', 'load-template', 'open-image', 'open-images',
    'open-image-folder', 'read-clipboard-image', 'pick-export-location', 'write-export-files',
    'save-image-base64', 'save-images-batch', 'import-template', 'open-qfs', 'open-sticker-image',
    'read-exif', 'pick-wall-cover']) {
    ipcMain.handle(ch, () => null);
}
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir', 'externalize-draft', 'save-grade-preset', 'delete-grade-preset',
    'rename-grade-preset', 'clear-wall-cover', 'open-grade-presets-dir',
    'save-grade-preset-xmp', 'export-grade-preset-xmp']) {
    ipcMain.handle(ch, () => ({ ok: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: tmp, appPath: ROOT
}));

async function main() {
    await app.whenReady();

    // 和产品里同一条托管路径：qflocal 只服务登记过的文件，这里就服务这个临时样本。
    protocol.handle('qflocal', async (request) => {
        const u = new URL(request.url);
        const p = u.searchParams.get('p');
        try {
            const buf = await fs.promises.readFile(p);
            return new Response(buf, {
                headers: {
                    'access-control-allow-origin': '*',
                    'content-type': /\.png$/i.test(p) ? 'image/png' : 'image/jpeg'
                }
            });
        } catch (e) {
            return new Response('not found', { status: 404 });
        }
    });

    const win = new BrowserWindow({
        width: 1280, height: 860, show: false, paintWhenInitiallyHidden: true,
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

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const drag = (type, x, y, files) => dbg.sendCommand('Input.dispatchDragEvent', {
        type, x, y,
        data: { items: [], files: files || [], dragOperationsMask: 1 }
    });

    const geo = await exec(`(() => {
        const r = document.getElementById('sidebar').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    check(geo.w > 100 && geo.h > 200, '左栏可作画布之外的落点', JSON.stringify(geo));

    const overlayState = () => exec(`(() => {
        const ov = document.getElementById('dropOverlay');
        const cs = ov ? getComputedStyle(ov) : null;
        const r = ov ? ov.getBoundingClientRect() : null;
        return {
            inBody: !!ov && ov.parentNode === document.body,
            active: document.body.classList.contains('drop-active'),
            display: cs ? cs.display : '',
            covers: !!r && Math.abs(r.left) < 1 && Math.abs(r.top) < 1
                && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1
        };
    })()`);

    // ── ① 拖到左栏：整窗遮罩出现 ──
    await drag('dragEnter', geo.x, geo.y, [SAMPLE]);
    await drag('dragOver', geo.x, geo.y, [SAMPLE]);
    await sleep(120);
    const overSidebar = await overlayState();
    check(overSidebar.active && overSidebar.display === 'flex',
        '拖到左栏（画布之外）也会出现拖入遮罩', JSON.stringify(overSidebar));
    check(overSidebar.covers, '遮罩盖住整个视口，不只是中间画布', JSON.stringify(overSidebar));
    check(overSidebar.inBody, '遮罩挂在 body 上（不受三栏 overflow 裁切）', String(overSidebar.inBody));

    // ── ② 在左栏松手：真的导入 ──
    await drag('drop', geo.x, geo.y, [SAMPLE]);
    await sleep(1500);
    const dropped = await exec(`(() => ({
        n: (window.App.images || []).length,
        name: window.App.images && window.App.images[0] ? window.App.images[0].name : '',
        w: window.App.images && window.App.images[0] ? window.App.images[0].w : 0,
        url: location.href,
        thumbs: document.querySelectorAll('#thumbStrip .thumb').length
    }))()`);
    check(collectCalls.length === 1 && collectCalls[0][0] === SAMPLE,
        '左栏松手把真实文件路径交给了收集接口', JSON.stringify(collectCalls));
    check(dropped.n === 1 && dropped.w > 0 && dropped.name === path.basename(SAMPLE),
        '拖入的照片真的进了胶片条（不是只弹个提示）', JSON.stringify(dropped));
    const afterDrop = await overlayState();
    check(!afterDrop.active && afterDrop.display === 'none', '松手后遮罩收起', JSON.stringify(afterDrop));
    check(/index\.html$/.test(dropped.url), '落点没有把窗口导航成 file:// 图片', dropped.url);

    // ── ③ 应用内拖动（不带 Files）不该触发 ──
    await drag('dragEnter', geo.x, geo.y, []);
    await drag('dragOver', geo.x, geo.y, []);
    await sleep(100);
    const internal = await overlayState();
    check(internal.display === 'none', '应用内拖动（无 Files 类型）不显示导入遮罩', JSON.stringify(internal));

    // ── ④ 自己处理 drop 的区域不重复导入 ──
    const before = collectCalls.length;
    await exec(`(() => {
        const d = document.createElement('div');
        d.id = 'ownDropZone';
        d.style.cssText = 'position:fixed;left:20px;top:360px;width:180px;height:140px;z-index:99999;background:rgba(0,0,0,.01)';
        d.addEventListener('drop', (e) => { e.preventDefault(); window.__ownDrop = (window.__ownDrop || 0) + 1; });
        d.addEventListener('dragover', (e) => { e.preventDefault(); });
        document.body.appendChild(d);
        return true;
    })()`);
    await drag('dragEnter', geo.x, geo.y, [SAMPLE]);   // 点落在 ownDropZone 内
    await drag('dragOver', geo.x, geo.y, [SAMPLE]);
    await drag('drop', geo.x, geo.y, [SAMPLE]);
    await sleep(400);
    const own = await exec(`({ hits: window.__ownDrop || 0 })`);
    check(own.hits === 1, '区域自己的 drop 处理被调用', JSON.stringify(own));
    check(collectCalls.length === before, '已处理过 drop 的区域不会被窗口再导入一次',
        `before=${before} after=${collectCalls.length}`);
    const afterOwn = await overlayState();
    check(afterOwn.display === 'none', '这种落点同样不显示导入遮罩', JSON.stringify(afterOwn));

    // ── ⑤ 启动时的边框墙：拖图进来要关墙并导入，遮罩要压在墙上面 ──
    const wallPoint = await exec(`(() => {
        const A = window.App;
        if (typeof A.openPresetWall === 'function') A.openPresetWall(false);
        const wall = document.getElementById('presetWall');
        if (!wall || wall.hidden) return { error: '边框墙没打开' };
        const r = wall.getBoundingClientRect();
        for (let y = r.top + 4; y < r.bottom; y += 6) {
            for (let x = r.left + 4; x < r.right; x += 6) {
                const el = document.elementFromPoint(x, y);
                if (el && el.closest('#presetWall') && !el.closest('.pw-tile')) {
                    return { x: Math.round(x), y: Math.round(y),
                        overlayZ: Number(getComputedStyle(document.getElementById('dropOverlay')).zIndex),
                        wallZ: Number(getComputedStyle(wall).zIndex) };
                }
            }
        }
        return { error: '墙上找不到卡片之外的落点' };
    })()`);
    check(!wallPoint.error, '边框墙可作启动时的落点', JSON.stringify(wallPoint));
    if (!wallPoint.error) {
        await drag('dragEnter', wallPoint.x, wallPoint.y, [SAMPLE]);
        await drag('dragOver', wallPoint.x, wallPoint.y, [SAMPLE]);
        await sleep(120);
        const overWall = await overlayState();
        check(overWall.display === 'flex' && wallPoint.overlayZ > wallPoint.wallZ,
            '边框墙上拖入也有遮罩，层级压在墙（z=900）之上',
            JSON.stringify({ ...overWall, overlayZ: wallPoint.overlayZ, wallZ: wallPoint.wallZ }));
        await drag('drop', wallPoint.x, wallPoint.y, [SAMPLE]);
        await sleep(1500);
        const afterWall = await exec(`(() => ({
            wallHidden: !!document.getElementById('presetWall').hidden,
            editing: document.body.classList.contains('editing'),
            n: (window.App.images || []).length
        }))()`);
        check(afterWall.n === 2 && afterWall.wallHidden && afterWall.editing,
            '往墙上拖图 = 关墙进工作台并导入（不会像什么都没发生）', JSON.stringify(afterWall));
    }

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await win.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});
