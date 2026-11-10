// 调色 GL 通道：任何情况下都不能把「整片纯黑」当成烘焙结果交出去。
// 根因：webglcontextlost 重建后 lutTex 被新建为空纹理，但 lutKey 仍是旧值，
// passGL 会跳过 LUT 上传 → shader 采空纹理 → 整幅纯黑；旋转换烘焙尺寸时最易触发。
// 用法: node tools/run-electron.js tools/test-grade-gl-black.js
//       QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" ... 可额外验 GL 分支
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => { try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; } });
for (const ch of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(ch, () => []);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir']) ipcMain.handle(ch, () => ({ ok: true }));
for (const ch of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(ch, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
// 真实 ACR 表：让 QfsAcr.ready() 为 true，才会走 3D LUT 那条 GL 分支
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('load-acr-shadows', () => null);

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const HELPERS = `
window.__px = (src) => {
    if (!src) return { err: 'null' };
    const w = src.width || src.naturalWidth || 0, h = src.height || src.naturalHeight || 0;
    if (!w || !h) return { err: 'zero' };
    const c = document.createElement('canvas');
    c.width = Math.min(w, 120); c.height = Math.min(h, 120);
    const g = c.getContext('2d'); g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let black = 0, n = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i+1] + d[i+2] < 60) black++;
        sum += (d[i] + d[i+1] + d[i+2]) / 3;
        n++;
    }
    return { w, h, avg: Math.round(sum / n), blackPct: Math.round(black * 100 / n) };
};
window.__colorCanvas = (w, h, black) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (black) { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); }
    else {
        ['#d83b3b','#e8a13a','#3fa96b','#3b6fd8','#8b4bd8'].forEach((col, i) => {
            g.fillStyle = col; g.fillRect(Math.floor(i * w / 5), 0, Math.ceil(w / 5), h); });
    }
    return c;
};
true;
`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (e) => win.webContents.executeJavaScript(e);
    await sleep(400);
    win.showInactive();
    await exec(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_) {}
        if (window.App && App.closeIntro) App.closeIntro(); return true; })()`);
    await sleep(900);
    await exec(HELPERS);

    const env = await exec(`(() => ({ usingGL: window.QfsColor.usingGL(),
        acrReady: !!(window.QfsAcr && window.QfsAcr.ready()),
        blackRatio: typeof window.qfsBlackRatio }))()`);
    console.log('ENV ' + JSON.stringify(env));
    check(env.blackRatio === 'function', 'qfsBlackRatio 已就绪', JSON.stringify(env));

    // 1) 基线：彩色输入经 QfsColor.pass 后绝不能是纯黑（GL 或 2D 通道都算）
    const base = await exec(`(async () => {
        const A = window.App;
        const p = Object.assign(A.defaultGrade(), { exp: 40, con: 21, vib: 36, sat: 16 });
        const c = window.__colorCanvas(1200, 800, false);
        const out = window.QfsColor.pass(c, p, 1200, 800, null, null, null);
        return { src: window.__px(c), out: window.__px(out),
            srcBlack: window.qfsBlackRatio(c), outBlack: window.qfsBlackRatio(out) };
    })()`);
    check(base.src.blackPct === 0 && base.srcBlack < 0.05, '输入是彩色且不黑', JSON.stringify(base.src));
    check(base.out && base.out.blackPct === 0,
        'QfsColor.pass 输出不黑（基线）', JSON.stringify(base.out));

    // 2) 黑图比例探针：彩色 0 / 纯黑 1
    const ratios = await exec(`(() => ({
        color: window.qfsBlackRatio(window.__colorCanvas(64, 64, false)),
        black: window.qfsBlackRatio(window.__colorCanvas(64, 64, true))
    }))()`);
    check(ratios.color < 0.05 && ratios.black > 0.95,
        'qfsBlackRatio 能区分彩色与纯黑', JSON.stringify(ratios));

    // 3) 带真实 3D LUT 的 GL 通道（ACR 表就绪时）
    const withLut = await exec(`(async () => {
        const A = window.App;
        const p = Object.assign(A.defaultGrade(), { exp: 40, con: 21, vib: 36, sat: 16 });
        const lut = (window.QfsAcr && window.QfsAcr.ready()) ? window.QfsAcr.colorLut(p, 25, 0) : null;
        const c = window.__colorCanvas(1200, 800, false);
        const out = window.QfsColor.pass(c, p, 1200, 800, lut, null, null);
        return { hasLut: !!(lut && lut.rgba && lut.grid > 1), out: window.__px(out) };
    })()`);
    check(withLut.out && withLut.out.blackPct === 0,
        '带 3D LUT 的调色输出不黑', JSON.stringify(withLut));

    // 4) 旋转会交换烘焙尺寸：6000×4000 → 4000×6000，不能因 glc 尺寸变化变黑
    const swapped = await exec(`(async () => {
        const A = window.App;
        const p = Object.assign(A.defaultGrade(), { exp: 40, con: 21, vib: 36, sat: 16 });
        const a = window.__colorCanvas(1600, 1200, false);
        const o1 = window.QfsColor.pass(a, p, 1600, 1200, null, null, null);
        const b = window.__colorCanvas(1200, 1600, false);
        const o2 = window.QfsColor.pass(b, p, 1200, 1600, null, null, null);
        return { first: window.__px(o1), swapped: window.__px(o2) };
    })()`);
    check(swapped.first.blackPct === 0 && swapped.swapped.blackPct === 0,
        '烘焙尺寸交换前后都不黑', JSON.stringify(swapped));

    // 5) GL 可用时：模拟 WebGL 上下文丢失后重建，LUT 必须重新上传、不能吐黑图
    if (env.usingGL) {
        const lost = await exec(`(async () => {
            const A = window.App;
            const p = Object.assign(A.defaultGrade(), { exp: 40, con: 21, vib: 36, sat: 16 });
            const c0 = window.__colorCanvas(800, 600, false);
            const first = window.QfsColor.pass(c0, p, 800, 600, null, null, null);
            let loseOK = false;
            try {
                const gl = first && first.getContext && first.getContext('webgl');
                const ext = gl && gl.getExtension('WEBGL_lose_context');
                if (ext) { ext.loseContext(); loseOK = true; }
            } catch (_) {}
            await new Promise(r => setTimeout(r, 120));
            const c1 = window.__colorCanvas(800, 600, false);
            const after = window.QfsColor.pass(c1, p, 800, 600, null, null, null);
            return { loseOK, first: window.__px(first), after: window.__px(after) };
        })()`);
        check(lost.after && lost.after.blackPct === 0,
            'WebGL 上下文丢失重建后仍不黑（lutKey 已作废）', JSON.stringify(lost));
    } else {
        console.log('SKIP  GL 分支：当前测试启动器禁用了 GPU，2D 基线已覆盖');
    }

    await win.destroy();
    app.quit();
    if (failures.length) { console.log(`✖ ${failures.length} 项未通过`); process.exit(1); }
    console.log('ALL PASS');
}
main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
