// 文字排版回归：字距 / 竖排 / 侧排 / 命中 / 解锁 / 画布内文字工具。
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
//  ⑧–⑫ 文字工具：双击放置 / 画布内多行编辑 / 双击改字 / 大图居中
//  ⑮–⑰ 字重 / 描边 / 阴影 / 四角等比缩放
//  ⑱ 编辑中画布不重复画字、选中框和把手收起（只剩 textarea 一层；含相框风格通道）
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
        if (!A.template) A.template = A.defaultTemplate();
        A.setTpl(A.image, A.template);
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
        let x0 = w, y0 = h, x1 = -1, y1 = -1, red = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) {
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
                if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++;
            }
        }
        return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1, x0, y0, x1, y1, red };
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

    // ── ⑧–⑪ 文字工具：双击放置 / 画布内编辑 / 鼠标旋转 / 双击改字 / 字体颜色字号 ──
    const editor = () => document.querySelector('.canvas-text-editor');
    const setEditor = (val) => {
        const ta = editor();
        if (!ta) return false;
        ta.value = val;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    };
    const toClient = (lx, ly) => {
        const cv2 = A.dom.canvas, r2 = cv2.getBoundingClientRect();
        return { x: r2.left + (lx * k) / cv2.width * r2.width, y: r2.top + (ly * k) / cv2.height * r2.height };
    };

    decor.textLines = [];
    A.selectedEls = [];
    A.refreshElList();
    const clickLx = Math.round(CW * 0.32), clickLy = Math.round(CH * 0.36);
    const canvasAddBtn = document.getElementById('btnAddTextCanvas');
    const addBtn = document.getElementById('btnAddFreeText');
    add(!canvasAddBtn, '⑧ 画布左上角不再有「添加文字」按钮（只保留右侧栏入口）',
        canvasAddBtn ? '仍存在' : '已移除');
    if (addBtn) addBtn.click();
    const placeMode = A._textPlaceMode === true;
    const btnActive = !!addBtn && addBtn.classList.contains('active') && addBtn.getAttribute('aria-pressed') === 'true';
    const pc0 = toClient(clickLx, clickLy);
    A.dom.canvas.dispatchEvent(new MouseEvent('mousedown', {
        clientX: pc0.x, clientY: pc0.y, button: 0, bubbles: true,
    }));
    await sleep(80);
    const singleNoop = decor.textLines.length === 0 && !editor();
    add(placeMode && !!addBtn && btnActive && singleNoop,
        '⑧ 右侧「添加文字」进入添加模式；单击画布不落字',
        'place=' + placeMode + ' active=' + btnActive + ' 条数=' + decor.textLines.length);
    A.dom.canvas.dispatchEvent(new MouseEvent('dblclick', {
        clientX: pc0.x, clientY: pc0.y, button: 0, bubbles: true,
    }));
    await sleep(150);
    const newLine = decor.textLines[0];
    const ta0 = editor();
    add(placeMode && !!addBtn && btnActive && !!newLine && !A._textPlaceMode
        && addBtn.getAttribute('aria-pressed') === 'false',
        '⑧ 添加模式下双击画布才建一条文字，并退出添加模式',
        'place=' + placeMode + ' active=' + btnActive + ' 条数=' + decor.textLines.length);
    add(!!newLine && Math.abs(newLine.x - clickLx) <= 2 && Math.abs(newLine.y - clickLy) <= 2,
        '⑧ 双击哪放哪：新建文字的锚点就是双击位置（不是画布中心）',
        newLine ? 'el=' + newLine.x + ',' + newLine.y + ' 双击=' + clickLx + ',' + clickLy : 'null');
    add(!!ta0 && document.activeElement === ta0, '⑧ 新建后立刻出现画布内编辑器（不弹窗）',
        ta0 ? 'textarea 已聚焦' : 'null');
    setEditor('测试新建\\n第二行');
    await sleep(80);
    // 编辑中画布上不应该再画同一段文字：textarea 已经显示字形，画布再画一层
    // 会因字体度量/缩放取整差 1px 出现重影。顺带确认选中框/把手也收起，
    // 不然 textarea 边框 + 画布选中框就是两层虚线。
    A.scheduleRender(true);
    await sleep(450);
    const mNew = M(newLine, CW, CH);
    const whitePixels = (m) => {
        const g = cv.getContext('2d');
        const x0 = Math.max(0, Math.floor((m.cx - m.lw / 2 - 8) * k));
        const y0 = Math.max(0, Math.floor((m.cy - m.lh / 2 - 8) * k));
        const x1 = Math.min(cv.width, Math.ceil((m.cx + m.lw / 2 + 8) * k));
        const y1 = Math.min(cv.height, Math.ceil((m.cy + m.lh / 2 + 8) * k));
        const d = g.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235 && d[i + 3] > 200) n++;
        }
        return n;
    };
    const whiteEditing = whitePixels(mNew);
    const handlesHidden = A._rotHandle === null && !A._resizeHandles;
    A.commitTextEditor();
    await sleep(200);
    const whiteCommitted = whitePixels(M(newLine, CW, CH));
    add(whiteEditing <= 5 && whiteCommitted > 100,
        '⑱ 编辑中画布不重复画字（输入层与画布不重影）',
        '编辑中白像素=' + whiteEditing + ' 提交后=' + whiteCommitted);
    add(handlesHidden, '⑱ 编辑中收起选中框/旋转把手（只留 textarea 一层边框）',
        handlesHidden ? '已收起' : '仍有把手');

    // 相框风格预设（photoFrameStyle）走的是 engine-styles → drawUserElements，
    // 不是 drawDecoration。上一版只在后者跳过编辑中的文字，用户用相框预设时仍然重影。
    // 这里直接盯住那条通道：编辑中同一段文字必须一个字都不画。
    {
        const gl = { text: '相框通道', align: 'free', x: 300, y: 150, fontSize: 60,
                     fontFamily: 'Microsoft YaHei', colorHex: '#ffffff', opacity: 100 };
        const gt = { decorConfig: { textLines: [gl] }, logoElements: [] };
        const gc = document.createElement('canvas'); gc.width = 600; gc.height = 300;
        const gg = gc.getContext('2d');
        const countWhite = () => {
            const d = gg.getImageData(0, 0, gc.width, gc.height).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235 && d[i + 3] > 200) n++;
            }
            return n;
        };
        const paint = () => { gg.fillStyle = '#000'; gg.fillRect(0, 0, gc.width, gc.height); window.drawUserElements(gg, gt, gc.width, gc.height); };
        paint();
        const styleNormal = countWhite();
        A._textEditor = { el: gl };
        paint();
        const styleEditing = countWhite();
        A._textEditor = null;
        add(styleNormal > 100 && styleEditing <= 5,
            '⑱ 相框风格通道也跳过编辑中的文字（预设下不再重影）',
            '正常=' + styleNormal + ' 编辑中=' + styleEditing);
    }
    await sleep(80);
    add(!!newLine && newLine.text === '测试新建\\n第二行', '⑧ 画布内输入多行文字并提交',
        newLine ? JSON.stringify(newLine.text) : 'null');
    add(!!newLine && A.selectedEls.some(x => x.obj === newLine), '⑧ 新建后自动选中（面板才会跟着变）',
        '选中 ' + A.selectedEls.length);
    const rowFont = document.getElementById('rowElTextFont');
    const rowScale = document.getElementById('rowElSize');
    add(rowFont && getComputedStyle(rowFont).display !== 'none' && rowScale && getComputedStyle(rowScale).display === 'none',
        '⑧ 选中文字时露出字体/字号行、收起缩放行',
        'font=' + (rowFont ? getComputedStyle(rowFont).display : '?') + ' scale=' + (rowScale ? getComputedStyle(rowScale).display : '?'));
    // 用户要求：文字设置从 Logo → 元素管理搬进「文字」页签，Logo 里只留位置/旋转/层级。
    // 用 DOM 归属做硬断言，避免以后又搬回去。
    const textPanelHasRows = !!document.querySelector('#panel-text #rowElTextFont')
        && !!document.querySelector('#panel-text #rowElTextContent')
        && !!document.querySelector('#panel-text #rowElTextShadow');
    const logoPanelHasRows = !!document.querySelector('#panel-logo #rowElTextFont')
        || !!document.querySelector('#panel-logo #rowElTextContent');
    const addBtnInText = !!document.querySelector('#panel-text #btnAddFreeText');
    add(textPanelHasRows && !logoPanelHasRows && addBtnInText,
        '⑧ 文字样式/添加入口都在「文字」页签（Logo 不再堆文字设置）',
        'text=' + textPanelHasRows + ' logo=' + logoPanelHasRows + ' add=' + addBtnInText);
    const styleStatus = document.getElementById('txtStyleStatus');
    add(!!styleStatus && /正在调整/.test(styleStatus.textContent),
        '⑧ 选中文字时「文字」页签顶部状态跟随',
        styleStatus ? styleStatus.textContent : 'null');

    A.selectedEls = [{ kind: 'text', obj: newLine }];
    A.scheduleRender(true);
    await sleep(520);
    const hd = A._rotHandle;
    add(!!hd, '⑨ 选中文字后出现旋转把手', hd ? Math.round(hd.x) + ',' + Math.round(hd.y) : 'null');
    if (hd) {
        // 悬停反馈：画布默认光标就是 grab，旋转热区必须给出更明确的光标 + 提示气泡。
        const hc = toClient(hd.x / k, hd.y / k);
        A.dom.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: hc.x, clientY: hc.y, bubbles: true }));
        await sleep(40);
        const rotHint = document.getElementById('rotHint');
        const hasRotCursor = String(getComputedStyle(A.dom.canvas).cursor).indexOf('data:image/svg+xml') >= 0;
        add(hasRotCursor && !!rotHint && !rotHint.hidden && /旋转/.test(rotHint.textContent),
            '⑨ 悬停旋转把手：显示旋转光标 + 拖动提示',
            '光标=' + (hasRotCursor ? '旋转图标' : '未变') + ' 提示=' + (rotHint && !rotHint.hidden ? '显示' : '隐藏'));
        A.dom.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: hc.x - 220, clientY: hc.y + 220, bubbles: true }));
        await sleep(40);
        add(!!rotHint && rotHint.hidden && String(getComputedStyle(A.dom.canvas).cursor).indexOf('data:image/svg+xml') < 0,
            '⑨ 移出旋转把手：提示和专用光标收起',
            '提示=' + (rotHint && rotHint.hidden ? '隐藏' : '仍显示'));

        const m0 = M(newLine, CW, CH);
        const spinning = A.beginRotate({ x: hd.x, y: hd.y });
        add(!!spinning, '⑨ 把手可被命中（先于元素命中判断）', spinning ? 'ok' : 'null');
        // 旋转首帧建一次背景缓存，之后每帧只 blit 背景 + 重画文字，不再整帧合成。
        A.renderPreview();
        const baseReady = A._dragBaseValid() && A._skipUserEl === newLine;
        const origRender = window.__render;
        let fullRenders = 0;
        window.__render = function () { fullRenders++; return origRender.apply(this, arguments); };
        A.applyRotate({ x: (m0.cx + 160) * k, y: m0.cy * k }, false);
        A.renderPreview();
        window.__render = origRender;
        add(baseReady && fullRenders === 0,
            '⑨ 旋转复用背景缓存（不再每帧整帧重绘）',
            '缓存=' + baseReady + ' 全量重绘=' + fullRenders);
        // 从正上方拖到正右方 = +90°
        const rot1 = newLine.rotation;
        A.applyRotate({ x: (m0.cx + 160) * k + 2, y: m0.cy * k }, true);   // Shift 吸附
        const rotSnap = newLine.rotation;
        // 快速通道的最后一帧与「松手后的整帧渲染」逐像素对比：
        // 背景缓存里不能残留旧角度的文字，否则旋转时会出现残影/拖尾。
        // 同时确认旋转中确实画了画布辅助线和随角度转动的轴线。
        const origAxes = A._drawTransformAxes;
        let axesCalls = 0;
        A._drawTransformAxes = function () { axesCalls++; return origAxes.apply(this, arguments); };
        A.renderPreview();
        A._drawTransformAxes = origAxes;
        const gFast = cv.getContext('2d');
        const guideFrame = new Uint8ClampedArray(gFast.getImageData(0, 0, cv.width, cv.height).data);
        add(axesCalls === 1, '⑨ 旋转时绘制随角度转动的辅助轴线', '轴线调用=' + axesCalls);
        // 画布中心竖线在图片下半部（深色区域）应该是一道可见亮线。
        const gx = Math.round(cv.width / 2);
        const gy = Math.round(cv.height * 0.86);
        let guideBright = 0;
        for (let yy = gy - 3; yy <= gy + 3; yy++) {
            for (let xx = gx - 3; xx <= gx + 3; xx++) {
                if (xx < 0 || yy < 0 || xx >= cv.width || yy >= cv.height) continue;
                const ii = (yy * cv.width + xx) * 4;
                if (guideFrame[ii] > 120 && guideFrame[ii + 1] > 120 && guideFrame[ii + 2] > 120) guideBright++;
            }
        }
        add(guideBright >= 2, '⑨ 旋转时也显示画布辅助线', '中心线亮点=' + guideBright + ' @' + gx + ',' + gy);
        // 辅助线本身会改变像素；无残影对比时临时关掉，只比较文字 + 选中框。
        const origGuides = A.drawLogoGuides;
        A.drawLogoGuides = function () {};
        A.renderPreview();
        A.drawLogoGuides = origGuides;
        const fastFrame = new Uint8ClampedArray(gFast.getImageData(0, 0, cv.width, cv.height).data);
        A._rotEl = null;
        A._skipUserEl = null;
        A._dropDragBase();
        A.renderPreview();
        const fullFrame = gFast.getImageData(0, 0, cv.width, cv.height).data;
        let diffPx = 0;
        for (let i = 0; i < fastFrame.length; i += 12) {   // 每 3 个像素采样一次
            if (Math.abs(fastFrame[i] - fullFrame[i]) > 10
                || Math.abs(fastFrame[i + 1] - fullFrame[i + 1]) > 10
                || Math.abs(fastFrame[i + 2] - fullFrame[i + 2]) > 10) diffPx++;
        }
        add(diffPx < 30, '⑨ 旋转快速通道与整帧渲染一致（无残影/错位）', '差异采样点=' + diffPx);
        add(Math.abs(rot1 - 90) <= 3, '⑨ 鼠标旋转：拖到正右 ≈ 90°', rot1 + '°');
        add(rotSnap % 15 === 0, '⑨ Shift 吸附到 15° 整数倍', rotSnap + '°');
    }

    // 双击画布上的文字 → 画布内编辑器（预填当前内容）→ 改完生效
    const mDouble = M(newLine, CW, CH);
    const pcd = toClient(mDouble.cx, mDouble.cy);
    A.dom.canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: pcd.x, clientY: pcd.y, bubbles: true, button: 0 }));
    await sleep(150);
    const taD = editor();
    const prefill = taD ? taD.value : null;
    const dblOpened = !!taD;
    const ghostPx = whitePixels(M(newLine, CW, CH));
    add(dblOpened && ghostPx <= 5, '⑩ 双击打开编辑器时画布旧字先清掉（不叠出重影）',
        '画布残留白像素=' + ghostPx);
    setEditor('双击改字');
    await sleep(80);
    A.commitTextEditor();
    await sleep(120);
    add(dblOpened && prefill === '测试新建\\n第二行' && newLine.text === '双击改字',
        '⑩ 双击画布文字 → 就地打开编辑器并生效',
        '预填=' + JSON.stringify(prefill) + ' 之后=' + JSON.stringify(newLine.text));

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
    add(Math.abs(mStyled.lh - 88 * 1.18) <= 2, '⑪ 字号 88 立刻反映到几何框（改字后只剩 1 行）',
        'h=' + mStyled.lh.toFixed(1) + ' 期望 ' + (88 * 1.18).toFixed(1));

    // 双击空白画布：未进入添加模式时必须什么都不建；进入后才在双击点新建
    const blankLx = Math.round(CW * 0.72), blankLy = Math.round(CH * 0.7);
    const pcb = toClient(blankLx, blankLy);
    A.selectedEls = [];
    A.refreshElList();
    const beforeBlank = decor.textLines.length;
    A.dom.canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: pcb.x, clientY: pcb.y, bubbles: true, button: 0 }));
    await sleep(150);
    add(decor.textLines.length === beforeBlank && !editor(),
        '⑩ 未点「添加文字」时，双击空白画布不会新建文字',
        '条数=' + decor.textLines.length + ' 编辑器=' + !!editor());
    if (addBtn) addBtn.click();
    A.dom.canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: pcb.x, clientY: pcb.y, bubbles: true, button: 0 }));
    await sleep(150);
    const blankLine = decor.textLines[decor.textLines.length - 1];
    add(!!editor() && blankLine !== newLine && Math.abs(blankLine.x - blankLx) <= 2 && Math.abs(blankLine.y - blankLy) <= 2,
        '⑩ 添加模式下双击空白画布：在双击点新建文字',
        blankLine ? 'el=' + blankLine.x + ',' + blankLine.y + ' 期望=' + blankLx + ',' + blankLy : 'null');
    setEditor('空白处新建');
    await sleep(60);
    A.commitTextEditor();
    await sleep(100);

    // ── ⑬ 旋转角显示：跨过 360 不能冒出 3.1999999999998 这种长串（用户截图） ──
    const elR = newLine;
    elR.rotation = 363.2;
    A.syncSliderFromEl({ kind: 'text', obj: elR });
    const lblR = document.getElementById('lblElementRotation');
    const inpR = document.getElementById('inpElRotation');
    add(!!lblR && lblR.textContent === '3.2°' && !!inpR && inpR.value === '3.2',
        '⑬ 旋转角跨 360 后显示为 3.2°（不是浮点长串）',
        (lblR ? lblR.textContent : '?') + ' / ' + (inpR ? inpR.value : '?'));
    // 面板可能没展开（clientWidth=0），宽度断言会是空过；改成"文本必须够短"这条硬判据：
    // 46px 的数值位放得下 "359.9°"（6 字符），放不下原来那串 18 字符的浮点尾巴。
    add(!!lblR && lblR.textContent.length <= 8, '⑬ 旋转数值文本够短（放得进 46px 数值位）',
        '"' + (lblR ? lblR.textContent : '?') + '" 长度 ' + (lblR ? lblR.textContent.length : '?'));
    const seqR = [];
    for (let i = 0; i < 3; i++) { A.nudgeElement({ kind: 'text', obj: elR }, 'rot', 1); seqR.push(elR.rotation); }
    add(seqR.every(v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9), '⑬ 滚轮累加不产生浮点尾巴',
        seqR.join(' / '));

    // ── ⑭ 拖动中的「单元素重绘」必须和整帧同一口径 ──
    // 曾经的 bug：mousedown 后走「缓存底图 + 单独重画该元素」，那条路径传的是逻辑尺寸
    // 且不给 scl，于是在物理画布上多出一份「逻辑坐标、未缩放」的小字贴在左上角。
    // 这里直接调 _drawDraggedEl（就是那段代码），比模拟鼠标更确定：离屏画布上量墨迹位置。
    decor.textLines = [{ text: '按住测试', align: 'free', x: CW / 2, y: CH / 2, fontSize: 64,
                         fontFamily: 'Microsoft YaHei', colorHex: '#ffffff', opacity: 100, letterSpacing: 0 }];
    const elH = decor.textLines[0];
    const mH = M(elH, CW, CH);
    const cvH = A.dom.canvas;
    const offH = document.createElement('canvas');
    offH.width = cvH.width; offH.height = cvH.height;
    const gH = offH.getContext('2d');
    gH.fillStyle = '#000'; gH.fillRect(0, 0, offH.width, offH.height);
    A._drawDraggedEl(gH, elH, 'text');
    const dH = gH.getImageData(0, 0, offH.width, offH.height).data;
    let dx0 = 1e9, dy0 = 1e9, dx1 = -1, dy1 = -1, dn = 0;
    for (let y = 0; y < offH.height; y += 2) {
        for (let x = 0; x < offH.width; x += 2) {
            const i = (y * offH.width + x) * 4;
            if (dH[i] > 60 || dH[i + 1] > 60 || dH[i + 2] > 60) {
                dn++; if (x < dx0) dx0 = x; if (x > dx1) dx1 = x; if (y < dy0) dy0 = y; if (y > dy1) dy1 = y;
            }
        }
    }
    const wantCx = mH.cx * k, wantCy = mH.cy * k;
    const gotCx = dn ? (dx0 + dx1) / 2 : -1, gotCy = dn ? (dy0 + dy1) / 2 : -1;
    // 横向必须严格对齐；纵向允许半个字号左右的基线偏移（墨迹中心本来就在基线之上）
    add(dn > 50 && Math.abs(gotCx - wantCx) <= 8 && Math.abs(gotCy - wantCy) <= mH.fs * k * 0.4,
        '⑭ 拖动重绘的墨迹落在元素中心（不会跑到左上角）',
        '墨迹中心=' + Math.round(gotCx) + ',' + Math.round(gotCy) + ' 期望=' + Math.round(wantCx) + ',' + Math.round(wantCy)
        + '（纵向容差 ' + Math.round(mH.fs * k * 0.4) + 'px 基线偏移）像素 ' + dn);
    add(dn > 50 && Math.abs((dx1 - dx0) - mH.lw * k) <= mH.lw * k * 0.2,
        '⑭ 拖动重绘的尺寸与整帧一致（没被缩小）',
        '墨迹宽=' + (dx1 - dx0) + ' 框宽=' + Math.round(mH.lw * k));

    // ── ⑮ 多行 + 字重 / 描边 / 阴影 面板回写 ──
    decor.textLines = [{
        text: '第一行\\n第二行', align: 'free', x: CW * 0.5, y: CH * 0.5, fontSize: 48,
        fontFamily: 'Microsoft YaHei', fontWeight: 400, colorHex: '#ffffff', opacity: 100, letterSpacing: 0,
    }];
    const elStyle = decor.textLines[0];
    const mMulti = M(elStyle, CW, CH);
    add(mMulti.nLines === 2 && Math.abs(mMulti.lh - 2 * 48 * 1.18) <= 1,
        '⑮ 多行：按换行符拆成 2 行，框高 = 2 × 行高',
        'lines=' + mMulti.nLines + ' lh=' + mMulti.lh.toFixed(1) + ' 期望 ' + (2 * 48 * 1.18).toFixed(1));
    const inkMulti = inkBox(Object.assign({}, elStyle, { x: 200, y: 240 }), 400, 500);
    add(!!inkMulti && inkMulti.h > 48 * 1.5, '⑮ 多行真的画成两行（墨迹高度 > 1.5 字号）',
        inkMulti ? inkMulti.w + '×' + inkMulti.h : 'null');

    A.selectedEls = [{ kind: 'text', obj: elStyle }];
    A.refreshElList();
    const cbW = document.getElementById('cbElTextWeight');
    const chkS = document.getElementById('chkElTextStroke');
    const slSW = document.getElementById('slElTextStrokeWidth');
    const cpS = document.getElementById('cpElTextStroke');
    const chkSh = document.getElementById('chkElTextShadow');
    const slSB = document.getElementById('slElTextShadowBlur');
    const inSX = document.getElementById('inpElTextShadowX');
    const inSY = document.getElementById('inpElTextShadowY');
    const fire = (el, type) => { if (el) el.dispatchEvent(new Event(type, { bubbles: true })); };
    if (cbW) { cbW.value = '700'; fire(cbW, 'change'); }
    if (chkS) { chkS.checked = true; fire(chkS, 'change'); }
    if (slSW) { slSW.value = '6'; fire(slSW, 'input'); fire(slSW, 'change'); }
    if (cpS) { cpS.value = '#ff3333'; fire(cpS, 'input'); fire(cpS, 'change'); }
    if (chkSh) { chkSh.checked = true; fire(chkSh, 'change'); }
    if (slSB) { slSB.value = '12'; fire(slSB, 'input'); fire(slSB, 'change'); }
    if (inSX) { inSX.value = '-4'; fire(inSX, 'change'); }
    if (inSY) { inSY.value = '6'; fire(inSY, 'change'); }
    await sleep(200);
    add(elStyle.fontWeight === 700 && elStyle.strokeEnable === 1 && elStyle.strokeWidth === 6
        && elStyle.strokeColorHex === '#ff3333' && elStyle.enableShadow === 1 && elStyle.shadowBlur === 12
        && elStyle.shadowOffsetX === -4 && elStyle.shadowOffsetY === 6,
        '⑮ 字重/描边/阴影都写进元素',
        'w=' + elStyle.fontWeight + ' stroke=' + elStyle.strokeEnable + '/' + elStyle.strokeWidth + '/' + elStyle.strokeColorHex
        + ' shadow=' + elStyle.enableShadow + '/' + elStyle.shadowBlur + '/' + elStyle.shadowOffsetX + ',' + elStyle.shadowOffsetY);
    // 面板回显也要跟着元素走（选中后读的是元素，不是输入框残留）
    A.syncTextRows({ kind: 'text', obj: elStyle });
    add(cbW && cbW.value === '700' && chkS && chkS.checked && slSW && Number(slSW.value) === 6
        && chkSh && chkSh.checked && slSB && Number(slSB.value) === 12,
        '⑮ 重新选中时字重/描边/阴影面板正确回显',
        'w=' + (cbW ? cbW.value : '?') + ' stroke=' + (chkS ? chkS.checked : '?') + '/' + (slSW ? slSW.value : '?')
        + ' shadow=' + (chkSh ? chkSh.checked : '?') + '/' + (slSB ? slSB.value : '?'));

    // ── ⑯ 描边 / 阴影真的画出来了 ──
    const strokeLine = { text: 'S', align: 'free', x: 200, y: 180, fontSize: 72,
        fontFamily: 'Microsoft YaHei', colorHex: '#ffffff', opacity: 100,
        strokeEnable: 1, strokeWidth: 8, strokeColorHex: '#ff0000', strokeOpacity: 100 };
    const inkStroke = inkBox(strokeLine, 400, 320);
    add(!!inkStroke && inkStroke.red > 100, '⑯ 描边：白色字外圈画出红色边（红像素 > 100）',
        inkStroke ? '红=' + inkStroke.red + ' 框=' + inkStroke.w + '×' + inkStroke.h : 'null');
    const plainShadow = { text: 'S', align: 'free', x: 150, y: 130, fontSize: 64,
        fontFamily: 'Microsoft YaHei', colorHex: '#ffffff', opacity: 100 };
    const shadowLine = Object.assign({}, plainShadow, { enableShadow: 1, shadowBlur: 0,
        shadowColorHex: '#ff0000', shadowOpacity: 100, shadowOffsetX: 24, shadowOffsetY: 18 });
    const inkPlain = inkBox(plainShadow, 400, 300);
    const inkShadow = inkBox(shadowLine, 400, 300);
    add(!!inkPlain && !!inkShadow && inkShadow.x1 >= inkPlain.x1 + 15 && inkShadow.y1 >= inkPlain.y1 + 12 && inkShadow.red > 60,
        '⑯ 阴影：按偏移量向右下投出有颜色的影子',
        '无阴影=' + (inkPlain ? inkPlain.x1 + ',' + inkPlain.y1 : '?')
        + ' 有阴影=' + (inkShadow ? inkShadow.x1 + ',' + inkShadow.y1 : '?') + ' 红=' + (inkShadow ? inkShadow.red : '?'));

    // ── ⑰ 四角手柄：命中 / 等比缩放字号（位置中心不动） ──
    elStyle.letterSpacing = 4;
    elStyle.strokeEnable = 1; elStyle.strokeWidth = 6;
    elStyle.enableShadow = 1; elStyle.shadowBlur = 10;
    A.selectedEls = [{ kind: 'text', obj: elStyle }];
    A.scheduleRender(true);
    await sleep(600);
    const handles = A._resizeHandles || [];
    add(handles.length === 4, '⑰ 选中文字后四角出现缩放手柄', '手柄数=' + handles.length);
    const seH = handles.find(h => h.name === 'se');
    const hitH = seH ? A.hitResizeHandle({ x: seH.x, y: seH.y }) : null;
    add(!!hitH && hitH.name === 'se', '⑰ 角手柄能被命中', hitH ? hitH.name : 'null');
    const fs0 = elStyle.fontSize;
    const mBefore = M(elStyle, CW, CH);
    const started = !!(seH && A.beginResize({ x: seH.x, y: seH.y }));
    let resizeOk = false;
    if (started) {
        const rr = A._resizeEl;
        // 沿中心→手柄方向拖到 2 倍距离（物理像素口径）
        const ux = (seH.x / k - rr.cx) / rr.d0;
        const uy = (seH.y / k - rr.cy) / rr.d0;
        const ratio = 2;
        resizeOk = A.applyResize({ x: (rr.cx + rr.d0 * ratio * ux) * k, y: (rr.cy + rr.d0 * ratio * uy) * k });
        A._resizeEl = null;
    }
    const mAfter = M(elStyle, CW, CH);
    add(started && resizeOk && Math.abs(elStyle.fontSize - fs0 * 2) <= 2,
        '⑰ 拖角 2 倍距离 ≈ 字号 ×2', 'fs ' + fs0 + ' → ' + elStyle.fontSize);
    add(Math.abs(elStyle.letterSpacing - 8) <= 1 && Math.abs(elStyle.strokeWidth - 12) <= 1 && Math.abs(elStyle.shadowBlur - 20) <= 1,
        '⑰ 字距/描边/阴影随字号等比缩放',
        'ls=' + elStyle.letterSpacing + ' stroke=' + elStyle.strokeWidth + ' blur=' + elStyle.shadowBlur);
    add(Math.abs(mAfter.cx - mBefore.cx) <= 1 && Math.abs(mAfter.cy - mBefore.cy) <= 1,
        '⑰ 缩放以文字中心为基准（中心不跑）',
        'dx=' + (mAfter.cx - mBefore.cx).toFixed(1) + ' dy=' + (mAfter.cy - mBefore.cy).toFixed(1));

    decor.textLines = savedLines;

    // ── ⑫ 大图（uiScale<1）也必须落在画布中心、且绘制尺寸与度量框一致 ──
    // 这条是为一个真 bug 加的：文字层用 cw/canvasW（含 uiScale）当缩放因子，
    // 而元素坐标是 _logW 口径 —— 大图上文字会偏到左上、框比字大一圈。
    const bigImg = await (async () => {
        const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
        const g = c.getContext('2d'); g.fillStyle = '#2b2f33'; g.fillRect(0, 0, 4000, 3000);
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/jpeg', 0.9); });
        return im;
    })();
    A.image = { el: bigImg, name: 'big.jpg', w: 4000, h: 3000, exif: {} };
    A.images = [A.image]; A.selectedIdx = [0]; A.currentIdx = 0;
    A.template = A.defaultTemplate();
    A.setTpl(A.image, A.template);
    if (typeof A.updateEmptyState === 'function') A.updateEmptyState();
    A.scheduleRender(true);
    await sleep(1400);   // 3600×2700 的画布，500ms 来不及重绘（实测会读到旧帧）
    const cvB = A.dom.canvas;
    const kB = A.textSpaceScale();
    const decorB = A.template.decorConfig || (A.template.decorConfig = {});
    decorB.textLines = [];
    A.addFreeText();
    const nb = A.createTextAt(cvB._logW / 2, cvB._logH / 2);
    await sleep(120);
    if (nb) {
        setEditor('大图居中');
        await sleep(60);
        A.commitTextEditor();
    }
    await sleep(700);
    const elB = decorB.textLines[0];
    const mB = M(elB, cvB._logW, cvB._logH);
    add(Math.abs(elB.x - cvB._logW / 2) <= 1 && Math.abs(elB.y - cvB._logH / 2) <= 1,
        '⑫ 大图：新建文字落在逻辑画布中心（uiScale<1）',
        'el=' + elB.x + ',' + elB.y + ' 中心=' + Math.round(cvB._logW / 2) + ',' + Math.round(cvB._logH / 2)
        + ' 画布 ' + cvB.width + '×' + cvB.height + ' 逻辑 ' + cvB._logW + '×' + cvB._logH);
    // 差分找真实墨迹：每 4 像素采样（9.7M 像素全扫太慢，采样足够定位中心/尺寸）
    const grabB = async () => {
        A.scheduleRender(true);
        await sleep(1400);   // 同上：大画布重绘慢，等太短两帧会是同一张旧图
        return cvB.getContext('2d').getImageData(0, 0, cvB.width, cvB.height).data;
    };
    const onB = await grabB();
    elB.opacity = 0;
    const offB = await grabB();
    elB.opacity = 100;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, bn = 0;
    for (let y = 0; y < cvB.height; y += 4) {
        for (let x = 0; x < cvB.width; x += 4) {
            const i = (y * cvB.width + x) * 4;
            if (Math.abs(onB[i] - offB[i]) + Math.abs(onB[i + 1] - offB[i + 1]) + Math.abs(onB[i + 2] - offB[i + 2]) > 30) {
                bn++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
            }
        }
    }
    const inkCx = bn ? (bx0 + bx1) / 2 : -1;
    const inkCy = bn ? (by0 + by1) / 2 : -1;
    const inkW = bn ? bx1 - bx0 : 0;
    add(bn > 0 && Math.abs(inkCx - cvB.width / 2) <= cvB.width * 0.03
        && Math.abs(inkCy - cvB.height / 2) <= cvB.height * 0.03,
        '⑫ 大图：墨迹真的画在画布中心（不是左上角）',
        '墨迹中心=' + Math.round(inkCx) + ',' + Math.round(inkCy) + ' 画布中心=' + (cvB.width / 2) + ',' + (cvB.height / 2));
    add(bn > 0 && Math.abs(inkW - mB.lw * kB) <= mB.lw * kB * 0.15,
        '⑫ 大图：绘制宽度与度量框一致（不会小一圈）',
        '墨迹宽=' + inkW + ' 框宽=' + Math.round(mB.lw * kB));
    elB.opacity = 100;
    A.scheduleRender(true);
    await sleep(300);

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
