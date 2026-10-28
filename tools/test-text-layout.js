// 文字排版回归：字距 / 竖排 / 侧排 / 命中 / 解锁。
// 用法:
//   node tools/test-text-layout.js
//
// 覆盖:
//  ① 字距生效：同一行 ls=0 与 ls=N 的宽度差 ≈ 字数 × N
//  ② 竖排：框高 = 字数 × 格高、框宽约一个字号；底对齐时末字贴底
//  ③ 侧排：rot = -90°，外框宽高互换（AABB 能包住横排的框）
//  ④ 真的画出来了：离屏画布的墨迹外框，竖排是「窄而高」、横排是「宽而扁」
//  ⑤ 命中：竖排/侧排点中心命中；离得远不命中；DPR≠1 时用画布像素坐标也命中
//  ⑥ 解锁：promoteTextToFree 后 align=free、画面中心位移 < 1px；解锁后坐标能真的移动
//  ⑦ 面板：位置框显示锚定文字的真实中心（而不是 0,0）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'renderer', 'index.html');
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-textlayout-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (_) { /* 忽略 */ } });

ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets'))
    .filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'write-export-files',
    'pick-export-location', 'open-wall-covers-dir']) {
    ipcMain.handle(c, () => (c.startsWith('open') || c.startsWith('pick') ? { canceled: true } : { ok: true }));
}

const SCENARIO = `
(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = [];
    const add = (ok, label, got) => out.push({ ok: !!ok, label, got: String(got) });
    const M = window.textLineMetrics;

    // 画布渲染需要「有照片」的状态（否则 updateEmptyState 把画布 display:none）
    if (!A.images || !A.images.length) {
        const c0 = document.createElement('canvas'); c0.width = 800; c0.height = 1000;
        const g0 = c0.getContext('2d');
        g0.fillStyle = '#40382f'; g0.fillRect(0, 0, 800, 1000);
        g0.fillStyle = '#a08a6a'; g0.fillRect(0, 0, 800, 400);
        const im0 = new Image();
        await new Promise((r) => { im0.onload = r; im0.onerror = r; im0.src = c0.toDataURL('image/jpeg', 0.9); });
        A.image = { el: im0, name: 't.jpg', w: 800, h: 1000, exif: {} };
        A.images = [A.image];
        A.selectedIdx = [0]; A.currentIdx = 0;
        if (typeof A.updateEmptyState === 'function') A.updateEmptyState();
        if (typeof A.scheduleRender === 'function') A.scheduleRender(true);
        await sleep(500);
    }
    if (!M) return [{ ok: false, label: '引擎导出 textLineMetrics', got: 'missing' }];

    const cv = A.dom.canvas;
    const CW = (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 900);
    const CH = (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 1200);

    // ── ① 字距 ──
    const base = { text: 'FILM ARCHIVE', align: 'free', x: CW / 2, y: CH / 2, fontSize: 40,
                   fontFamily: 'Microsoft YaHei', colorHex: '#ffffff', opacity: 100 };
    const m0 = M(Object.assign({}, base, { letterSpacing: 0 }), CW, CH);
    const m1 = M(Object.assign({}, base, { letterSpacing: 12 }), CW, CH);
    const expectGrow = base.text.length * 12;
    const grew = m1.lw - m0.lw;
    add(Math.abs(grew - expectGrow) <= 2, '① 字距生效（宽度按 字数×字距 增长）',
        m0.lw.toFixed(1) + ' → ' + m1.lw.toFixed(1) + ' 增长 ' + grew.toFixed(1) + ' 期望 ' + expectGrow);

    // ── ② 竖排 ──
    const vLine = { text: '秋日黄昏', align: 'bottom', fontSize: 40, fontFamily: 'Microsoft YaHei',
                    colorHex: '#ffffff', opacity: 100, direction: 'v', letterSpacing: 0 };
    const mv = M(vLine, CW, CH);
    const step = mv.step;
    add(Math.abs(mv.lh - vLine.text.length * step) <= 1.5, '② 竖排：框高 = 字数 × 格高',
        'lh=' + mv.lh.toFixed(1) + ' 期望 ' + (vLine.text.length * step).toFixed(1));
    add(mv.lw <= 40 * 1.3 && mv.lh > 40 * 3, '② 竖排：窄而高（一列字）',
        Math.round(mv.lw) + '×' + Math.round(mv.lh));
    // 底对齐：框底应落在锚点附近（ch - fs - 10 + 0.2fs）
    const vBottom = mv.cy + mv.lh / 2;
    const anchorB = CH - 40 - 10;
    add(Math.abs(vBottom - (anchorB + 40 * 0.2)) <= 1.5, '② 竖排底对齐：末字贴着底边锚点',
        '框底=' + vBottom.toFixed(1) + ' 期望 ' + (anchorB + 40 * 0.2).toFixed(1));

    // ── ③ 侧排 ──
    const sLine = Object.assign({}, base, { direction: 'side' });
    const ms = M(sLine, CW, CH);
    add(ms.rot === -90, '③ 侧排：rot = -90°', ms.rot);
    const mh = M(base, CW, CH);
    add(Math.abs(ms.w - mh.lh) <= 1.5 && Math.abs(ms.h - mh.lw) <= 1.5, '③ 侧排：外框宽高互换',
        Math.round(ms.w) + '×' + Math.round(ms.h) + ' 期望 ' + Math.round(mh.lh) + '×' + Math.round(mh.lw));

    // ── ④ 真的画出来了（离屏墨迹外框） ──
    const inkBox = (line, w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
        window.drawTextLine(g, line, w, h, false, 0, 0);
        const d = g.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) {
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
        }
        return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const bh = inkBox(Object.assign({}, base, { x: 200, y: 200, fontSize: 36, letterSpacing: 0 }), 400, 400);
    const bv = inkBox(Object.assign({}, vLine, { align: 'free', x: 200, y: 200, fontSize: 36, letterSpacing: 0 }), 400, 400);
    add(!!bh && bh.w > bh.h * 2, '④ 横排墨迹：宽 > 高×2', bh ? bh.w + '×' + bh.h : 'null');
    add(!!bv && bv.h > bv.w * 2, '④ 竖排墨迹：高 > 宽×2', bv ? bv.w + '×' + bv.h : 'null');

    // ── ⑤ 命中 ──
    const decor = (A.template && A.template.decorConfig) || (A.template.decorConfig = {});
    const savedLines = decor.textLines;
    decor.textLines = [Object.assign({}, vLine, { align: 'free', x: CW / 2, y: CH / 2 })];
    const k = (typeof A.textSpaceScale === 'function') ? A.textSpaceScale() : 1;
    const mCenter = M(decor.textLines[0], CW, CH);
    const hitCenter = A.hitTestTexts({ x: mCenter.cx * k, y: mCenter.cy * k });
    const hitFar = A.hitTestTexts({ x: (mCenter.cx + mCenter.lw * 3 + 60) * k, y: mCenter.cy * k });
    add(!!hitCenter && hitCenter.obj === decor.textLines[0], '⑤ 竖排：点中心能命中（DPR=' + k.toFixed(2) + '）',
        hitCenter ? hitCenter.kind : 'null');
    add(hitFar === null, '⑤ 竖排：点旁边不命中', hitFar === null ? 'null' : 'hit');

    decor.textLines = [Object.assign({}, sLine, { align: 'free', x: CW / 2, y: CH / 2 })];
    const mSide = M(decor.textLines[0], CW, CH);
    const hitSide = A.hitTestTexts({ x: mSide.cx * k, y: mSide.cy * k });
    add(!!hitSide, '⑤ 侧排：点中心能命中', hitSide ? hitSide.kind : 'null');

    // ── ⑥ 解锁 ──
    decor.textLines = [Object.assign({}, vLine, { align: 'bottom' })];
    const el = decor.textLines[0];
    const before = M(el, CW, CH);
    const promoted = A.promoteTextToFree(el);
    const after = M(el, CW, CH);
    add(promoted && el.align === 'free', '⑥ 解锁：align 变为 free', el.align);
    add(Math.abs(after.cx - before.cx) <= 1 && Math.abs(after.cy - before.cy) <= 1,
        '⑥ 解锁：画面不跳（中心位移 ≤ 1px）',
        'dx=' + (after.cx - before.cx).toFixed(2) + ' dy=' + (after.cy - before.cy).toFixed(2));
    // 解锁后写坐标应真的改变几何
    A.setElementCenter({ kind: 'text', obj: el }, el.x + 60, el.y - 40);
    const moved = M(el, CW, CH);
    add(Math.abs((moved.cx - after.cx) - 60) <= 1 && Math.abs((moved.cy - after.cy) + 40) <= 1,
        '⑥ 解锁后坐标生效（+60, -40）',
        'dx=' + (moved.cx - after.cx).toFixed(1) + ' dy=' + (moved.cy - after.cy).toFixed(1));

    // ── ⑦ 面板回显 ──
    decor.textLines = [Object.assign({}, vLine, { align: 'bottom' })];
    A.selectedEls = [{ kind: 'text', obj: decor.textLines[0] }];
    A.refreshElList();
    const inpX = document.getElementById('inpElX'), inpY = document.getElementById('inpElY');
    const shownX = inpX ? Number(inpX.value) : -1;
    add(shownX > 1, '⑦ 位置框回显锚定文字的真实中心', 'x=' + shownX + ' y=' + (inpY ? inpY.value : '?'));

    // ── ⑧–⑪ 文字工具：新建 / 鼠标旋转 / 双击改字 / 字体颜色字号 ──
    const lastModal = () => [...document.querySelectorAll('.modal-overlay')].pop();
    const fillModal = (val) => {
        const ov = lastModal();
        if (!ov) return null;
        const inp = ov.querySelector('input');
        if (!inp) return null;
        if (val != null) inp.value = val;
        const ok = [...ov.querySelectorAll('button')].find(b => b.textContent === '确定');
        if (!ok) return null;
        ok.click();
        return true;
    };
    const toClient = (lx, ly) => {
        const cv2 = A.dom.canvas, r2 = cv2.getBoundingClientRect();
        return { x: r2.left + (lx * k) / cv2.width * r2.width, y: r2.top + (ly * k) / cv2.height * r2.height };
    };

    const beforeCount = (decor.textLines || []).length;
    A.addFreeText();                       // 故意不 await：它要等弹窗
    await sleep(320);
    const modalOk = fillModal('测试新建');
    await sleep(420);
    const linesNow = decor.textLines || [];
    const newLine = linesNow[linesNow.length - 1];
    add(!!modalOk && linesNow.length === beforeCount + 1 && newLine && newLine.align === 'free' && newLine.text === '测试新建',
        '⑧ 添加文字：新建一条自由文字并选中',
        'modal=' + !!modalOk + ' 条数 ' + beforeCount + '→' + linesNow.length + ' text=' + (newLine && newLine.text));
    add(!!(newLine && A.selectedEls.some(x => x.obj === newLine)), '⑧ 新建后自动选中（面板才会跟着变）',
        '选中 ' + A.selectedEls.length);
    const rowFont = document.getElementById('rowElTextFont');
    const rowScale = document.getElementById('rowElSize');
    add(rowFont && getComputedStyle(rowFont).display !== 'none' && rowScale && getComputedStyle(rowScale).display === 'none',
        '⑧ 选中文字时露出字体/字号行、收起缩放行',
        'font=' + (rowFont ? getComputedStyle(rowFont).display : '?') + ' scale=' + (rowScale ? getComputedStyle(rowScale).display : '?'));

    A.selectedEls = [{ kind: 'text', obj: newLine }];
    A.scheduleRender(true);
    await sleep(520);
    const hd = A._rotHandle;
    add(!!hd, '⑨ 选中文字后出现旋转把手', hd ? Math.round(hd.x) + ',' + Math.round(hd.y) : 'null');
    if (hd) {
        const m0 = M(newLine, CW, CH);
        const spinning = A.beginRotate({ x: hd.x, y: hd.y });
        add(!!spinning, '⑨ 把手可被命中（先于元素命中判断）', spinning ? 'ok' : 'null');
        // 从正上方拖到正右方 = +90°
        A.applyRotate({ x: (m0.cx + 160) * k, y: m0.cy * k }, false);
        const rot1 = newLine.rotation;
        A.applyRotate({ x: (m0.cx + 160) * k + 2, y: m0.cy * k }, true);   // Shift 吸附
        const rotSnap = newLine.rotation;
        A._rotEl = null;
        add(Math.abs(rot1 - 90) <= 3, '⑨ 鼠标旋转：拖到正右 ≈ 90°', rot1 + '°');
        add(rotSnap % 15 === 0, '⑨ Shift 吸附到 15° 整数倍', rotSnap + '°');
    }

    // 双击画布上的文字 → 弹窗（预填当前内容）→ 改完生效
    const mDouble = M(newLine, CW, CH);
    const pc = toClient(mDouble.cx, mDouble.cy);
    A.dom.canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: pc.x, clientY: pc.y, bubbles: true, button: 0 }));
    await sleep(320);
    const ovD = lastModal();
    const prefill = ovD && ovD.querySelector('input') ? ovD.querySelector('input').value : null;
    const dblOk = fillModal('双击改字');
    await sleep(400);
    add(!!dblOk && newLine.text === '双击改字', '⑩ 双击画布文字 → 改内容生效',
        '预填=' + prefill + ' 之后=' + newLine.text);

    // 字体 / 颜色 / 字号
    const cbF = document.getElementById('cbElTextFont');
    const cpC = document.getElementById('cpElTextColor');
    const slS = document.getElementById('slElTextSize');
    if (cbF && cbF.options.length > 3) { cbF.value = cbF.options[3].value; cbF.dispatchEvent(new Event('change')); }
    if (cpC) { cpC.value = '#ffcc00'; cpC.dispatchEvent(new Event('input')); cpC.dispatchEvent(new Event('change')); }
    if (slS) { slS.value = 88; slS.dispatchEvent(new Event('input')); slS.dispatchEvent(new Event('change')); }
    await sleep(400);
    const mStyled = M(newLine, CW, CH);
    add(!!cbF && newLine.fontFamily === cbF.options[3].value && newLine.colorHex === '#ffcc00' && newLine.fontSize === 88,
        '⑪ 字体/颜色/字号都写进元素',
        newLine.fontFamily + ' / ' + newLine.colorHex + ' / ' + newLine.fontSize + 'px');
    add(Math.abs(mStyled.lh - 88 * 1.18) <= 2, '⑪ 字号 88 立刻反映到几何框',
        'h=' + mStyled.lh.toFixed(1) + ' 期望 ' + (88 * 1.18).toFixed(1));

    decor.textLines = savedLines;
    return out;
})()
`;

function run() {
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, backgroundColor: '#181B1A',
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, sandbox: true },
    });
    win.webContents.on('console-message', (_e, level, msg) => {
        if (level >= 2 && /error/i.test(String(msg))) console.log('  [page] ' + String(msg).slice(0, 200));
    });
    win.loadFile(PAGE).then(async () => {
        let rows = [];
        try {
            rows = await win.webContents.executeJavaScript('(async () => {'
                + 'for (let i = 0; i < 120; i++) { if (window.App && document.getElementById("splash") === null) break; await new Promise(r => setTimeout(r, 100)); }'
                + 'return true; })()');
        } catch (_) { rows = []; }
        try {
            rows = await win.webContents.executeJavaScript(SCENARIO);
        } catch (e) {
            rows = [{ ok: false, label: '用例执行', got: (e && e.message) || String(e) }];
        }
        let fails = 0;
        (rows || []).forEach((r) => {
            console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.label);
            console.log('        ' + r.got);
            if (!r.ok) fails++;
        });
        const total = (rows || []).length;
        console.log(fails ? '✖ ' + fails + '/' + total + ' 项未通过' : '✓ 全部 ' + total + ' 项通过');
        app.exit(fails ? 1 : 0);
    }).catch((e) => {
        console.error('FAIL 加载页面: ' + ((e && e.message) || e));
        app.exit(1);
    });
}

app.whenReady().then(run);
