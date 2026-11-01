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
        const m3 = Q.sanitizeMask(Object.assign({}, m0, {
            shape: Object.assign({}, m0.shape, { rot: -30 })
        }));
        const m4 = Q.sanitizeMask(Object.assign({}, m0, {
            shape: Object.assign({}, m0.shape, { rot: 180 })
        }));
        const sig0 = Q.maskSignature(m0);
        const sig1 = Q.maskSignature(m1);
        return {
            defaultRot: m0.shape.rot,
            keptRot: m1.shape.rot,
            wrappedRot: m2.shape.rot,
            negRot: m3.shape.rot,
            maxRot: m4.shape.rot,
            sigChanged: sig0 !== sig1
        };
    })()`);
    check(sA.defaultRot === 0, '数据模型:新建椭圆默认方向 0°', 'rot=' + sA.defaultRot);
    check(sA.keptRot === 37, '数据模型:草稿/导入清洗保留方向', 'rot=' + sA.keptRot);
    check(sA.wrappedRot === 279, '数据模型:超范围角度按整圈归一(999°→279°)', 'rot=' + sA.wrappedRot);
    check(sA.negRot === 330, '数据模型:负角度归一(-30°→330°)', 'rot=' + sA.negRot);
    check(sA.maxRot === 180, '数据模型:180° 保留(直拖手柄时角度要存满一圈)', 'rot=' + sA.maxRot);
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

    // ── 场景 D：直接拖旋转手柄（PS 式操作） ──
    // 手柄在长轴端点外侧；拖它绕中心转。两条断言：
    //   1) 拖到中心正下方 → 长轴(x)指向下 → rot=90°
    //   2) 拖到基准空间 37° 方向 + Shift → 15° 吸附 → 30°
    // 同时确认旋转不会改动 cx/cy/rx/ry。
    const sD = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const m = A.activeMask(im);
        if (!m) return { error: 'no active mask' };
        m.shape.cx = 0.5; m.shape.cy = 0.5;
        m.shape.rx = 0.4; m.shape.ry = 0.2;
        m.shape.rot = 0;
        m.feather = 20;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 120));

        const ov = document.getElementById('maskOverlay');
        const base = A._baseSize();
        const pr = A._photoRect;
        if (!ov || !pr) return { error: 'overlay/photoRect not ready' };
        const r = ov.getBoundingClientRect();
        const toClient = (nx, ny) => ({
            x: r.left + (pr.x + nx * pr.w) / Math.max(1, base.w) * r.width,
            y: r.top + (pr.y + ny * pr.h) / Math.max(1, base.h) * r.height
        });
        const ev = (t, x, y, shift) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, shiftKey: !!shift
        }));
        const before = { rx: m.shape.rx, ry: m.shape.ry, cx: m.shape.cx, cy: m.shape.cy };
        const rh = A.maskRotHandle(m.shape);
        if (!rh) return { error: 'no rotate handle' };

        // 1) 拖到正下方
        const hp = toClient(rh.x, rh.y);
        const pDown = toClient(0.5, 0.8);
        ev('pointerdown', hp.x, hp.y);
        ev('pointermove', pDown.x, pDown.y);
        ev('pointerup', pDown.x, pDown.y);
        await new Promise((r2) => setTimeout(r2, 60));
        const afterDown = m.shape.rot;

        // 2) 拖到基准空间 37°，按住 Shift
        const rad = 37 * Math.PI / 180;
        const cxB = pr.x + m.shape.cx * pr.w, cyB = pr.y + m.shape.cy * pr.h;
        const dist = Math.min(pr.w, pr.h) * 0.3;
        const nx = (cxB + Math.cos(rad) * dist - pr.x) / pr.w;
        const ny = (cyB + Math.sin(rad) * dist - pr.y) / pr.h;
        const rh2 = A.maskRotHandle(m.shape);
        const hp2 = toClient(rh2.x, rh2.y);
        const tp = toClient(nx, ny);
        ev('pointerdown', hp2.x, hp2.y);
        ev('pointermove', tp.x, tp.y, true);
        ev('pointerup', tp.x, tp.y, true);
        await new Promise((r2) => setTimeout(r2, 60));
        const afterShift = m.shape.rot;

        const after = { rx: m.shape.rx, ry: m.shape.ry, cx: m.shape.cx, cy: m.shape.cy };
        return { before, after, afterDown, afterShift, handle: rh };
    })()`);
    check(!sD.error, '拖拽前置:旋转手柄位置可计算', JSON.stringify(sD.error || ''));
    check(Math.round(sD.afterDown) === 90,
        '直接拖旋转手柄:拖到正下方 → 方向 90°', 'rot=' + sD.afterDown);
    check(Math.round(sD.afterShift) === 30,
        '直接拖旋转手柄:Shift 按 15° 吸附(37°→30°)', 'rot=' + sD.afterShift);
    check(sD.after && sD.before
        && sD.after.rx === sD.before.rx && sD.after.ry === sD.before.ry
        && sD.after.cx === sD.before.cx && sD.after.cy === sD.before.cy,
        '旋转不改变椭圆位置/大小', JSON.stringify({ before: sD.before, after: sD.after }));

    // ── 场景 E：悬停在旋转手柄上要有反馈（光标 + 视觉高亮） ──
    // 高亮的实现是手柄外圈光晕（半径 12 CSS px，非悬停时圆点只有 6px）：
    // 在「手柄中心垂直方向 10px」取样，悬停前透明、悬停后应读到光晕的 alpha。
    const sE = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const m = A.activeMask(im);
        if (!m) return { error: 'no active mask' };
        m.shape.cx = 0.5; m.shape.cy = 0.5;
        m.shape.rx = 0.4; m.shape.ry = 0.2;
        m.shape.rot = 0;
        A._maskRotHover = false;
        A.syncMaskUI();
        A.drawMaskOverlay();
        await new Promise((r) => setTimeout(r, 80));

        const ov = document.getElementById('maskOverlay');
        const base = A._baseSize();
        const pr = A._photoRect;
        if (!ov || !pr) return { error: 'overlay/photoRect not ready' };
        const r = ov.getBoundingClientRect();
        const toClient = (nx, ny) => ({
            x: r.left + (pr.x + nx * pr.w) / Math.max(1, base.w) * r.width,
            y: r.top + (pr.y + ny * pr.h) / Math.max(1, base.h) * r.height
        });
        const ev = (t, x, y) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0
        }));
        const rh = A.maskRotHandle(m.shape);
        if (!rh) return { error: 'no rotate handle' };
        const hp = toClient(rh.x, rh.y);

        // 取样点：手柄中心向下 10 CSS px（避开长轴连接线；非悬停时圆点半径 6px）
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const k = ov.width / Math.max(1, base.w);
        const hxPx = Math.round((pr.x + rh.x * pr.w) * k);
        const hyPx = Math.round((pr.y + rh.y * pr.h) * k);
        const alphaAt10 = () => ov.getContext('2d')
            .getImageData(hxPx, Math.round(hyPx + 10 * dpr), 1, 1).data[3];

        const aBefore = alphaAt10();

        // 悬停到手柄
        ev('pointermove', hp.x, hp.y);
        const hoverOn = A._maskRotHover;
        const cursorOn = ov.style.cursor;
        const aHover = alphaAt10();

        // 移到空白处 → 高亮应撤销
        const far = toClient(0.15, 0.15);
        ev('pointermove', far.x, far.y);
        const hoverOff = A._maskRotHover;
        const aAfter = alphaAt10();

        return { aBefore, aHover, hoverOn, hoverOff, cursorOn, aAfter, handle: rh };
    })()`);
    check(!sE.error, '悬停前置:旋转手柄位置可计算', JSON.stringify(sE.error || ''));
    check(sE.hoverOn === true && sE.hoverOff === false,
        '悬停旋转手柄:状态位正确切换(进入=高亮 / 离开=撤销)',
        `on=${sE.hoverOn}, off=${sE.hoverOff}`);
    check(sE.cursorOn === 'grab',
        '悬停旋转手柄:光标变为 grab', 'cursor=' + sE.cursorOn);
    check(sE.aBefore < 10 && sE.aHover > 30,
        '悬停旋转手柄:外圈光晕真的画出来了(取样 alpha 由透明变绿)',
        `before=${sE.aBefore}, hover=${sE.aHover}`);
    check(sE.aAfter < 10,
        '移出旋转手柄:高亮撤销(取样点恢复透明)', 'after=' + sE.aAfter);

    // ── 场景 F：四个轴向手柄分别改长轴/短轴 ──
    // 以前拖椭圆边缘是「等比缩放」，长轴短轴一起变，调不出更扁/更长的形状。
    // 现在两条轴的四个端点各有一个方块手柄，拖它只改这一根轴。
    const sF = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        const m = A.activeMask(im);
        if (!m) return { error: 'no active mask' };
        m.shape.cx = 0.5; m.shape.cy = 0.5;
        m.shape.rx = 0.3; m.shape.ry = 0.2;
        m.shape.rot = 0;
        A.syncMaskUI();
        await new Promise((r) => setTimeout(r, 120));

        const ov = document.getElementById('maskOverlay');
        const base = A._baseSize();
        const pr = A._photoRect;
        if (!ov || !pr) return { error: 'overlay/photoRect not ready' };
        const r = ov.getBoundingClientRect();
        const toClient = (nx, ny) => ({
            x: r.left + (pr.x + nx * pr.w) / Math.max(1, base.w) * r.width,
            y: r.top + (pr.y + ny * pr.h) / Math.max(1, base.h) * r.height
        });
        const ev = (t, p) => ov.dispatchEvent(new PointerEvent(t, {
            clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1, button: 0
        }));

        const handles = A.maskAxisHandles(m.shape);
        const before = { rx: m.shape.rx, ry: m.shape.ry };

        // 1) 拖 +X 端点往外：只改长轴
        const hx = handles.find((h) => h.axis === 'x' && h.x > 0.5);
        if (!hx) return { error: 'no +X handle' };
        ev('pointerdown', toClient(hx.x, hx.y));
        ev('pointermove', toClient(0.95, 0.5));
        ev('pointerup', toClient(0.95, 0.5));
        await new Promise((r2) => setTimeout(r2, 80));
        const afterX = { rx: m.shape.rx, ry: m.shape.ry };

        // 2) 拖 +Y 端点往外：只改短轴
        const hy = A.maskAxisHandles(m.shape).find((h) => h.axis === 'y' && h.y > 0.5);
        if (!hy) return { error: 'no +Y handle' };
        ev('pointerdown', toClient(hy.x, hy.y));
        ev('pointermove', toClient(0.5, 0.95));
        ev('pointerup', toClient(0.5, 0.95));
        await new Promise((r2) => setTimeout(r2, 80));
        const afterY = { rx: m.shape.rx, ry: m.shape.ry };

        return { before, afterX, afterY, count: handles.length, cursorX: null };
    })()`);
    check(!sF.error, '轴向手柄前置:四个手柄位置可计算', JSON.stringify(sF.error || ''));
    check(sF.count === 4, '椭圆有四个轴向手柄（两轴的 ± 端点）', 'count=' + sF.count);
    check(sF.afterX && sF.before
        && sF.afterX.rx > sF.before.rx + 0.05
        && Math.abs(sF.afterX.ry - sF.before.ry) < 0.005,
        '拖左右端点只改长轴，短轴纹丝不动',
        JSON.stringify({ before: sF.before, afterX: sF.afterX }));
    check(sF.afterY && sF.afterX
        && sF.afterY.ry > sF.afterX.ry + 0.05
        && Math.abs(sF.afterY.rx - sF.afterX.rx) < 0.005,
        '拖上下端点只改短轴，长轴纹丝不动',
        JSON.stringify({ afterX: sF.afterX, afterY: sF.afterY }));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
