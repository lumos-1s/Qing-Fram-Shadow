// 椭圆蒙版「方向」回归：shape.rot(0~180°)
// 覆盖三条独立路径，任一漏改都会让「方向」看起来不生效或只生效一半：
//   1) 数据模型：newMask 默认 rot=0、sanitizeMask 保留并夹取、maskSignature 随 rot 变化
//      （签名不含 rot 时缓存不会失效，画面仍按旧朝向合成）
//   2) 蒙版权重烘焙 fillRadial：正向 + 反相两条分支都要绕中心旋转
//   3) 叠加层 drawMaskOverlay：椭圆裁剪、渐变、手柄都要用同一个角
// 取样思路：rx=0.4 / ry=0.2 的宽椭圆，在「横向长轴」上取一点，
// rot=0 时在椭圆内、rot=90 时滚到短轴外 —— 两个朝向的 alpha 必须明显不同。
// 用法：node tools/run-electron.js tools/test-mask-radial-rotation.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
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
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
    await app.whenReady();
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

    await exec(`(async () => { if (window.QfsAcr) await QfsAcr.ensure(); return QfsAcr && QfsAcr.ready(); })()`)
        .then((r) => console.log('ACR tables ready=' + r));
    // 同步合成补丁：隐藏窗口 rAF 会被节流，采样会落在同一帧
    await exec(`(() => {
        const A = window.App;
        if (!A || A.__syncRenderPatched) return true;
        A.__syncRenderPatched = true;
        const orig = A.scheduleRender.bind(A);
        let busy = false;
        A.scheduleRender = function (immediate) {
            orig(immediate);
            if (busy) return;
            busy = true;
            try { A._renderDirty = true; if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue(); }
            finally { busy = false; }
        };
        return true;
    })()`);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    // ── 场景 A：数据模型（默认值 / 清洗 / 缓存签名） ──
    const sA = await exec(`(() => {
        const Q = window.QfsMask;
        const m0 = Q.newMask('radial');
        const m1 = Q.sanitizeMask(Object.assign({}, m0, {
            shape: Object.assign({}, m0.shape, { rot: 37 })
        }));
        const m2 = Q.sanitizeMask(Object.assign({}, m0, {
            shape: Object.assign({}, m0.shape, { rot: 999 })
        }));
        const sig0 = Q.maskSignature(m0);
        const sig1 = Q.maskSignature(m1);
        return {
            defaultRot: m0.shape.rot,
            keptRot: m1.shape.rot,
            clampedRot: m2.shape.rot,
            sigChanged: sig0 !== sig1
        };
    })()`);
    check(sA.defaultRot === 0, '数据模型:新建椭圆默认方向 0°', 'rot=' + sA.defaultRot);
    check(sA.keptRot === 37, '数据模型:草稿/导入清洗保留方向', 'rot=' + sA.keptRot);
    check(sA.clampedRot === 180, '数据模型:方向夹取到 0~180', 'rot=' + sA.clampedRot);
    check(sA.sigChanged, '数据模型:maskSignature 随方向变化(否则缓存不失效，画面按旧朝向)',
        'sigChanged=' + sA.sigChanged);

    // ── 场景 B：蒙版权重烘焙（正向 + 反相） ──
    const sB = await exec(`(() => {
        const Q = window.QfsMask;
        const W = 400, H = 400;
        const sample = (rot, inv, nx, ny) => {
            const m = Q.newMask('radial');
            m.shape.cx = 0.5; m.shape.cy = 0.5;
            m.shape.rx = 0.4; m.shape.ry = 0.2;
            m.shape.rot = rot;
            m.feather = 0; m.density = 100; m.inv = inv; m.on = 1;
            const c = Q.render(m, W, H, null, { rawAlpha: true });
            const d = c.getContext('2d').getImageData(Math.round(nx * W), Math.round(ny * H), 1, 1).data;
            return d[3];
        };
        // (0.85,0.5)：rot=0 时在长轴内(rr=0.875)，rot=90 时落到短轴外(rr=1.75)
        return {
            n0: sample(0, 0, 0.85, 0.5),
            n90: sample(90, 0, 0.85, 0.5),
            n180: sample(180, 0, 0.85, 0.5),
            i0: sample(0, 1, 0.85, 0.5),
            i90: sample(90, 1, 0.85, 0.5)
        };
    })()`);
    check(sB.n0 > 200 && sB.n90 < 20,
        '蒙版烘焙:正向椭圆按方向旋转(横向取样 0°在内 / 90°在外)',
        `rot0 a=${sB.n0}, rot90 a=${sB.n90}`);
    check(sB.n180 > 200, '蒙版烘焙:180° 与 0° 等价(椭圆中心对称)', 'a=' + sB.n180);
    check(sB.i0 < 20 && sB.i90 > 200,
        '蒙版烘焙:反相椭圆同样按方向旋转(0°挖空 / 90°保留)',
        `rot0 a=${sB.i0}, rot90 a=${sB.i90}`);

    // ── 场景 C：叠加层绘制（用户实际看到的椭圆/范围） ──
    const sC = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(1200, 800);
        const im = { el, name: 'r1', path: null, w: 1200, h: 800, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.setGrade({ exp: 0, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.addMask('radial');
        const m = A.activeMask(im);
        if (!m) return { error: 'no radial mask' };
        A.setActiveMask(m.id);
        m.shape.cx = 0.5; m.shape.cy = 0.5;
        m.shape.rx = 0.4; m.shape.ry = 0.2;
        m.feather = 20;
        A.commitMaskShape('full');
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 120));

        const ov = document.getElementById('maskOverlay');
        const base = A._baseSize();
        const pr = A._photoRect;
        if (!ov || !pr) return { error: 'overlay/photoRect not ready', hasOv: !!ov, hasPr: !!pr };
        const k = ov.width / Math.max(1, base.w);
        const sx = pr.x * k, sy = pr.y * k, sw = pr.w * k, sh = pr.h * k;
        // 取椭圆中心右上一点：0.28 长轴 + 0.06 短轴，落在渐变满权重内，
        // 同时避开长轴指示线与虚线轮廓(轮廓在 rx=0.4)
        const px = Math.round(sx + (0.5 + 0.28) * sw);
        const py = Math.round(sy + (0.5 + 0.06) * sh);
        const alphaAt = (rot) => {
            m.shape.rot = rot;
            A.drawMaskOverlay();
            return ov.getContext('2d').getImageData(px, py, 1, 1).data[3];
        };
        const a0 = alphaAt(0);
        const a90 = alphaAt(90);
        return { a0, a90, type: m.type, rot: m.shape.rot };
    })()`);
    check(!sC.error, '叠加层前置:椭圆蒙版与照片矩形就绪', JSON.stringify(sC));
    check(sC.a0 > 60 && sC.a90 < 20,
        '叠加层:椭圆范围按方向旋转(取样点 0° 有绿色范围 / 90° 无)',
        `rot0 a=${sC.a0}, rot90 a=${sC.a90}`);

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
