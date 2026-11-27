'use strict';
/* 手机版：导入 → 选风格 → 引擎渲染 → 保存/分享；拼图 / 调色 / 切图。 */
(function () {
    const panel = document.getElementById('panel');
    const canvas = document.getElementById('previewCanvas');
    const stageEmpty = document.getElementById('stageEmpty');
    const toast = document.getElementById('toast');
    const A = window.App;
    const state = {
        image: null, images: [], preset: null, template: window.qfsNative.defaultTemplate(),
        page: 'home', homeQuery: '',
        tab: 'style', editSub: 'border', selectedElement: '', editingText: null,
        filter: '全部', activeSlot: 0, importing: false, exporting: false,
        query: '', favOnly: false, pendingDel: -1,
        puzzle: { enabled: 1, layout: 'grid4', gap: 6, bgMode: 0, canvasRatio: 'auto', borderColor: 'ffffff', slots: {} },
        crop: { rows: 3, cols: 3, pad: 0, offX: 0, offY: 0, picked: new Set(), blocks: [], touched: false }
    };

    const textEditor = document.getElementById('textEditor');
    let textOrig = '';

    // ── 撤销 / 重做：模板 + 调色各存一份快照 ─────────────────────────────
    // 快照在「动手之前」压栈（面板 pointerdown / 元素按下 / 套预设前），
    // 拖一次滑块只算一步；撤销时跳过与当前状态相同的空步。
    const UNDO_MAX = 20;
    const undoStack = [];
    const redoStack = [];
    // ── 照片方向：把用户点的旋转/翻转记成操作序列，导出时在全尺寸上重放 ────
    // 不直接把角度写进模板：模板是「相框/文字」的容器，方向属于照片本身。
    // 代理画布旋转后按 im.base 重建，撤销就能靠操作序列回到任意一步。
    const IMG_OPS = { r: 1, l: 1, f: 1, v: 1 };
    function bakeOps(src, ops) {
        let cur = src;
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const w = cur.width, h = cur.height;
            const out = document.createElement('canvas');
            // 裁剪：{ t:'crop', x,y,w,h } 全是相对当前画面的 0~1，
            // 预览和全尺寸重放用同一组比例，不会因为尺寸不同裁歪
            if (op && op.t === 'crop') {
                const sx = Math.round(w * op.x), sy = Math.round(h * op.y);
                const sw = Math.max(1, Math.round(w * op.w)), sh = Math.max(1, Math.round(h * op.h));
                out.width = sw; out.height = sh;
                out.getContext('2d').drawImage(cur, sx, sy, sw, sh, 0, 0, sw, sh);
                out.naturalWidth = sw; out.naturalHeight = sh; out.complete = true;
                cur = out;
                continue;
            }
            if (op === 'r' || op === 'l') { out.width = h; out.height = w; }
            else { out.width = w; out.height = h; }
            const g = out.getContext('2d');
            if (op === 'r' || op === 'l') {
                g.translate(out.width / 2, out.height / 2);
                g.rotate((op === 'r' ? 1 : -1) * Math.PI / 2);
                g.drawImage(cur, -w / 2, -h / 2);
            } else if (op === 'f') {
                g.translate(w, 0); g.scale(-1, 1); g.drawImage(cur, 0, 0);
            } else {
                g.translate(0, h); g.scale(1, -1); g.drawImage(cur, 0, 0);
            }
            out.naturalWidth = out.width; out.naturalHeight = out.height; out.complete = true;
            cur = out;
        }
        return cur;
    }
    function ensureImgBase(im) {
        if (im.base) return;
        const el = im.el;
        im.base = el;
        // 旋转是「在 90° 网格上翻面」，原图逻辑尺寸也要跟着换宽高，
        // 否则 proxyRatio 会认为长边变了，把相框边距算错。
        im.baseSrcW = Number(im.srcW) || Number(el && el.naturalWidth) || (el && el.width) || 0;
        im.baseSrcH = Number(im.srcH) || Number(el && el.naturalHeight) || (el && el.height) || 0;
    }
    function rebuildImageCanvas(im) {
        if (!im || !im.base) return;
        const ops = im.ops || [];
        im.el = ops.length ? bakeOps(im.base, ops) : im.base;
        im.w = im.el.naturalWidth || im.el.width;
        im.h = im.el.naturalHeight || im.el.height;
        const quarter = ops.filter((o) => o === 'r' || o === 'l').length % 2 === 1;
        let sw = quarter ? im.baseSrcH : im.baseSrcW;
        let sh = quarter ? im.baseSrcW : im.baseSrcH;
        // 裁掉一半不能还按原图长边算字号/相框边距
        ops.forEach((o) => {
            if (o && o.t === 'crop') { sw *= o.w; sh *= o.h; }
        });
        im.srcW = sw;
        im.srcH = sh;
        delete im._gradeCache;
        // 缩略图是按 el 画的，转过之后缓存就过期了（照片条/拼图格会显示旧方向）
        delete im._thumb;
        Object.keys(im).forEach((k) => { if (k.indexOf('_cover') === 0) delete im[k]; });
        if (typeof A.invalidateGrade === 'function') A.invalidateGrade(im);
    }
    function applyImageOp(op) {
        const im = state.image;
        if (!im || !im.el || !IMG_OPS[op]) { hint('先导入照片'); return; }
        pushUndo();
        ensureImgBase(im);
        im.ops = (im.ops || []).concat(op);
        // 先裁后转，宽高比会变成倒数；标签继续亮着会误导
        im.cropRatio = '';
        rebuildImageCanvas(im);
        scalePresetFonts(state.template, im);
        if (state.tab !== 'edit') state.tab = 'edit';
        state.editSub = 'photo';
        render('edit');
        const label = { r: '右转 90°', l: '左转 90°', f: '水平翻转', v: '垂直翻转' }[op];
        hint(`已${label}`);
    }
    // 居中按比例裁剪：不追求自由裁剪，先把「发社交用的方图 / 4:5」这类高频需求解决，
    // 仍然是操作序列里的一步，撤销和导出都和旋转同一套逻辑。
    function setCropRatio(ratio) {
        const im = state.image;
        if (!im || !im.el) { hint('先导入照片'); return; }
        // 「自由裁剪」不是一步裁切，而是进交互取景框
        if (ratio === 'free') { openFreeCrop(); return; }
        pushUndo();
        ensureImgBase(im);
        // 保留旋转/翻转，替换掉旧的裁剪
        const baseOps = (im.ops || []).filter((o) => typeof o === 'string');
        if (!ratio || ratio === 'orig') {
            im.ops = baseOps;
            im.cropRatio = '';
            rebuildImageCanvas(im);
            scalePresetFonts(state.template, im);
            render(state.tab);
            hint('已恢复完整画面');
            return;
        }
        const wh = String(ratio).split(':').map(Number);
        if (!(wh[0] > 0 && wh[1] > 0)) return;
        const target = wh[0] / wh[1];
        // 用旋转/翻转后的画面算裁剪框，否则先转再裁会裁错方向
        const turned = bakeOps(im.base, baseOps);
        const w = turned.width, h = turned.height;
        let cw = w, ch = Math.round(w / target);
        if (ch > h) { ch = h; cw = Math.round(h * target); }
        cw = Math.max(1, Math.min(w, cw));
        ch = Math.max(1, Math.min(h, ch));
        im.ops = baseOps.concat({
            t: 'crop',
            x: (w - cw) / 2 / w,
            y: (h - ch) / 2 / h,
            w: cw / w,
            h: ch / h
        });
        im.cropRatio = ratio;
        rebuildImageCanvas(im);
        scalePresetFonts(state.template, im);
        render(state.tab);
        hint(`已居中裁成 ${ratio}`);
    }
    function resetImageOps() {
        const im = state.image;
        if (!im || !(im.ops || []).length) { hint('方向没有改过'); return; }
        pushUndo();
        im.ops = [];
        im.cropRatio = '';
        rebuildImageCanvas(im);
        scalePresetFonts(state.template, im);
        render(state.tab);
        hint('已恢复照片原始方向');
    }
    const CROP_RATIOS = [['orig', '原图'], ['free', '自由裁剪'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9']];
    function photoOrientHtml() {
        const im = state.image;
        const ops = (im && im.ops) || [];
        const cur = (im && im.cropRatio) || 'orig';
        const ratioChips = CROP_RATIOS.map(([v, l]) =>
            `<button class="chip${cur === v ? ' active' : ''}" data-crop-ratio="${v}" type="button">${l}</button>`).join('');
        return `<div class="ctl-row"><label>比例</label><div class="chips crop-ratios">${ratioChips}</div></div>
            <p class="panel-note" style="margin-top:2px">按比例居中裁切，不移动取景框；选「原图」恢复完整画面。</p>
            <div class="orient-grid">
                <button type="button" data-img-op="l">↺ 左转 90°</button>
                <button type="button" data-img-op="r">↻ 右转 90°</button>
                <button type="button" data-img-op="f">⇆ 水平翻转</button>
                <button type="button" data-img-op="v">⇅ 垂直翻转</button>
            </div>
            <p class="panel-note">方向存在照片上：预览、导出、切图都是同一个方向。已放进拼图的照片，请在拼图页单独旋转那一格。</p>
            ${ops.length ? `<div class="puzzle-acts"><button id="btnImgReset" type="button">恢复原始方向</button></div>` : ''}`;
    }

    /* ── 自由裁剪：只在「照片」子页用。进裁剪时画布切成「只画照片」，
          框的坐标就是照片的坐标，导出时按同一组比例重放。 ── */
    const cropLayer = document.getElementById('cropLayer');
    const cropBar = document.getElementById('cropBar');
    const cropBoxEl = document.getElementById('cropBox');
    const cropRatiosEl = document.getElementById('cropRatios');
    const CROP_LOCKS = [['free', '自由'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9']];
    let cropEdit = null;

    function renderPhotoOnly() {
        Object.assign(A, { dom: { canvas }, image: state.image, images: state.images, template: state.template }, renderStubs, { displayMax: 1600, uiDprOverride: 1 });
        delete A.exportScale;
        try {
            if (typeof window.__render === 'function') window.__render(A, true);
        } catch (e) {
            console.warn('[mobile] crop preview failed', e);
        }
    }
    // 按锁定比例取最大内接矩形并居中；free 时就是整幅（fill 用来留一点边）
    function fitCropRect(w, h, ratio, fill) {
        const k = fill || 1;
        if (!ratio || ratio === 'free') {
            const bw = w * k, bh = h * k;
            return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
        }
        const wh = String(ratio).split(':').map(Number);
        const t = (wh[0] > 0 && wh[1] > 0) ? wh[0] / wh[1] : 1;
        let bw = w, bh = w / t;
        if (bh > h) { bh = h; bw = h * t; }
        bw *= k; bh *= k;
        return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
    }
    function paintCropBox() {
        if (!cropEdit || !cropBoxEl) return;
        const b = cropEdit.box;
        const W = cropEdit.w, H = cropEdit.h;
        cropBoxEl.style.left = b.x + 'px';
        cropBoxEl.style.top = b.y + 'px';
        cropBoxEl.style.width = b.w + 'px';
        cropBoxEl.style.height = b.h + 'px';
        // 框外四条压暗带
        const dim = (k, x, y, w, h) => {
            const el = cropLayer.querySelector('[data-dim="' + k + '"]');
            if (!el) return;
            el.style.left = Math.max(0, x) + 'px';
            el.style.top = Math.max(0, y) + 'px';
            el.style.width = Math.max(0, w) + 'px';
            el.style.height = Math.max(0, h) + 'px';
        };
        dim('t', 0, 0, W, b.y);
        dim('b', 0, b.y + b.h, W, H - (b.y + b.h));
        dim('l', 0, b.y, b.x, b.h);
        dim('r', b.x + b.w, b.y, W - (b.x + b.w), b.h);
        cropRatiosEl.querySelectorAll('[data-crop-lock]').forEach((el) => {
            el.classList.toggle('active', el.dataset.cropLock === cropEdit.ratio);
        });
    }
    function openFreeCrop() {
        if (!state.image || !state.image.el) { hint('先导入照片'); return; }
        if (state.exporting) return;
        // 手势缩放会改变画布的显示矩形：进裁剪前先复位，框才不会画偏
        viewZoom = 1; viewPan = { x: 0, y: 0 }; applyView();
        // 先给底部操作条腾出位置，再测量画布：否则框会被按钮压住
        const stageEl0 = document.getElementById('stage');
        stageEl0.classList.add('cropping');
        renderPhotoOnly();
        // 同步量：隐藏窗口/后台标签页里 requestAnimationFrame 可能一直不触发，
        // 裁剪框就会“点了没反应”。getBoundingClientRect 本身会强制一次布局。
        {
            const stageEl = document.getElementById('stage');
            const sr = stageEl.getBoundingClientRect();
            const cr = canvas.getBoundingClientRect();
            // 尺寸不取整：取整会让「方图」少裁/多裁 1~2px（1600×1200 裁出 1202×1200）
            const w = Math.max(40, cr.width);
            const h = Math.max(40, cr.height);
            // 层只盖住照片本身（画布盒子=照片显示框），四周留白不参与裁剪
            cropLayer.style.left = (cr.left - sr.left) + 'px';
            cropLayer.style.top = (cr.top - sr.top) + 'px';
            cropLayer.style.width = w + 'px';
            cropLayer.style.height = h + 'px';
            cropLayer.hidden = false;
            const im = state.image;
            const ratio = (im.cropRatio && im.cropRatio !== 'free') ? im.cropRatio : 'free';
            // 已有裁剪时，画面上看到的就是裁过的部分：框从「整幅」开始
            cropEdit = { w, h, ratio, box: fitCropRect(w, h, ratio, 1), drag: null };
            cropRatiosEl.innerHTML = CROP_LOCKS.map(([v, l]) =>
                `<button class="chip${ratio === v ? ' active' : ''}" type="button" data-crop-lock="${v}">${l}</button>`).join('');
            paintCropBox();
            cropBar.hidden = false;
        }
    }
    function closeCropEdit(restore) {
        cropEdit = null;
        const stageEl = document.getElementById('stage');
        if (stageEl) stageEl.classList.remove('cropping');
        if (cropLayer) cropLayer.hidden = true;
        if (cropBar) cropBar.hidden = true;
        if (restore) { try { renderPreview(true); } catch (_) {} }
    }
    function applyFreeCrop() {
        const im = state.image;
        if (!cropEdit || !im || !im.el) { closeCropEdit(true); return; }
        const R = {
            x: cropEdit.box.x / cropEdit.w,
            y: cropEdit.box.y / cropEdit.h,
            w: cropEdit.box.w / cropEdit.w,
            h: cropEdit.box.h / cropEdit.h
        };
        // 框几乎盖满整幅时不记这一步，免得序列里堆一堆「没裁」的操作
        const full = R.x < 0.004 && R.y < 0.004 && R.w > 0.992 && R.h > 0.992;
        const ratio = cropEdit.ratio;
        closeCropEdit(false);
        if (full) { render(state.tab); hint('裁剪框没有变化'); return; }
        pushUndo();
        ensureImgBase(im);
        const baseOps = (im.ops || []).filter((o) => typeof o === 'string');
        const prev = (im.ops || []).find((o) => o && o.t === 'crop');
        let crop = { t: 'crop', ...R };
        if (prev) {
            // 本次是在「已经裁过的画面」上再裁：两次裁切换算成一次，
            // 否则基准变成裁剪后的画面，叠加后越裁越小
            crop = {
                t: 'crop',
                x: prev.x + R.x * prev.w,
                y: prev.y + R.y * prev.h,
                w: R.w * prev.w,
                h: R.h * prev.h
            };
        }
        im.ops = baseOps.concat(crop);
        im.cropRatio = (ratio && ratio !== 'free') ? ratio : 'free';
        rebuildImageCanvas(im);
        scalePresetFonts(state.template, im);
        render(state.tab);
        hint('裁剪已应用');
    }

    if (cropLayer) {
        cropLayer.addEventListener('pointerdown', (e) => {
            if (!cropEdit) return;
            const lr = cropLayer.getBoundingClientRect();
            const px = e.clientX - lr.left, py = e.clientY - lr.top;
            const handle = e.target.closest('[data-ch]');
            const b = cropEdit.box;
            const inBox = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
            if (!handle && !inBox) return;
            e.preventDefault();
            try { cropLayer.setPointerCapture(e.pointerId); } catch (_) {}
            cropEdit.drag = {
                id: e.pointerId, mode: handle ? 'resize' : 'move',
                corner: handle ? handle.dataset.ch : '',
                sx: px, sy: py, box: { ...b }
            };
        });
        cropLayer.addEventListener('pointermove', (e) => {
            const d = cropEdit && cropEdit.drag;
            if (!d || d.id !== e.pointerId) return;
            const lr = cropLayer.getBoundingClientRect();
            const px = Math.min(cropEdit.w, Math.max(0, e.clientX - lr.left));
            const py = Math.min(cropEdit.h, Math.max(0, e.clientY - lr.top));
            const W = cropEdit.w, H = cropEdit.h;
            if (d.mode === 'move') {
                cropEdit.box = {
                    x: Math.min(W - d.box.w, Math.max(0, d.box.x + (px - d.sx))),
                    y: Math.min(H - d.box.h, Math.max(0, d.box.y + (py - d.sy))),
                    w: d.box.w, h: d.box.h
                };
            } else {
                const ax = d.corner.indexOf('w') >= 0 ? d.box.x + d.box.w : d.box.x;
                const ay = d.corner.indexOf('n') >= 0 ? d.box.y + d.box.h : d.box.y;
                const maxW = px < ax ? ax : W - ax;
                const maxH = py < ay ? ay : H - ay;
                let bw = Math.abs(px - ax), bh = Math.abs(py - ay);
                const wh = String(cropEdit.ratio || 'free').split(':').map(Number);
                const t = (cropEdit.ratio && cropEdit.ratio !== 'free' && wh[0] > 0 && wh[1] > 0)
                    ? wh[0] / wh[1] : 0;
                if (t) {
                    // 锁定比例：以指针更贴近的那条边为准，另一边等比跟
                    if (bw / Math.max(1, bh) > t) bh = bw / t; else bw = bh * t;
                    if (bw > maxW) { bw = maxW; bh = bw / t; }
                    if (bh > maxH) { bh = maxH; bw = bh * t; }
                } else {
                    bw = Math.min(bw, maxW);
                    bh = Math.min(bh, maxH);
                }
                bw = Math.max(24, bw);
                bh = Math.max(24, bh);
                cropEdit.box = {
                    x: Math.min(W - bw, Math.max(0, px < ax ? ax - bw : ax)),
                    y: Math.min(H - bh, Math.max(0, py < ay ? ay - bh : ay)),
                    w: bw, h: bh
                };
            }
            paintCropBox();
        });
        const endDrag = (e) => {
            if (cropEdit && cropEdit.drag && cropEdit.drag.id === e.pointerId) cropEdit.drag = null;
        };
        cropLayer.addEventListener('pointerup', endDrag);
        cropLayer.addEventListener('pointercancel', endDrag);
        cropRatiosEl.addEventListener('click', (e) => {
            const b = e.target.closest('[data-crop-lock]');
            if (!b || !cropEdit) return;
            cropEdit.ratio = b.dataset.cropLock;
            // 保留用户已经框好的位置和大致范围：中心不动，按新比例收一档
            const box = cropEdit.box;
            if (cropEdit.ratio !== 'free') {
                const wh = cropEdit.ratio.split(':').map(Number);
                const t = (wh[0] > 0 && wh[1] > 0) ? wh[0] / wh[1] : 1;
                let bw = Math.min(box.w, box.h * t);
                let bh = bw / t;
                const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
                bw = Math.min(bw, cropEdit.w);
                bh = Math.min(bh, cropEdit.h);
                cropEdit.box = {
                    x: Math.min(cropEdit.w - bw, Math.max(0, cx - bw / 2)),
                    y: Math.min(cropEdit.h - bh, Math.max(0, cy - bh / 2)),
                    w: bw, h: bh
                };
            }
            paintCropBox();
        });
        document.getElementById('btnCropCancel').addEventListener('click', () => closeCropEdit(true));
        document.getElementById('btnCropApply').addEventListener('click', applyFreeCrop);
    }

    function snapNow() {
        return JSON.stringify({
            t: state.template,
            g: state.image ? (state.image.grade || null) : null,
            p: state.preset ? (state.preset._fileName || '') : '',
            // 拼图的版式/槽位也是「用户刚做的改动」，不进快照的话点撤销会去撤销更早的
            // 模板改动，看起来像「撤销没反应 / 撤错了」
            z: state.puzzle ? { layout: state.puzzle.layout, slots: state.puzzle.slots } : null,
            // 方向/裁剪同理：照片像素被处理过了，撤销必须能把画布还原
            r: state.image ? (state.image.ops || []) : null,
            c: state.image ? (state.image.cropRatio || '') : ''
        });
    }
    function updateUndoUI() {
        const u = document.getElementById('btnUndo');
        const r = document.getElementById('btnRedo');
        if (u) u.disabled = undoStack.length === 0;
        if (r) r.disabled = redoStack.length === 0;
        // 没有任何历史时整颗胶囊都不出现，画布上不多一块东西
        const dock = document.getElementById('historyDock');
        if (dock) dock.hidden = undoStack.length === 0 && redoStack.length === 0;
    }
    function pushUndo() {
        const s = snapNow();
        if (undoStack.length && undoStack[undoStack.length - 1] === s) return false;
        undoStack.push(s);
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        redoStack.length = 0;
        updateUndoUI();
        return true;
    }
    function applySnap(s) {
        const o = JSON.parse(s);
        state.template = o.t;
        A.template = state.template;
        state.preset = o.p ? ((window.QF_PRESETS || []).find((p) => p._fileName === o.p) || null) : null;
        if (state.image && o.r) {
            const cur = JSON.stringify(state.image.ops || []);
            if (cur !== JSON.stringify(o.r)) {
                state.image.ops = o.r.slice();
                rebuildImageCanvas(state.image);
                scalePresetFonts(state.template, state.image);
            }
            state.image.cropRatio = o.c || '';
        }
        if (o.z && state.puzzle) {
            state.puzzle.layout = o.z.layout || state.puzzle.layout;
            state.puzzle.slots = o.z.slots || {};
            clampActiveSlot();
        }
        if (state.image) {
            if (o.g) state.image.grade = o.g; else delete state.image.grade;
            if (typeof A.invalidateGrade === 'function') A.invalidateGrade(state.image);
        }
        render(state.tab);   // 面板与画布一起回到快照（render 内部会重画预览）
        updateUndoUI();
    }
    function undo() {
        const cur = snapNow();
        let s = null;
        while (undoStack.length) {
            const c = undoStack.pop();
            if (c !== cur) { s = c; break; }
        }
        if (s == null) { updateUndoUI(); hint('没有可撤销的操作'); return; }
        redoStack.push(cur);
        applySnap(s);
        hint('已撤销');
    }
    function redo() {
        const cur = snapNow();
        let s = null;
        while (redoStack.length) {
            const c = redoStack.pop();
            if (c !== cur) { s = c; break; }
        }
        if (s == null) { updateUndoUI(); hint('没有可重做的操作'); return; }
        undoStack.push(cur);
        applySnap(s);
        hint('已重做');
    }
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);
    // 面板里任何一次「按下/聚焦」都先记一版：滑块拖一次只压一步
    panel.addEventListener('pointerdown', () => pushUndo(), true);
    panel.addEventListener('focusin', (e) => {
        const t = e.target;
        if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) pushUndo();
    }, true);

    let lastTap = { t: 0, key: '' };
    let lastEmptyTap = 0;
    // 双指缩放/平移预览（只改 CSS transform，不碰导出画布）
    let viewZoom = 1;
    let viewPan = { x: 0, y: 0 };
    let pinch = null;
    const activePointers = new Map();
    function applyView() {
        canvas.style.transformOrigin = 'center center';
        canvas.style.transform = `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`;
    }
    function resetView() {
        viewZoom = 1; viewPan = { x: 0, y: 0 };
        applyView();
        hint('预览已复位');
    }
    let toastTimer = 0;
    function hint(text, ms) {
        if (!text) return;
        if (!toast) {
            const span = stageEmpty && stageEmpty.querySelector('span');
            if (span) span.textContent = text;
            return;
        }
        toast.textContent = text;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, ms || 2800);
    }
    // 原生适配层（HEIC 兜底解码）在 mobile.js 之前加载，通过它复用同一个 toast
    window.qfHint = hint;

    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function numv(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function dimsOf(im) { return im ? `${im.w}×${im.h}` : '未导入照片'; }
    // 缩略图按图缓存：拼图页/当前照片条每次重绘都重新 toDataURL 一张 1600px
    // 的图，会明显卡顿；缓存后只在首次生成。
    function thumbOf(im, q) {
        if (!im || !im.el) return '';
        if (im._thumb) return im._thumb;
        try {
            const iw = im.el.naturalWidth || im.el.width || 0;
            const ih = im.el.naturalHeight || im.el.height || 0;
            if (!iw || !ih) return '';
            const k = Math.min(1, 160 / Math.max(iw, ih));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(iw * k));
            c.height = Math.max(1, Math.round(ih * k));
            c.getContext('2d').drawImage(im.el, 0, 0, c.width, c.height);
            im._thumb = c.toDataURL('image/jpeg', q || 0.6);
            return im._thumb;
        } catch (_) { return ''; }
    }
    // 风格/调色/切图页的当前照片条：导入是追加到照片库的，没有这条的话
    // 第二张之后的照片只能在拼图页看到，主流程里永远切不回去。
    // 照片条从面板搬到画布下方（全局一条）：面板换页签时它不跟着重建，
    // 切换照片也不会把面板滚动位置顶回顶部。
    function currentStrip() {
        const host = document.getElementById('filmstrip');
        if (!host) return '';
        if (state.images.length < 2) {
            host.hidden = true;
            host.innerHTML = '';
            return '';
        }
        host.hidden = false;
        host.innerHTML = state.images.map((im, i) => {
            const active = im === state.image ? ' active' : '';
            return `<button class="photo-thumb${active}" data-current="${i}" title="${esc(im.name)}">`
                + `<img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`;
        }).join('') + '<button class="film-add" data-film-add="1" type="button" aria-label="添加照片">＋</button>';
        return '';
    }
    function presetLabel() {
        return (state.preset && (state.preset.templateName || state.preset._fileName)) || '已套用风格';
    }
    // 顶栏就是新的「状态条」：风格名 + 尺寸/张数，导出固定在右侧。
    // 保留 stageBar(name, meta) 这个老接口，各页签的调用一行都不用改。
    function stageBar(name, meta) {
        // 首页/我的有自己的标题，编辑页的进度回调不能把它们覆盖掉
        if (state.page && state.page !== 'edit') return;
        const n = document.getElementById('hdrName');
        const m = document.getElementById('hdrMeta');
        if (n) n.textContent = name || '未选择风格';
        if (m) m.textContent = meta || '—';
        const th = document.getElementById('hdrThumbImg');
        if (th) {
            const src = state.image ? thumbOf(state.image, 0.5) : '';
            if (src) th.src = src; else th.removeAttribute('src');
        }
    }
    function updateEmpty() {
        const has = !!state.image;
        stageEmpty.hidden = has;
        if (!has) {
            const b = stageEmpty.querySelector('b');
            const s = stageEmpty.querySelector('span');
            if (b) b.textContent = '先导入一张照片';
            if (s) s.textContent = '点右上角的 ＋ 选图';
        }
    }

    const renderStubs = {
        fitZoom() {}, applyZoomStyle() {}, requestRender() {}, logoMaxSize() { return 120; },
        _gesture: false, _forceFitNext: true, selectedEls: [], displayMax: 1600, uiDprOverride: 1
    };

    // 调色滑块 input 事件一秒能来几十次，每次都跑一遍 1600px 引擎渲染会直接把
    // 手机拖到个位数帧率。合并到下一帧，一帧最多渲染一次。
    let previewRaf = 0;
    function renderPreviewSoon() {
        if (previewRaf) return;
        previewRaf = requestAnimationFrame(() => {
            previewRaf = 0;
            renderPreview();
        });
    }

    // 把当前页签的内容画到预览画布。puzzle 走独立管线；其余页签都画「照片 + 风格 + 调色」。
    // opts 可临时覆盖 displayMax/exportScale 等渲染档位（导出原尺寸时用），
    // 不传则回到 1600px 预览档，并清掉上一次导出残留的 exportScale。
    function renderPreview(skipHistogram, opts) {
        // 预览用代理图渲染：把模板里「原图口径」的绝对像素（边距/描边/齿孔/圆角/阴影）
        // 折成代理尺度；导出时 el 就是原图，比例回到 1，拿到的是未改动的模板。
        // 只浅拷贝要缩的那几层，文字/贴纸/Logo 仍引用原对象 —— 拖动与就地编辑靠对象身份跳过重绘。
        const tpl = state.tab === 'puzzle' ? state.template : renderTemplate(state.template, state.image);
        Object.assign(A, { dom: { canvas }, image: state.image, images: state.images, template: tpl }, renderStubs, opts || {});
        if (!opts || !('exportScale' in opts)) delete A.exportScale;
        if (state.tab === 'puzzle') {
            if (!state.images.length) { updateEmpty(); return; }
            state.template.puzzle = state.puzzle;
            A.template = state.template;
            // 画布上直接点格子：让引擎把选中格描出来（与面板网格同一个 activeSlot）
            A._activePuzzleSlot = state.activeSlot;
            // 预览画选中框（点哪格选哪格），导出帧（带 opts）不画，免得蓝边被烤进成品
            try { window.__renderPuzzle(A, false, !!opts); }
            catch (e) { console.warn('[mobile] puzzle render failed', e); paintFallback(); }
            updateEmpty();
            return;
        }
        if (!state.image) { updateEmpty(); return; }
        try {
            if (typeof window.__render === 'function') window.__render(A, false);
            else paintFallback();
        } catch (e) {
            console.warn('[mobile] render failed', e);
            paintFallback();
        } finally {
            // 缩放副本只在这一次同步渲染里用；面板/测试/后续操作读到的仍是可编辑的原模板
            A.template = state.template;
        }
        updateEmpty();
        // 导出帧（带 opts）不画选中框，避免把它烤进成品
        if (!opts) drawSelection();
        if (!skipHistogram && state.tab === 'grade' && window.QfsHistogram && state.image) {
            try { window.QfsHistogram.refresh(state.image); } catch (_) { /* 直方图可选 */ }
        }
    }

    // 画布上直接点选 / 拖动元素：坐标口径跟引擎一致
    // Logo/贴纸的 x/y 是显示画布像素；自由文字的 x/y 是基准逻辑像素（引擎按 scl 放大）。
    function elGeom(kind, o) {
        const cw = canvas.width, ch = canvas.height;
        const baseW = A._canvasBaseW || cw, baseH = A._canvasBaseH || ch;
        const scl = cw / Math.max(1, baseW);
        const n = (v, d) => { const x = Number(v); return isFinite(x) ? x : d; };
        if (kind === 'text') {
            const m = window.textLineMetrics && window.textLineMetrics(o, cw, ch, false, 0, 0, scl);
            if (!m) return null;
            return { x: m.x, y: m.y, w: m.w, h: m.h, cx: m.x + m.w / 2, cy: m.y + m.h / 2, scl };
        }
        if (kind === 'sticker') {
            const img = window.getElementBitmap && window.getElementBitmap(o.src);
            if (!img || !img.complete || !img.naturalWidth) return null;
            const w = img.naturalWidth * (n(o.scale, 1)), h = img.naturalHeight * (n(o.scale, 1));
            const cx = n(o.x, cw / 2), cy = n(o.y, ch / 2);
            return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, scl: 1 };
        }
        const img = window.getElementBitmap && window.getElementBitmap(o.dataUrl);
        const ratio = (img && img.naturalWidth) ? img.naturalHeight / img.naturalWidth : (n(o.ratio, 1) || 1);
        const size = Math.max(2, Math.min(n(o.size, 60), Math.min(cw, ch / Math.max(0.01, ratio))));
        const w = size, h = size * ratio;
        let cx, cy;
        if (o.rel && typeof o.rx === 'number' && typeof o.ry === 'number') {
            cx = o.rx * cw; cy = o.ry * ch;
        } else if (typeof o.x === 'number' && typeof o.y === 'number') {
            cx = o.x; cy = o.y;
        } else {
            cx = cw - 20 - w / 2; cy = ch - 20 - h / 2;
        }
        return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, scl: 1 };
    }

    function elementAt(key) {
        const t = state.template || {};
        const parts = String(key || '').split(':');
        const i = Number(parts[1]);
        const decor = t.decorConfig || {};
        const kind = parts[0];
        const o = kind === 'logo' ? (t.logoElements || [])[i]
            : kind === 'sticker' ? (decor.stickers || [])[i]
                : (decor.textLines || [])[i];
        return o ? { kind, key, obj: o, rect: elGeom(kind, o) } : null;
    }

    function hitElement(pt) {
        const t = state.template || {};
        const decor = t.decorConfig || {};
        const hits = [];
        (decor.stickers || []).forEach((o, i) => {
            const g = elGeom('sticker', o);
            if (g && pt.x >= g.x && pt.x <= g.x + g.w && pt.y >= g.y && pt.y <= g.y + g.h) {
                hits.push({ key: 'sticker:' + i, obj: o, rect: g, z: (o.z || 0) + 5 });
            }
        });
        (t.logoElements || []).forEach((o, i) => {
            if (!o || !o.dataUrl) return;
            const g = elGeom('logo', o);
            if (g && pt.x >= g.x && pt.x <= g.x + g.w && pt.y >= g.y && pt.y <= g.y + g.h) {
                hits.push({ key: 'logo:' + i, obj: o, rect: g, z: o.z || 0 });
            }
        });
        (decor.textLines || []).forEach((o, i) => {
            if (!o || o.align !== 'free' || !o.text) return;
            const g = elGeom('text', o);
            if (g && pt.x >= g.x && pt.x <= g.x + g.w && pt.y >= g.y && pt.y <= g.y + g.h) {
                hits.push({ key: 'text:' + i, obj: o, rect: g, z: (o.z || 0) + 20 });
            }
        });
        hits.sort((a, b) => b.z - a.z);
        return hits[0] || null;
    }

    function handlePos(g) {
        const r = Math.max(12, canvas.width * 0.018);
        return {
            r,
            rotate: { x: g.cx, y: g.y - 28 },
            resize: { x: g.x + g.w, y: g.y + g.h }
        };
    }

    function handleHit(pt) {
        if (state.tab !== 'edit' || !state.selectedElement) return null;
        const hit = elementAt(state.selectedElement);
        const g = hit && hit.rect;
        if (!g || !g.w || !g.h) return null;
        const hp = handlePos(g);
        if (Math.abs(pt.x - hp.rotate.x) <= hp.r && Math.abs(pt.y - hp.rotate.y) <= hp.r) {
            return { mode: 'rotate', hit };
        }
        if (Math.abs(pt.x - hp.resize.x) <= hp.r && Math.abs(pt.y - hp.resize.y) <= hp.r) {
            return { mode: 'resize', hit };
        }
        return null;
    }

    function drawSelection() {
        if (!state.selectedElement || state.exporting || state.tab !== 'edit') return;
        const hit = elementAt(state.selectedElement);
        const g = hit && hit.rect;
        if (!g || !g.w || !g.h) return;
        const hp = handlePos(g);
        const ctx2 = canvas.getContext('2d');
        ctx2.save();
        ctx2.setTransform(1, 0, 0, 1, 0, 0);
        ctx2.strokeStyle = 'rgba(61,217,176,.95)';
        ctx2.lineWidth = 2;
        ctx2.setLineDash([6, 4]);
        ctx2.strokeRect(g.x, g.y, g.w, g.h);
        // 旋转手柄：框上方圆点 + 连线；缩放手柄：右下角方块
        ctx2.beginPath();
        ctx2.moveTo(hp.rotate.x, hp.rotate.y);
        ctx2.lineTo(g.cx, g.y);
        ctx2.stroke();
        ctx2.setLineDash([]);
        ctx2.beginPath();
        ctx2.arc(hp.rotate.x, hp.rotate.y, hp.r * 0.7, 0, Math.PI * 2);
        ctx2.fillStyle = '#3DD9B0'; ctx2.fill();
        ctx2.strokeStyle = 'rgba(12,25,20,.9)'; ctx2.lineWidth = 1.5; ctx2.stroke();
        ctx2.fillStyle = '#3DD9B0';
        ctx2.fillRect(hp.resize.x - hp.r * 0.6, hp.resize.y - hp.r * 0.6, hp.r * 1.2, hp.r * 1.2);
        ctx2.strokeRect(hp.resize.x - hp.r * 0.6, hp.resize.y - hp.r * 0.6, hp.r * 1.2, hp.r * 1.2);
        ctx2.restore();
    }

    // 双击文字就地编辑：引擎看到 App._textEditor 会跳过同一元素，避免画布字形和输入框重影
    function openTextEditor(line) {
        if (!textEditor || !line) return;
        pushUndo();
        state.editingText = line;
        textOrig = String(line.text || '');
        A._textEditor = { el: line };
        const g = elGeom('text', line);
        const rect = canvas.getBoundingClientRect();
        const stage = canvas.parentElement.getBoundingClientRect();
        const sx = rect.width / Math.max(1, canvas.width);
        const sy = rect.height / Math.max(1, canvas.height);
        const baseW = A._canvasBaseW || canvas.width;
        const scl = canvas.width / Math.max(1, baseW);
        textEditor.value = textOrig;
        textEditor.style.left = (rect.left - stage.left + g.x * sx) + 'px';
        textEditor.style.top = (rect.top - stage.top + g.y * sy) + 'px';
        textEditor.style.width = Math.max(60, g.w * sx + 12) + 'px';
        textEditor.style.height = Math.max(28, g.h * sy + 8) + 'px';
        textEditor.style.fontSize = Math.max(10, (line.fontSize || 48) * scl * sx) + 'px';
        textEditor.style.fontFamily = line.fontFamily || 'Microsoft YaHei';
        textEditor.style.fontWeight = String(line.fontWeight || 400);
        textEditor.style.color = line.colorHex || '#ffffff';
        textEditor.style.transform = `rotate(${numv(line.rotation, 0)}deg)`;
        textEditor.hidden = false;
        textEditor.focus();
        textEditor.select();
    }

    function closeTextEditor(commit) {
        if (!state.editingText) return;
        if (!commit) state.editingText.text = textOrig;
        state.editingText = null;
        A._textEditor = null;
        if (textEditor) { textEditor.hidden = true; textEditor.blur(); }
        renderPreviewSoon();
    }

    if (textEditor) {
        textEditor.addEventListener('input', () => {
            if (!state.editingText) return;
            state.editingText.text = textEditor.value;
            renderPreviewSoon();
        });
        textEditor.addEventListener('blur', () => closeTextEditor(true));
        textEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(true); }
        });
    }

    let elDrag = null;

    // ── 长按画布 = 看原图（松手返回）────────────────────────────────────
    // 只在可编辑页签生效；按住 420ms 且没有位移/捏合才触发，避免和点选、拖动打架。
    let pressTimer = 0, pressStart = null, pressComparing = false;
    function clearPressTimer() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
        pressStart = null;
    }
    function startPressTimer(e) {
        if (!state.image || state.tab === 'puzzle' || state.tab === 'crop') return;
        if (state.tab === 'edit' && state.selectedElement) return;
        pressStart = { x: e.clientX, y: e.clientY };
        window.qfCompareActive = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            pressTimer = 0;
            if (elDrag || pinch || state.editingText || !state.image) return;
            pressComparing = true;
            window.qfCompareActive = true;
            try { window.__render(A, true); } catch (_) { pressComparing = false; }
            if (pressComparing) hint('原图 · 松开返回');
        }, 420);
    }
    function endPressCompare() {
        clearPressTimer();
        if (!pressComparing) return;
        pressComparing = false;
        window.qfCompareActive = false;
        renderPreview();
    }
    function pointerPos(e) {
        const r = canvas.getBoundingClientRect();
        return {
            x: (r.width > 0 ? (e.clientX - r.left) / r.width : 0) * canvas.width,
            y: (r.height > 0 ? (e.clientY - r.top) / r.height : 0) * canvas.height
        };
    }
    canvas.addEventListener('pointerdown', (e) => {
        if (state.exporting || !state.image) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        startPressTimer(e);
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        if (activePointers.size === 2) {
            elDrag = null;
            const [p1, p2] = Array.from(activePointers.values());
            pinch = {
                dist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
                mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
                zoom: viewZoom, pan: { x: viewPan.x, y: viewPan.y }
            };
            hint('缩放预览中');
            return;
        }
        if (activePointers.size > 2) return;
        const pt = pointerPos(e);
        // 拼图 / 切图：画布本身就是操作区，点哪格选哪格，不用再低头找面板里的同名网格
        if (state.tab === 'puzzle' && state.images.length) {
            const nx = pt.x / Math.max(1, canvas.width), ny = pt.y / Math.max(1, canvas.height);
            const rects = (typeof window.__buildPuzzleSlots === 'function')
                ? window.__buildPuzzleSlots(state.puzzle.layout, state.puzzle.axisVals || {}) : [];
            let idx = -1;
            rects.forEach((r, i) => {
                if (nx >= r[0] && nx <= r[0] + r[2] && ny >= r[1] && ny <= r[1] + r[3]) idx = i;
            });
            if (idx >= 0) {
                state.activeSlot = idx;
                // 只更选中态 + 重画画布，别整页重建（2×2/3×3 网格重建会闪一下）
                panel.querySelectorAll('[data-slot]').forEach((b) => {
                    b.classList.toggle('active', Number(b.dataset.slot) === idx);
                });
                renderPreview();
                hint(`已选第 ${idx + 1} 格`);
            }
            return;
        }
        if (state.tab === 'crop') {
            const nx = pt.x / Math.max(1, canvas.width), ny = pt.y / Math.max(1, canvas.height);
            const { rows, cols } = state.crop;
            const c = Math.max(0, Math.min(cols - 1, Math.floor(nx * cols)));
            const r = Math.max(0, Math.min(rows - 1, Math.floor(ny * rows)));
            const i = r * cols + c;
            state.crop.touched = true;
            if (state.crop.picked.has(i)) state.crop.picked.delete(i); else state.crop.picked.add(i);
            const box = panel.querySelector('[data-block="' + i + '"]');
            if (box) box.checked = state.crop.picked.has(i);
            const note = panel.querySelector('.panel-note');
            if (note && state.crop.blocks.length) {
                note.textContent = `已勾选 ${state.crop.picked.size}/${state.crop.blocks.length} 块 · 点右上角「导出块」逐块保存/分享`;
            }
            stageBar(`切图 · ${state.crop.rows}×${state.crop.cols}`,
                `${state.crop.picked.size}/${state.crop.blocks.length} 块`);
            hint(`第 ${i + 1} 块${state.crop.picked.has(i) ? '已勾选' : '已取消'}`);
            return;
        }
        const hh = handleHit(pt);
        if (hh) {
            clearPressTimer();
            pushUndo();
            const o = hh.hit.obj;
            elDrag = {
                mode: hh.mode, obj: o, kind: hh.hit.key.split(':')[0],
                cx: hh.hit.rect.cx, cy: hh.hit.rect.cy,
                startDist: Math.hypot(pt.x - hh.hit.rect.cx, pt.y - hh.hit.rect.cy) || 1,
                origRotation: numv(o.rotation, 0),
                origSize: numv(o.size, 60), origScale: numv(o.scale, 1), origFs: numv(o.fontSize, 48)
            };
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            hint(hh.mode === 'rotate' ? '旋转元素' : '缩放元素');
            return;
        }
        const hit = hitElement(pt);
        if (hit) { clearPressTimer(); pushUndo(); }
        if (!hit) {
            const nowEmpty = Date.now();
            if (nowEmpty - lastEmptyTap < 400 && (viewZoom !== 1 || viewPan.x || viewPan.y)) {
                lastEmptyTap = 0;
                resetView();
                return;
            }
            lastEmptyTap = nowEmpty;
            state.selectedElement = '';
            if (window.QF_EditPanel) window.QF_EditPanel.selectElement('');
            if (state.tab === 'edit') render('edit');
            return;
        }
        const now = Date.now();
        const hitKind = hit.key.split(':')[0];
        if (hitKind === 'text' && lastTap.key === hit.key && now - lastTap.t < 400) {
            lastTap = { t: 0, key: '' };
            elDrag = null;
            openTextEditor(hit.obj);
            return;
        }
        lastTap = { t: now, key: hit.key };
        state.selectedElement = hit.key;
        if (window.QF_EditPanel) window.QF_EditPanel.selectElement(hit.key);
        state.tab = 'edit'; state.editSub = 'element';
        render('edit');
        elDrag = {
            mode: 'move', key: hit.key, obj: hit.obj, kind: hit.key.split(':')[0],
            startX: pt.x, startY: pt.y, cx: hit.rect.cx, cy: hit.rect.cy
        };
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        hint('已选中' + ({ logo: 'Logo', sticker: '贴纸', text: '文字' }[elDrag.kind] || '元素') + '，可拖动');
    });
    canvas.addEventListener('pointermove', (e) => {
        if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 6) clearPressTimer();
        if (activePointers.has(e.pointerId)) {
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        if (pinch && activePointers.size >= 2) {
            const [p1, p2] = Array.from(activePointers.values()).slice(0, 2);
            const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            viewZoom = Math.min(5, Math.max(1, pinch.zoom * d / pinch.dist));
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            viewPan.x = pinch.pan.x + (mid.x - pinch.mid.x);
            viewPan.y = pinch.pan.y + (mid.y - pinch.mid.y);
            applyView();
            return;
        }
        if (!elDrag) return;
        const pt = pointerPos(e);
        const o = elDrag.obj;
        if (elDrag.mode === 'rotate') {
            const a = Math.atan2(pt.y - elDrag.cy, pt.x - elDrag.cx) * 180 / Math.PI;
            o.rotation = Math.round(a + 90);
            renderPreviewSoon();
            return;
        }
        if (elDrag.mode === 'resize') {
            const d = Math.hypot(pt.x - elDrag.cx, pt.y - elDrag.cy);
            const f = Math.min(4, Math.max(0.15, d / elDrag.startDist));
            if (elDrag.kind === 'logo') o.size = Math.max(10, Math.round(elDrag.origSize * f));
            else if (elDrag.kind === 'sticker') o.scale = Math.max(0.1, Math.min(4, elDrag.origScale * f));
            else o.fontSize = Math.max(12, Math.min(240, Math.round(elDrag.origFs * f)));
            renderPreviewSoon();
            return;
        }
        const dx = pt.x - elDrag.startX, dy = pt.y - elDrag.startY;
        const baseW = A._canvasBaseW || canvas.width;
        const scl = canvas.width / Math.max(1, baseW);
        let nx = elDrag.cx + dx, ny = elDrag.cy + dy;
        if (elDrag.kind === 'text') {
            o.x = Math.round(nx / scl);
            o.y = Math.round(ny / scl);
        } else {
            if (elDrag.kind === 'logo') o.rel = 0;
            o.x = Math.round(nx);
            o.y = Math.round(ny);
        }
        renderPreviewSoon();
    });
    const endElDrag = (e) => {
        if (e && e.pointerId != null) activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinch = null;
        elDrag = null;
        endPressCompare();
    };
    canvas.addEventListener('pointerup', endElDrag);
    canvas.addEventListener('pointercancel', endElDrag);
    canvas.addEventListener('dblclick', (e) => {
        const hit = hitElement(pointerPos(e));
        if (hit && hit.key.split(':')[0] === 'text') openTextEditor(hit.obj);
    });

    function paintFallback() {
        const g = canvas.getContext('2d');
        canvas.width = 720; canvas.height = 960;
        const grad = g.createLinearGradient(0, 0, canvas.width, canvas.height);
        grad.addColorStop(0, '#202422'); grad.addColorStop(1, '#181B1A');
        g.fillStyle = grad; g.fillRect(0, 0, canvas.width, canvas.height);
        g.strokeStyle = 'rgba(61,217,176,.25)'; g.lineWidth = 2;
        g.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);
        if (state.image && state.image.el) g.drawImage(state.image.el, 60, 60, canvas.width - 120, canvas.height - 120);
    }

    async function importPhotos() {
        // 连点两次「导入」会同时挂两个 file picker，第一个 Promise 永远不 resolve。
        if (state.exporting || state.importing) return;
        state.importing = true;
        try {
            let list = [];
            try { list = await window.qfsNative.pickImages(); }
            catch (e) { hint('选图失败：' + ((e && e.message) || e), 4200); return; }
            const errs = (typeof window.qfsNative.getPickErrors === 'function')
                ? window.qfsNative.getPickErrors() : [];
            if (!list.length) {
                if (errs.length) hint(`导入失败：${errs[0].name}（${errs[0].error}）`, 4800);
                return;
            }
            const firstImport = state.images.length === 0;
            // 追加而不是替换：拼图照片库要能继续攒图；换照片也不该把已选风格一起清掉。
            state.images = state.images.concat(list);
            state.image = list[0];
            if (firstImport) {
                state.puzzle.slots = {};
                state.images.forEach((im, i) => { state.puzzle.slots[i] = { imageIndex: i }; });
                state.activeSlot = 0;
            } else {
                clampActiveSlot();
            }
            state.crop.picked = new Set();
            state.crop.blocks = [];
            state.crop.touched = false;
            Object.assign(A, { image: state.image, images: state.images, template: state.template });
            scalePresetFonts(state.template, state.image);
            // 换照片后把双指缩放状态清掉，免得新图一上来就是放大的
            viewZoom = 1; viewPan = { x: 0, y: 0 }; applyView();
            const b = stageEmpty.querySelector('b');
            if (b) b.textContent = state.image.name;
            if (errs.length) hint(`已导入 ${list.length} 张，${errs.length} 张失败：${errs[0].name}`, 4800);
            else hint(`已导入 ${list.length} 张 · 照片库共 ${state.images.length} 张`);
            updateEmpty();
            if (state.page !== 'edit') showPage('edit');
            render(state.tab);
        } finally {
            state.importing = false;
        }
    }

    function selectCurrent(i) {
        const im = state.images[i];
        if (!im || im === state.image) return;
        state.image = im;
        state.crop.picked = new Set();
        state.crop.blocks = [];
        state.crop.touched = false;
        Object.assign(A, { image: im, images: state.images, template: state.template });
        scalePresetFonts(state.template, im);
        render(state.tab);
    }

    // 照片库移除：第一下「上膛」，2.8 秒内再点一下才真删。
    // 只动内存里的照片库，手机相册的原图不受影响；槽位索引会跟着前移。
    function removePhoto(i) {
        if (!state.images[i]) return;
        if (state.pendingDel !== i) {
            state.pendingDel = i;
            render('puzzle');
            hint('再点一次 × 移除这张照片');
            setTimeout(() => {
                if (state.pendingDel !== i) return;
                state.pendingDel = -1;
                panel.querySelectorAll('.photo-cell.armed').forEach((c) => {
                    c.classList.remove('armed');
                    const b = c.querySelector('.photo-del');
                    if (b) b.textContent = '×';
                });
            }, 2800);
            return;
        }
        state.pendingDel = -1;
        const gone = state.images[i];
        state.images.splice(i, 1);
        // 槽位里的 imageIndex 跟着前移；指向被删照片的格子直接清空
        const slots = {};
        Object.keys(state.puzzle.slots || {}).forEach((k) => {
            const sc = state.puzzle.slots[k];
            if (!sc) return;
            const idx = Number(sc.imageIndex);
            if (!Number.isFinite(idx)) { slots[k] = sc; return; }
            if (idx === i) return;
            slots[k] = Object.assign({}, sc, { imageIndex: idx > i ? idx - 1 : idx });
        });
        state.puzzle.slots = slots;
        clampActiveSlot();
        state.crop.picked = new Set();
        state.crop.blocks = [];
        state.crop.touched = false;
        if (state.image === gone) {
            state.image = state.images[0] || null;
            if (state.image) {
                scalePresetFonts(state.template, state.image);
                viewZoom = 1; viewPan = { x: 0, y: 0 }; applyView();
            }
        }
        Object.assign(A, { image: state.image, images: state.images, template: state.template });
        render('puzzle');
        if (!state.image) {
            // render 在拼图页不会重画画布；照片删空时手动清成占位底
            paintFallback();
            stageBar('照片库已空', '点 ＋ 重新导入');
            hint('照片库已空，点 ＋ 重新导入');
        } else {
            hint(`已移除 1 张 · 还剩 ${state.images.length} 张`);
        }
    }

    // 预设里的文字字号是按参考短边写死的；换到不同尺寸的照片要跟着缩放，
    // 否则同一款预设在小图上字巨大、在 24MP 原片上字小得看不见。
    const TEXT_REF_EDGE = 2000;
    // 手机预览常驻一张 1600px 代理（im.el 是代理，im.srcW/H 才是原图）。
    // 字号必须按「代理 / 原图」再缩一次，否则预览里的字比最终成片大好几倍；
    // 导出时 withFullImage 把 el 换成全尺寸，下面的 proxy 比例自动回到 1，成片口径不变。
    function proxyRatio(im) {
        const el = (im && im.el) || {};
        const ew = Number(el.naturalWidth) || Number(el.width) || 0;
        const eh = Number(el.naturalHeight) || Number(el.height) || 0;
        const sw = Number(im && im.srcW) || ew;
        const sh = Number(im && im.srcH) || eh;
        if (!ew || !eh || !sw || !sh) return 1;
        return Math.max(0.05, Math.min(1, Math.min(ew, eh) / Math.min(sw, sh)));
    }
    // 面板「文字跟随图片」也要用同一个比例，否则点一次就把预览字号改成成片口径。
    window.qfProxyRatio = proxyRatio;

    // ── 模板绝对像素 → 预览代理尺度 ───────────────────────────────────────
    // 模板里的边距 / 描边 / 齿孔 / 圆角 / 阴影都是按原图像素写的。预览拿 1600 代理当画布，
    // 不折的话 NOMO 这类预设的胶片边会比成片厚 2~3 倍（同一个模板，两种观感）。
    // 导出时 el 即原图，proxyRatio()=1，直接返回原模板，成片一个像素都不动。
    function scaleTplPx(obj, keys, k, min) {
        if (!obj) return;
        for (const key of keys) {
            if (typeof obj[key] !== 'number' || !isFinite(obj[key])) continue;
            const v = Math.round(obj[key] * k);
            obj[key] = min == null ? v : Math.max(min, v);
        }
    }
    function renderTemplate(tpl, im) {
        if (!tpl) return tpl;
        const k = proxyRatio(im);
        if (!(k > 0) || k >= 0.999) return tpl;
        const out = Object.assign({}, tpl);
        if (tpl.baseMargin) {
            out.baseMargin = Object.assign({}, tpl.baseMargin);
            scaleTplPx(out.baseMargin, ['marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                'refTop', 'refBottom', 'refLeft', 'refRight', 'imgOffsetX', 'imgOffsetY'], k);
        }
        if (tpl.cornerConfig) {
            out.cornerConfig = Object.assign({}, tpl.cornerConfig);
            scaleTplPx(out.cornerConfig, ['cornerRadiusAll', 'cornerRadiusTL', 'cornerRadiusTR',
                'cornerRadiusBL', 'cornerRadiusBR'], k, 0);
        }
        if (tpl.filmTearConfig) {
            out.filmTearConfig = Object.assign({}, tpl.filmTearConfig);
            scaleTplPx(out.filmTearConfig, ['filmPerforationSize', 'filmPerforationSpacing'], k, 1);
        }
        if (Array.isArray(tpl.layerList)) {
            out.layerList = tpl.layerList.map((l) => {
                if (!l) return l;
                const nl = Object.assign({}, l);
                scaleTplPx(nl, ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'], k);
                if (l.strokeConfig) {
                    nl.strokeConfig = Object.assign({}, l.strokeConfig);
                    if (typeof nl.strokeConfig.strokeWidth === 'number') {
                        nl.strokeConfig.strokeWidth = Math.max(0, Math.round(nl.strokeConfig.strokeWidth * k * 100) / 100);
                    }
                    if (Array.isArray(nl.strokeConfig.strokeDashArray)) {
                        nl.strokeConfig.strokeDashArray = nl.strokeConfig.strokeDashArray
                            .map((v) => (typeof v === 'number' ? Math.round(v * k * 100) / 100 : v));
                    }
                }
                if (l.shadowGlowConfig) {
                    nl.shadowGlowConfig = Object.assign({}, l.shadowGlowConfig);
                    scaleTplPx(nl.shadowGlowConfig, ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'glowBlur'], k);
                }
                if (l.cornerConfig) {
                    nl.cornerConfig = Object.assign({}, l.cornerConfig);
                    scaleTplPx(nl.cornerConfig, ['cornerRadiusAll', 'cornerRadiusTL', 'cornerRadiusTR',
                        'cornerRadiusBL', 'cornerRadiusBR'], k, 0);
                }
                return nl;
            });
        }
        // decorConfig（文字/贴纸）与 logoElements 是「显示画布口径」的元素，不跟着缩：
        // 字号由 scalePresetFonts 单独换算，坐标是拖动/命中检测用的显示像素。
        return out;
    }
    // 留给回归测试直接验「代理尺度模板」，不用去偷看渲染中途的临时副本
    window.qfScaledTemplate = renderTemplate;
    function scalePresetFonts(tpl, im) {
        if (!tpl || !im) return;
        const el = im.el || {};
        const w = Number(im.srcW) || Number(el.naturalWidth) || Number(im.w) || 0;
        const h = Number(im.srcH) || Number(el.naturalHeight) || Number(im.h) || 0;
        const edge = Math.min(w, h) || TEXT_REF_EDGE;
        const k = Math.max(0.5, Math.min(2.5, edge / TEXT_REF_EDGE));
        const pk = proxyRatio(im);
        // 相框风格里的品牌水印走 autoExifSize(paramFs, 图宽) 做「按图宽自适应」。
        // 这里若把默认 33 改成引擎的 0 档，会再叠加一次 autoPf，宽图上品牌字会大出一倍。
        // 所以预设的 paramFontSize 保持原样，自适应交给引擎已有的那一次换算。
        const lines = (tpl.decorConfig && tpl.decorConfig.textLines) || [];
        lines.forEach((line) => {
            if (!line || line.align === 'exif') return; // exif 行引擎自己有 2000px 基准缩放
            if (line._qfAutoFs == null) line._qfAutoFs = Number(line.fontSize) || 12;
            line.fontSize = Math.max(6, Math.round(line._qfAutoFs * k * pk));
        });
    }

    // 票券/电影票这类风格在预设里显式写空签名，表示「本预设默认不带署名/头像行」，
    // 不能用用户签名把它带出来。名单与桌面同源（StyleCaps）。
    function sigRowOffOf(t) {
        return !!(t && window.StyleCaps && window.StyleCaps.sigRowDefaultOff
            && window.StyleCaps.sigRowDefaultOff(t.photoFrameStyle));
    }

    function applyPreset(p) {
        if (!p) return;
        pushUndo();
        rememberRecent(p);
        // 签名/头像参数：预设没写的键沿用用户当前值，与桌面 mergePreset 同口径。
        // 「头像纪念 / 签名+参数」等预设显式写 avatarShow:1，表示这套风格要带头像；
        // 票根类显式写 avatarShow:0，表示默认不带，不能被上一份模板盖回去。
        const prevT = state.template;
        state.preset = p;
        state.template = clone(p);
        state.template.templateName = p.templateName || p._fileName || '';
        ['userSignature', 'signFont', 'signColor', 'avatarScale', 'signSize',
            'signIncludeModel', 'avatarShow', 'creditMode'].forEach((k) => {
            if (prevT[k] !== undefined && (state.template[k] === undefined || state.template[k] === null)) {
                state.template[k] = prevT[k];
            }
        });
        // 与桌面 mergePreset 同口径：预设里显式写的空签名不能一律当作「不带署名」。
        // 票券/电影票类的空签名是设计的一部分，保持空白；其余风格只是「预设没自带签名」，
        // 用户在「我的 → 昵称与签名」里填的署名要带过去。
        // 署名单独存一份本机偏好：从票券类（空签名）切回签名类时，上一份模板里已经没有
        // 可继承的签名了，只有这份偏好能把用户署名找回来。
        if (!sigRowOffOf(state.template)) {
            const mine = getUserSignature();
            if (mine) state.template.userSignature = mine;
            else if (!state.template.userSignature && prevT && prevT.userSignature) {
                state.template.userSignature = prevT.userSignature;
            }
            if (!state.template.userSignature) state.template.userSignature = '清框影';
        }
        // 不要给没有 photoFrameStyle 的预设补一个风格名：引擎会把未知名字当成
        // 相框风格去查表，结果 23 个「默认图层」预设全变成灰色占位图。
        A.template = state.template;
        scalePresetFonts(state.template, state.image);
        const name = p.templateName || p._fileName || '已套用风格';
        if (state.image) {
            const b = stageEmpty.querySelector('b');
            if (b) b.textContent = name;
            hint(`已套用「${name}」`);
            renderPreview(true);
            stageBar(name, dimsOf(state.image));
        } else {
            hint(`已套用「${name}」，导入照片后生效`);
            stageBar(name, '未导入照片');
        }
        updateEmpty();
        // 只改高亮，不重建整面风格墙：重建会把滚动位置弹回顶部，
        // 用户挑到列表下半部分时每点一次就跳一次。
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            const q = (window.QF_PRESETS || [])[Number(b.dataset.preset)];
            b.classList.toggle('active', q === p);
        });
        const plainBtn = document.getElementById('btnPlainStyle');
        if (plainBtn) plainBtn.classList.remove('active');
    }

    // 回到原图：清空边框/文字/Logo，但保留拼图配置——用户可能只是想去掉相框
    function applyPlainStyle() {
        pushUndo();
        const keepPuzzle = state.template && state.template.puzzle;
        const t = window.qfsNative.defaultTemplate();
        if (keepPuzzle) t.puzzle = keepPuzzle;
        state.preset = null;
        state.template = t;
        A.template = t;
        if (state.image) {
            renderPreview(true);
            stageBar('原图 · 无边框', dimsOf(state.image));
            hint('已去掉风格，回到原图');
        } else {
            stageBar('原图 · 无边框', '未导入照片');
            hint('已回到原图，导入照片后生效');
        }
        updateEmpty();
        panel.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
        const plain = document.getElementById('btnPlainStyle');
        if (plain) plain.classList.add('active');
    }

    // 临时把当前照片换成全尺寸源，渲染导出帧后立即还原。
    // 预览/调色缓存都按 im.el 的尺寸烘焙，换源后必须 invalidateGrade + ensureFullGrade，
    // 否则导出的仍是 1600px 代理放大的糊图。
    async function withFullImage(im, fn) {
        let full = null;
        let prevEl = null, prevW = 0, prevH = 0;
        try {
            if (!im || typeof window.qfFullSource !== 'function') {
                return await fn(1600, false, false);
            }
            hint('正在准备原尺寸…', 12000);
            full = await window.qfFullSource(im);
            if (!full || !full.canvas) return await fn(1600, false, false);
            // 方向：全尺寸重新解出来的是「没转过」的原图，导出前把用户点过的旋转/翻转重放一遍。
            // 先转出新画布再把原画布还回去，避免两张 6000px 同时驻留太久。
            if (im.ops && im.ops.length) {
                const baseCv = full.canvas;
                const turned = bakeOps(baseCv, im.ops);
                if (full.changed && baseCv !== im.el) {
                    try { baseCv.width = 0; baseCv.height = 0; } catch (_) {}
                }
                full = {
                    canvas: turned, changed: true,
                    fallback: !!full.fallback, capped: !!full.capped,
                    release() { try { turned.width = 0; turned.height = 0; } catch (_) {} }
                };
            }
            if (full.changed) {
                prevEl = im.el; prevW = im.w; prevH = im.h;
                im.el = full.canvas;
                im.w = full.canvas.naturalWidth || full.canvas.width;
                im.h = full.canvas.naturalHeight || full.canvas.height;
                // 字体是按代理比例缩过的，换回全尺寸后必须按成片口径重算，
                // 否则导出的字会沿用预览那份缩小后的字号（成片上字变小一半）。
                scalePresetFonts(state.template, im);
                if (typeof A.invalidateGrade === 'function') A.invalidateGrade(im);
                if (typeof window.ensureFullGrade === 'function') window.ensureFullGrade(im);
            }
            const target = Math.max(Number(im.w) || 0, Number(im.h) || 0) || 1600;
            return await fn(target, !!full.fallback, !!full.capped);
        } finally {
            if (prevEl) {
                im.el = prevEl; im.w = prevW; im.h = prevH;
                scalePresetFonts(state.template, im);
                if (typeof A.invalidateGrade === 'function') A.invalidateGrade(im);
            }
            if (full && full.release) full.release();
        }
    }

    // ── 导出选项：长边 / 格式 / 画质，记住上次选择 ───────────────────────
    const EXPORT_PREF_KEY = 'qfm_export';
    // scope: current = 当前照片，all = 照片库里每一张都按现在的风格导一遍
    const exportOpts = { maxEdge: 0, format: 'jpeg', quality: 0.92, scope: 'current' };
    // 只用于提示文案，不进偏好（免得 localStorage 里多一个会过期的张数）
    let exportAllCount = 0;
    try {
        const saved = JSON.parse(localStorage.getItem(EXPORT_PREF_KEY) || '{}');
        if (saved && typeof saved === 'object') Object.assign(exportOpts, saved);
    } catch (_) { /* 坏数据就用默认 */ }
    if (['jpeg', 'png'].indexOf(exportOpts.format) < 0) exportOpts.format = 'jpeg';
    if (['current', 'all'].indexOf(exportOpts.scope) < 0) exportOpts.scope = 'current';
    if (!(Number(exportOpts.quality) > 0 && Number(exportOpts.quality) <= 1)) exportOpts.quality = 0.92;
    exportOpts.maxEdge = Math.max(0, Number(exportOpts.maxEdge) || 0);
    function saveExportOpts() {
        try { localStorage.setItem(EXPORT_PREF_KEY, JSON.stringify(exportOpts)); } catch (_) {}
    }
    function exportMime() { return exportOpts.format === 'png' ? 'image/png' : 'image/jpeg'; }
    function exportExt() { return exportOpts.format === 'png' ? 'png' : 'jpg'; }
    function exportTarget(srcLong) {
        const cap = Number(exportOpts.maxEdge) || 0;
        return cap > 0 ? Math.min(srcLong || cap, cap) : (srcLong || 0);
    }
    function encodeCanvas() {
        return exportOpts.format === 'png'
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', exportOpts.quality);
    }
    const exportSheetEl = document.getElementById('exportSheet');
    function srcLongEdge() {
        const im = state.image;
        if (!im) return 0;
        return Math.max(Number(im.srcW) || 0, Number(im.srcH) || 0)
            || Math.max(Number(im.w) || 0, Number(im.h) || 0);
    }
    function paintExportOpts() {
        const scopeRow = document.getElementById('rowScope');
        if (scopeRow) {
            // 拼图/切图的「全部」语义不同（拼图是整张版式、切图是逐块），不混在一起
            const multi = state.images.length > 1 && state.tab !== 'puzzle' && state.tab !== 'crop';
            scopeRow.hidden = !multi;
            if (!multi) exportOpts.scope = 'current';
            exportAllCount = state.images.length;
            document.querySelectorAll('#optScope .chip').forEach((b) => {
                b.classList.toggle('active', b.dataset.scope === (multi ? exportOpts.scope : 'current'));
                if (b.dataset.scope === 'all') b.textContent = `全部 ${state.images.length} 张`;
            });
        }
        const size = Number(exportOpts.maxEdge) || 0;
        document.querySelectorAll('#optSize .chip').forEach((b) => {
            b.classList.toggle('active', Number(b.dataset.size) === size);
        });
        document.querySelectorAll('#optFormat .chip').forEach((b) => {
            b.classList.toggle('active', b.dataset.format === exportOpts.format);
        });
        document.querySelectorAll('#optQuality .chip').forEach((b) => {
            b.classList.toggle('active', Math.abs(Number(b.dataset.quality) - exportOpts.quality) < 0.001);
        });
        const rowQ = document.getElementById('rowQuality');
        if (rowQ) rowQ.hidden = exportOpts.format === 'png';
        // 主按钮跟着范围走：选「全部」时写清楚要出几张，避免点下去才发现是一整批
        const go = document.getElementById('btnExportGo');
        if (go) {
            const many = exportOpts.scope === 'all' && state.images.length > 1
                && state.tab !== 'puzzle' && state.tab !== 'crop';
            go.textContent = many ? `导出全部 ${state.images.length} 张` : '保存 / 分享';
        }
        const src = srcLongEdge();
        const out = exportTarget(src) || 0;
        const hintEl = document.getElementById('exportHint');
        if (hintEl) {
            const tab = state.tab;
            const subject = tab === 'puzzle' ? '拼图' : tab === 'crop' ? '切图（每块）' : '成品';
            const allNote = (exportOpts.scope === 'all' && exportAllCount > 1)
                ? `全部 ${exportAllCount} 张 · 每张` : '';
            hintEl.textContent = src
                ? `${allNote}${subject}长边 ${out}px · ${exportOpts.format.toUpperCase()}`
                    + (exportOpts.format === 'png' ? ' · 无损' : ` · 画质 ${Math.round(exportOpts.quality * 100)}%`)
                : '先导入一张照片';
        }
    }
    function openExportSheet() {
        if (!state.image && !state.images.length) { hint('先导入照片'); return; }
        if (cropEdit) closeCropEdit(true);
        paintExportOpts();
        exportSheetEl.hidden = false;
    }
    function closeExportSheet() { exportSheetEl.hidden = true; }
    if (exportSheetEl) {
        exportSheetEl.addEventListener('click', (e) => {
            const t = e.target;
            if (t.closest('[data-export-close]') || t.id === 'btnExportCancel') { closeExportSheet(); return; }
            const sizeBtn = t.closest('[data-size]');
            if (sizeBtn) { exportOpts.maxEdge = Number(sizeBtn.dataset.size) || 0; saveExportOpts(); paintExportOpts(); return; }
            const fmtBtn = t.closest('[data-format]');
            if (fmtBtn) { exportOpts.format = fmtBtn.dataset.format; saveExportOpts(); paintExportOpts(); return; }
            const qBtn = t.closest('[data-quality]');
            if (qBtn) { exportOpts.quality = Number(qBtn.dataset.quality) || 0.92; saveExportOpts(); paintExportOpts(); return; }
            const scBtn = t.closest('[data-scope]');
            if (scBtn) { exportOpts.scope = scBtn.dataset.scope === 'all' ? 'all' : 'current'; saveExportOpts(); paintExportOpts(); return; }
            if (t.id === 'btnExportGo') {
                closeExportSheet();
                if (state.tab === 'crop') exportGrid();
                else if (exportOpts.scope === 'all' && state.tab !== 'puzzle' && state.images.length > 1) exportBatch();
                else exportCurrent();
            }
        });
    }

    async function exportCurrent() {
        if (state.exporting) return;
        if (state.editingText) closeTextEditor(true);
        const isPuzzle = state.tab === 'puzzle';
        if (isPuzzle) {
            if (!state.images.length) { hint('先导入照片'); return; }
        } else if (!state.image) { hint('先导入照片'); return; }
        state.exporting = true;
        let data = '';
        let note = '';
        try {
            if (isPuzzle) {
                hint('正在渲染拼图…', 12000);
                // 拼图版式坐标固定在 1000 单位，只有 exportScale 能把成品真正放大到目标长边
                const target = exportTarget(4000) || 4000;
                renderPreview(true, { displayMax: target, uiDprOverride: 1, exportScale: target });
                if (target !== 4000) note = ` · 长边 ${target}px`;
                try { data = encodeCanvas(); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            } else {
                // 先渲染全尺寸帧，再释放原图、编码。编码期间不再占着两张 6000px 画布。
                await withFullImage(state.image, async (targetPx, fallback, capped) => {
                    if (fallback) note = ' · 全尺寸解码失败，已用预览尺寸';
                    else if (capped) note = ' · 已按 6000px 上限导出';
                    const out = Math.max(1, exportTarget(targetPx) || targetPx);
                    if (out !== targetPx) note = ` · 长边 ${out}px`;
                    renderPreview(true, { displayMax: out, uiDprOverride: 1, exportScale: out });
                });
                try { data = encodeCanvas(); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            }
            if (!data || data.length < 64) { hint('导出失败：画布为空'); return; }
            const base = String((state.image && state.image.name) || 'photo')
                .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
            const suffix = isPuzzle ? '_拼图' : '_清框影';
            hint('正在保存…', 12000);
            const r = await window.qfsNative.saveImage(data, `${base}${suffix}.${exportExt()}`);
            if (r && r.canceled) hint('已取消保存');
            else if (r && r.ok) hint((r.mode === 'native' ? '已调起系统分享，可存到相册' : '已下载到本机') + note);
            else hint('保存失败：' + ((r && r.error) || '未知错误'), 4800);
        } catch (e) {
            hint('保存失败：' + ((e && e.message) || e), 4800);
        } finally {
            delete A.exportScale;
            // 导出帧可能是 4000px 拼图/原尺寸，保存结束后切回 1600px 预览，别让大画布常驻
            try { renderPreview(true); } catch (_) {}
            state.exporting = false;
        }
    }

    // 给「不是当前照片」的那一张渲染一帧：renderPreview 读的是 state.image，
    // 批量导出不能为了渲染把界面切来切去（面板会跟着重建、滚动位置也会跳）。
    function renderFrameFor(im, opts) {
        const tpl = renderTemplate(state.template, im);
        Object.assign(A, { dom: { canvas }, image: im, images: state.images, template: tpl }, renderStubs, opts || {});
        if (!opts || !('exportScale' in opts)) delete A.exportScale;
        try {
            if (typeof window.__render === 'function') window.__render(A, false);
        } catch (e) {
            console.warn('[mobile] batch render failed', e);
        } finally {
            A.template = state.template;
        }
    }

    // 批量导出：照片库里每张照片按当前风格（和当前导出设置）各导一张。
    // 原生端先把文件写进缓存、最后一次性调起分享面板——逐张分享会连着弹 N 次系统框。
    async function exportBatch() {
        if (state.exporting) return;
        const list = state.images.slice();
        if (!list.length) { hint('先导入照片'); return; }
        if (state.editingText) closeTextEditor(true);
        state.exporting = true;
        state.batchRunning = true;
        state.batchCancel = false;
        const uris = [];
        let ok = 0, fail = 0;
        const suffix = exportOpts.format === 'png' ? 'png' : 'jpg';
        // 只有原生端能「先攒文件、最后分享一次」；浏览器里 writeCacheFile 返回空，
        // 退回逐张下载（本地调试用）
        const collect = typeof window.qfsNative.writeCacheFile === 'function'
            && typeof window.qfsNative.platform === 'function'
            && window.qfsNative.platform() !== 'web';
        try {
            for (let n = 0; n < list.length; n++) {
                if (state.batchCancel) break;
                const im = list[n];
                hint(`正在导出 ${n + 1}/${list.length}…（再点一次导出可取消）`, 20000);
                // 让出一帧：全尺寸解码是同步重活，不 yield 的话进度提示根本刷不出来
                await new Promise((r) => setTimeout(r, 0));
                try {
                    await withFullImage(im, async (targetPx) => {
                        const out = Math.max(1, exportTarget(targetPx) || targetPx);
                        renderFrameFor(im, { displayMax: out, uiDprOverride: 1, exportScale: out });
                    });
                    const data = encodeCanvas();
                    if (!data || data.length < 64) throw new Error('画布为空');
                    const base = String(im.name || ('photo' + (n + 1)))
                        .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
                    const filename = `${base}_清框影.${suffix}`;
                    if (collect) {
                        const uri = await window.qfsNative.writeCacheFile(data, filename);
                        if (!uri) throw new Error('写入失败');
                        uris.push(uri);
                    } else {
                        const r = await window.qfsNative.saveImage(data, filename);
                        if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
                    }
                    ok += 1;
                } catch (e) {
                    fail += 1;
                    console.warn('[mobile] batch item failed', im && im.name, e);
                }
            }
            if (uris.length) {
                hint('正在打开分享…', 8000);
                const r = await window.qfsNative.shareFiles(uris, `清框影 · ${uris.length} 张`);
                if (r && r.canceled) hint(`已取消分享（${uris.length} 张已生成在缓存里）`, 4200);
                else if (r && r.ok) hint(`已导出 ${ok} 张${fail ? `，${fail} 张失败` : ''}，可存相册或直接发`);
                else hint(`已生成 ${ok} 张，分享失败：${(r && r.error) || '未知错误'}`, 4800);
            } else if (ok) {
                hint(`已导出 ${ok} 张${fail ? `，${fail} 张失败` : ''}`);
            } else if (state.batchCancel) {
                hint('已取消批量导出');
            } else {
                hint('批量导出失败：没有成功的照片', 4800);
            }
        } finally {
            delete A.exportScale;
            // 批量渲染改过 A.image/template，也按别的照片重算过字号：切回当前照片的预览
            try {
                scalePresetFonts(state.template, state.image);
                renderPreview(true);
            } catch (_) {}
            state.exporting = false;
            state.batchRunning = false;
            state.batchCancel = false;
        }
    }

    // 从成品画布切一块（与 app-export.js 的 _sliceGrid 同口径：行优先、无留白）。
    // 逐块生成而不是一次切 9 块：6000px 画布上 9 块加起来又是一整张全尺寸图。
    function sliceOne(src, rows, cols, index, pad, offX, offY) {
        const rn = Math.max(1, Math.min(12, Math.round(rows) || 1));
        const cn = Math.max(1, Math.min(12, Math.round(cols) || 1));
        const p = Math.max(0, pad || 0);
        const ox = Math.max(-40, Math.min(40, Number(offX) || 0)) / 100;
        const oy = Math.max(-40, Math.min(40, Number(offY) || 0)) / 100;
        const sx = Math.round((ox > 0 ? ox : 0) * src.width);
        const sy = Math.round((oy > 0 ? oy : 0) * src.height);
        const sw = Math.max(1, src.width - Math.round(Math.abs(ox) * src.width));
        const sh = Math.max(1, src.height - Math.round(Math.abs(oy) * src.height));
        const r = Math.floor(index / cn), c = index % cn;
        const x = sx + Math.round(c * sw / cn), x2 = sx + Math.round((c + 1) * sw / cn);
        const y = sy + Math.round(r * sh / rn), y2 = sy + Math.round((r + 1) * sh / rn);
        const w = Math.max(1, x2 - x), h = Math.max(1, y2 - y);
        const cv = document.createElement('canvas');
        const g = cv.getContext('2d');
        if (p > 0) {
            cv.width = w + p * 2; cv.height = h + p * 2;
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
            g.drawImage(src, x, y, w, h, p, p, w, h);
        } else {
            cv.width = w; cv.height = h;
            g.drawImage(src, x, y, w, h, 0, 0, w, h);
        }
        return cv;
    }

    // ── 风格收藏：91 款风格横滑找太慢，收藏与搜索都存本地 ─────────────────
    const FAV_KEY = 'qfm_favs';
    const favSet = new Set();
    try {
        (JSON.parse(localStorage.getItem(FAV_KEY) || '[]') || []).forEach((k) => {
            if (k) favSet.add(String(k));
        });
    } catch (_) { /* 坏数据就当没收藏过 */ }
    function favKey(p) { return p ? String(p._fileName || p.templateName || '') : ''; }
    function saveFavs() {
        try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favSet))); } catch (_) {}
    }

    // ── 我的风格：把调好的模板存下来，换照片直接复用，也能用分享码发给别人 ────
    // 存的是「当前模板去掉拼图槽位」：槽位存的是照片索引，换一批照片就会指错人。
    const MY_STYLE_KEY = 'qfm_styles';
    const MY_STYLE_MAX = 12;
    const MY_STYLE_BYTES = 512 * 1024;
    let myStyles = [];
    try {
        const raw = JSON.parse(localStorage.getItem(MY_STYLE_KEY) || '[]');
        if (Array.isArray(raw)) {
            myStyles = raw.filter((x) => x && x.name && x.tpl && typeof x.tpl === 'object').slice(0, MY_STYLE_MAX);
        }
    } catch (_) { myStyles = []; }
    function saveMyStyles() {
        try { localStorage.setItem(MY_STYLE_KEY, JSON.stringify(myStyles)); return true; }
        catch (_) { return false; }
    }
    function myStyleNameSet() { return new Set(myStyles.map((x) => x.name)); }
    function nextStyleName() {
        const used = myStyleNameSet();
        let n = 1;
        while (used.has(`我的风格 ${n}`)) n += 1;
        return `我的风格 ${n}`;
    }
    // 同名时补「2」「3」，导入别人的风格不会把本地的顶掉
    function uniqueStyleName(name) {
        const base = String(name || '导入的风格').trim().slice(0, 18) || '导入的风格';
        const used = myStyleNameSet();
        if (!used.has(base)) return base;
        let n = 2;
        while (used.has(`${base} ${n}`)) n += 1;
        return `${base} ${n}`;
    }
    function styleForSave(name) {
        const t = JSON.parse(JSON.stringify(state.template || {}));
        delete t.puzzle;
        t.templateName = name;
        return t;
    }
    // 封面用离屏画布渲一张小图：存的时候渲一次，之后长廊里不用为了缩略图反复重绘
    function renderStyleCover(tpl) {
        if (!state.image || typeof window.__render !== 'function') return '';
        try {
            const tmp = document.createElement('canvas');
            // 引擎会调 applyZoomStyle/fitZoom，离屏渲染也得带上这组桩，否则相框管线直接抛
            window.__render(Object.assign({
                dom: { canvas: tmp }, image: state.image, images: state.images,
                template: renderTemplate(tpl, state.image)
            }, renderStubs, { displayMax: 260, uiDprOverride: 1 }), false);
            if (!tmp.width || !tmp.height) return '';
            return tmp.toDataURL('image/jpeg', 0.7);
        } catch (e) {
            console.warn('[mobile] cover render failed', e);
            return '';
        }
    }
    function saveMyStyle(name) {
        if (!state.template) { hint('先套一个风格再存'); return; }
        const finalName = String(name || '').trim().slice(0, 18) || nextStyleName();
        const tpl = styleForSave(finalName);
        let size = 0;
        try { size = JSON.stringify(tpl).length; } catch (_) { size = 0; }
        if (size > MY_STYLE_BYTES) {
            hint('这个样式带较大的自定义 Logo（超过 512KB），暂不能存到本机', 4200);
            return;
        }
        const entry = { name: finalName, tpl, cover: renderStyleCover(tpl), at: Date.now() };
        const dup = myStyles.findIndex((x) => x.name === finalName);
        if (dup >= 0) myStyles[dup] = entry;
        else myStyles.unshift(entry);
        if (myStyles.length > MY_STYLE_MAX) myStyles.length = MY_STYLE_MAX;
        if (!saveMyStyles()) { hint('本机存储已满，删掉几个旧风格再试', 4200); return; }
        render('style');
        hint(`已存为「${finalName}」，换照片也能直接套`);
    }
    function applyMyStyle(i) {
        const s = myStyles[i];
        if (!s) return;
        pushUndo();
        const t = JSON.parse(JSON.stringify(s.tpl));
        t.templateName = s.name;
        // 拼图槽位属于「这一批照片」，套样式时保留当前配置
        if (state.template && state.template.puzzle) t.puzzle = state.template.puzzle;
        state.preset = null;
        state.template = t;
        A.template = t;
        scalePresetFonts(t, state.image);
        if (state.image) {
            renderPreview(true);
            stageBar(s.name, dimsOf(state.image));
        } else {
            stageBar(s.name, '未导入照片');
        }
        updateEmpty();
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
        const plain = document.getElementById('btnPlainStyle');
        if (plain) plain.classList.remove('active');
        panel.querySelectorAll('[data-my-style]').forEach((b) => {
            b.classList.toggle('active', Number(b.dataset.myStyle) === i);
        });
        hint(`已套用「${s.name}」`);
    }
    function removeMyStyle(i) {
        const s = myStyles[i];
        if (!s) return;
        myStyles.splice(i, 1);
        saveMyStyles();
        render('style');
        hint(`已删除「${s.name}」`);
    }

    /* ── 分享码：与桌面端同一套 QFSCFG1:<base64> 格式，互导互通 ── */
    function styleShareCode(name) {
        const bundle = {
            v: 1, kind: 'qfs-config', app: 'qingframe-web', name,
            exportedAt: new Date().toISOString(), template: styleForSave(name)
        };
        const bytes = new TextEncoder().encode(JSON.stringify(bundle));
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return 'QFSCFG1:' + btoa(bin);
    }
    function decodeShareCode(text) {
        const raw = String(text || '').replace(/\s+/g, '');
        if (!raw) throw new Error('分享码为空');
        if (raw.indexOf('QFSCFG1:') !== 0) throw new Error('不是有效的分享码（应以 QFSCFG1: 开头）');
        let data;
        try {
            const bin = atob(raw.slice(8));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (_) { throw new Error('分享码内容无法识别，可能没复制完整'); }
        let tpl = data, name = '';
        if (data && data.kind === 'qfs-config' && data.template && typeof data.template === 'object') {
            tpl = data.template; name = String(data.name || '');
        }
        // 模板有三种形态：相框风格(photoFrameStyle)、图层预设(layerList)、
        // 以及贴纸/文字型(layers/aiLayers)。只认前两种会把「极简细线」这类
        // 图层预设误判成坏码，导入静默失败。
        const usable = tpl && typeof tpl === 'object' && (
            typeof tpl.photoFrameStyle === 'string'
            || (Array.isArray(tpl.layerList) && tpl.layerList.length)
            || (Array.isArray(tpl.layers) && tpl.layers.length)
            || (Array.isArray(tpl.aiLayers) && tpl.aiLayers.length)
            || !!tpl.baseMargin || !!tpl.decorConfig || !!tpl.cornerConfig);
        if (!usable) throw new Error('分享码里没有可用的样式');
        return { tpl, name: name || String(tpl.templateName || '导入的风格') };
    }
    function importStyleCode(text) {
        const { tpl, name } = decodeStyleCodeSafe(text);
        if (!tpl) return false;
        tpl.puzzle && delete tpl.puzzle;
        const finalName = uniqueStyleName(name);
        myStyles.unshift({ name: finalName, tpl, cover: renderStyleCover(tpl), at: Date.now() });
        if (myStyles.length > MY_STYLE_MAX) myStyles.length = MY_STYLE_MAX;
        if (!saveMyStyles()) { hint('本机存储已满，删掉几个旧风格再试', 4200); return false; }
        render('style');
        hint(`已导入「${finalName}」`);
        return true;
    }
    function decodeStyleCodeSafe(text) {
        try { return decodeShareCode(text); }
        catch (e) { hint((e && e.message) || '分享码无法识别', 4200); return { tpl: null, name: '' }; }
    }

    /* ── 小弹层：命名 / 分享码 / 删除确认都走这一个，样式复用导出面板那套 ── */
    let styleModalEl = null;
    function closeStyleModal() {
        if (styleModalEl) styleModalEl.remove();
        styleModalEl = null;
    }
    function openStyleModal(spec) {
        closeStyleModal();
        const el = document.createElement('div');
        el.className = 'modal';
        el.id = 'styleModal';
        el.innerHTML = `<div class="modal-mask" data-modal-close></div>
            <div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(spec.title)}">
                <h2>${esc(spec.title)}</h2>${spec.body || ''}
                <div class="modal-acts">${(spec.actions || []).map((a, i) =>
                    `<button type="button" class="act-btn${a.primary ? ' primary' : ''}" data-modal-act="${i}">${esc(a.label)}</button>`).join('')}</div>
            </div>`;
        document.body.appendChild(el);
        styleModalEl = el;
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-modal-close]')) { closeStyleModal(); return; }
            const b = e.target.closest('[data-modal-act]');
            if (!b) return;
            const act = (spec.actions || [])[Number(b.dataset.modalAct)];
            if (act && typeof act.onClick === 'function') act.onClick(el);
        });
        return el;
    }
    function openSaveStyleModal() {
        const def = nextStyleName();
        const el = openStyleModal({
            title: '存为我的风格',
            body: `<input id="styleNameInput" class="modal-input name-input" value="${esc(def)}" maxlength="18" enterkeyhint="done">`
                + `<p class="modal-note">只存边框 / 文字 / 参数，不含照片和拼图槽位；套到别的照片上会按新照片尺寸重算字号。</p>`,
            actions: [
                { label: '取消' },
                { label: '保存', primary: true, onClick: (root) => {
                    const v = (root.querySelector('#styleNameInput').value || '').trim() || def;
                    closeStyleModal();
                    saveMyStyle(v);
                } }
            ]
        });
        const inp = el.querySelector('#styleNameInput');
        if (inp) {
            inp.focus(); inp.select();
            inp.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const v = (inp.value || '').trim() || def;
                closeStyleModal();
                saveMyStyle(v);
            });
        }
    }
    async function openShareCodeModal() {
        if (!state.template) { hint('先套一个风格'); return; }
        const name = (state.template.templateName || '我的风格').trim() || '我的风格';
        let code = '';
        try { code = styleShareCode(name); }
        catch (e) { hint('生成分享码失败：' + ((e && e.message) || e), 4200); return; }
        const el = openStyleModal({
            title: '样式分享码',
            body: `<textarea id="styleCodeBox" class="modal-input code-box" readonly>${esc(code)}</textarea>`
                + `<p class="modal-note" id="styleCodeNote">约 ${Math.round(code.length / 1024)} KB。复制发给朋友，对方在「我的 → 从分享码导入」里粘贴即可。</p>`,
            actions: [
                { label: '关闭' },
                { label: '复制', primary: true, onClick: async () => {
                    try {
                        await navigator.clipboard.writeText(code);
                        hint('分享码已复制');
                        closeStyleModal();
                    } catch (_) {
                        const box = document.getElementById('styleCodeBox');
                        if (box) { box.select(); box.setSelectionRange(0, code.length); }
                        const note = document.getElementById('styleCodeNote');
                        if (note) note.textContent = '自动复制被系统拦下了，已全选，长按「拷贝」即可。';
                    }
                } }
            ]
        });
        try {
            await navigator.clipboard.writeText(code);
            const note = el.querySelector('#styleCodeNote');
            if (note) note.textContent = `约 ${Math.round(code.length / 1024)} KB，已复制到剪贴板。`;
        } catch (_) { /* 拿不到剪贴板就让用户手动复制，不算失败 */ }
    }
    function openImportCodeModal() {
        openStyleModal({
            title: '从分享码导入',
            body: `<textarea id="styleImportBox" class="modal-input code-box" placeholder="粘贴 QFSCFG1: 开头的分享码"></textarea>`
                + `<p class="modal-note">导入后出现在「我的风格」，不会动当前照片。</p>`,
            actions: [
                { label: '取消' },
                { label: '导入', primary: true, onClick: async (root) => {
                    const box = root.querySelector('#styleImportBox');
                    let text = (box && box.value) || '';
                    if (!text.trim()) {
                        try { text = await navigator.clipboard.readText(); } catch (_) { text = ''; }
                    }
                    if (!text.trim()) { hint('先粘贴分享码'); return; }
                    if (importStyleCode(text)) closeStyleModal();
                } }
            ]
        });
    }
    function renameMyStyle(i, name) {
        const s = myStyles[i];
        if (!s) return;
        const finalName = String(name || '').trim().slice(0, 18);
        if (!finalName) { hint('名字不能为空'); return; }
        if (finalName === s.name) return;
        if (myStyles.some((x, k) => k !== i && x.name === finalName)) {
            hint('已经有同名风格了，换个名字'); return;
        }
        s.name = finalName;
        if (s.tpl) s.tpl.templateName = finalName;
        saveMyStyles();
        render('style');
        hint(`已改名为「${finalName}」`);
    }
    function openRenameStyleModal(i) {
        const s = myStyles[i];
        if (!s) return;
        const el = openStyleModal({
            title: '重命名风格',
            body: `<input id="styleRenameInput" class="modal-input name-input" value="${esc(s.name)}" maxlength="18" enterkeyhint="done">`
                + `<p class="modal-note">改完名字后，卡片与分享码都会用新名字。</p>`,
            actions: [
                { label: '取消' },
                { label: '保存', primary: true, onClick: (root) => {
                    const v = (root.querySelector('#styleRenameInput').value || '').trim() || s.name;
                    closeStyleModal();
                    renameMyStyle(i, v);
                } }
            ]
        });
        const inp = el.querySelector('#styleRenameInput');
        if (inp) {
            inp.focus(); inp.select();
            inp.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const v = (inp.value || '').trim() || s.name;
                closeStyleModal();
                renameMyStyle(i, v);
            });
        }
    }
    function openMyStyleActions(i) {
        const s = myStyles[i];
        if (!s) return;
        openStyleModal({
            title: `管理「${s.name}」`,
            body: `<p class="modal-note">可以改名；删除不可撤销，之后只能靠分享码找回。</p>`,
            actions: [
                { label: '取消' },
                { label: '删除', primary: true, onClick: () => { closeStyleModal(); removeMyStyle(i); } },
                { label: '重命名', onClick: () => { closeStyleModal(); openRenameStyleModal(i); } }
            ]
        });
    }
    // 搜索只隐藏卡片、不重建整面墙，输入焦点和滚动位置都不会跳
    function applyStyleQuery() {
        const q = state.query.trim().toLowerCase();
        // 分母取当前面板实际渲染出来的卡数：自建风格也在这里，收藏/分类筛选后也会变，
        // 不能拿内置预设总数硬除，否则会出现「0 / 91 款」却还有卡可见。
        const cells = panel.querySelectorAll('.style-cell[data-q]');
        let n = 0;
        cells.forEach((cell) => {
            const hit = !q || String(cell.dataset.q || '').indexOf(q) >= 0;
            cell.hidden = !hit;
            if (hit) n += 1;
        });
        // 「原图」卡不是风格，搜索时先收起来，免得占着结果位
        const plain = panel.querySelector('[data-plain]');
        if (plain) plain.hidden = !!q;
        const cnt = document.getElementById('styleCount');
        if (cnt) cnt.textContent = `${n} / ${cells.length} 款`;
        const empty = document.getElementById('styleEmpty');
        if (empty) empty.hidden = n > 0;
    }

    function stylePage() {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const tags = ['全部', ...Array.from(new Set(items.map((it) => it.tag).filter(Boolean)))];
        const q = state.query.trim().toLowerCase();
        const all = presets.map((p, i) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const wall = byName.get(p.templateName || p._fileName);
            return { p, i, wall, name, tag: (wall && wall.tag) || '', key: favKey(p) };
        });
        let shown = state.filter === '全部' ? all : all.filter((x) => x.tag === state.filter);
        if (state.favOnly) shown = shown.filter((x) => favSet.has(x.key));
        if (q) shown = shown.filter((x) => (x.name + ' ' + x.tag).toLowerCase().indexOf(q) >= 0);
        const chips = tags.map((t) => `<button class="chip${state.filter === t ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
        const favChip = `<button class="fav-chip${state.favOnly ? ' on' : ''}" data-fav-toggle="1" aria-pressed="${state.favOnly}">★ ${favSet.size}</button>`;
        // 套了风格之后也要能回到「无边框」：放在长廊最前面，用当前照片当封面
        const plainCard = (!q && !state.favOnly && state.filter === '全部')
            ? `<div class="style-cell" data-plain="1">
                   <button class="style-big${!state.preset ? ' active' : ''}" id="btnPlainStyle" type="button" aria-label="原图，无边框">
                       ${state.image ? `<img src="${thumbOf(state.image, 0.5)}" alt="">` : ''}<span>原图 · 无边框</span>
                   </button>
               </div>`
            : '';
        // 横向大卡：封面就是风格效果，点一下立刻套到画布上（实时预览）
        const cards = shown.map(({ p, i, wall, name, tag, key }) => {
            const active = state.preset && state.preset._fileName === p._fileName;
            const cover = wall && wall.cover ? wall.cover : '';
            const on = favSet.has(key);
            return `<div class="style-cell" data-q="${esc((name + ' ' + tag).toLowerCase())}">`
                + `<button class="style-big${active ? ' active' : ''}" data-preset="${i}" aria-label="${esc(name)}">`
                + `${cover ? `<img src="${esc(cover)}" loading="lazy" alt="">` : ''}<span>${esc(name)}</span></button>`
                + `<button class="fav-btn${on ? ' on' : ''}" data-fav="${esc(key)}" aria-label="${on ? '取消收藏' : '收藏'} ${esc(name)}" title="收藏">★</button>`
                + `</div>`;
        }).join('');
        // 我存下来的风格排在内置风格前面（同一根长廊，不额外占一段高度）：
        // 收藏/分类筛选时不掺进来；搜索时按名字一起筛，自建风格不该在结果里隐身。
        const showMine = myStyles.length && !state.favOnly && state.filter === '全部';
        const mineCards = showMine ? myStyles.map((s2, i) =>
            `<div class="style-cell" data-q="${esc((s2.name + ' 我的').toLowerCase())}" data-mine="1">
                <button class="style-big" data-my-style="${i}" aria-label="我的风格 ${esc(s2.name)}">
                    ${s2.cover ? `<img src="${esc(s2.cover)}" alt="">` : ''}<span>${esc(s2.name)}</span>
                    <small class="own-badge">我的</small>
                </button>
            </div>`).join('') : '';
        return `
            <div class="style-head"><h2>选一个风格</h2>
                <div class="head-acts">
                    <span class="style-count" id="styleCount">${shown.length} / ${presets.length} 款</span>
                    <button class="mini-act" id="btnSaveStyle" type="button" aria-label="把当前样式存为我的风格">＋ 存当前</button>
                </div>
            </div>
            ${currentStrip()}
            <div class="style-search">
                <input id="styleQuery" type="search" enterkeyhint="search" placeholder="搜风格或分类，如 拍立得 / 胶片" value="${esc(state.query)}">
                ${favChip}
            </div>
            <div class="chips">${chips}</div>
            <div class="style-rail">${plainCard}${mineCards}${cards}</div>
            <p class="panel-note" id="styleEmpty"${shown.length ? ' hidden' : ''}>没有匹配的风格，换个关键词，或点「★ 收藏」看已收藏的风格。</p>`;
    }

    const PUZZLE_N = { single: 1, h2: 2, v2: 2, as2: 2, h3: 3, v3: 3, grid4: 4, as4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
    const PUZZLE_LABEL = {
        single: '单张', h2: '左右两格', v2: '上下两格', as2: '一大一小',
        h3: '横三格', v3: '竖三格', grid4: '四宫格', as4: '一大多小',
        h4: '横四格', v4: '竖四格', grid6: '六宫格', grid9: '九宫格'
    };
    function puzzleLabel(layout) { return PUZZLE_LABEL[layout] || layout; }
    function clampActiveSlot() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        const i = Number(state.activeSlot) || 0;
        state.activeSlot = Math.min(Math.max(0, i), n - 1);
    }

    function puzzlePage() {
        const layouts = Object.keys(window.PUZZLE_LAYOUT_TYPES || {});
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        const chips = layouts.map((l) => `<button class="chip${state.puzzle.layout === l ? ' active' : ''}" data-layout="${l}">${puzzleLabel(l)}</button>`).join('');
        const cells = Array.from({ length: n }, (_, i) => {
            const sc = state.puzzle.slots[i] || {};
            const im = state.images[sc.imageIndex];
            const t = thumbOf(im, 0.6);
            const thumb = t ? `<img src="${t}" alt="">` : '';
            return `<button class="slot-mini${state.activeSlot === i ? ' active' : ''}" data-slot="${i}" aria-label="第 ${i + 1} 格">`
                + `${thumb}<small>${i + 1}</small></button>`;
        }).join('');
        const photos = state.images.map((im, i) => {
            const armed = state.pendingDel === i;
            return `<span class="photo-cell${armed ? ' armed' : ''}">`
                + `<button class="photo-thumb" data-photo="${i}" title="放入第 ${state.activeSlot + 1} 格"><img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`
                + `<button class="photo-del" data-del-photo="${i}" aria-label="移除第 ${i + 1} 张">${armed ? '!' : '×'}</button>`
                + `</span>`;
        }).join('') + '<button class="photo-add" id="btnAddPhotos" type="button" aria-label="添加照片">＋</button>';
        return `
            <div class="chips">${chips}</div>
            <div class="slot-strip">${cells}</div>
            <div class="puzzle-acts">
                <button id="btnRotateSlot">旋转选中格</button>
                <button id="btnClearSlot">清空选中格</button>
                <button id="btnFillAll">一键铺满</button>
            </div>
            <details class="ctl-group"><summary>版式设置</summary>
                <div class="ctl-row"><label>格子间距</label><input type="range" data-puzzle-opt="gap" min="0" max="30" step="1" value="${Number(state.puzzle.gap) || 0}"><output>${Number(state.puzzle.gap) || 0}</output></div>
                <div class="ctl-row"><label>模糊底色</label><input type="checkbox" data-puzzle-opt="bgMode"${(state.puzzle.bgMode || 0) === 1 ? ' checked' : ''}></div>
                <div class="ctl-row"><label>画布比例</label><select data-puzzle-opt="canvasRatio">
                    ${[['auto', '跟随格子'], ['1:1', '1:1'], ['3:4', '3:4'], ['4:3', '4:3'], ['9:16', '9:16'], ['16:9', '16:9']]
                        .map(([v, l]) => `<option value="${v}"${(state.puzzle.canvasRatio || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('')}
                </select></div>
                <div class="ctl-row"><label>底色</label><input type="color" data-puzzle-opt="borderColor" value="#${String(state.puzzle.borderColor || 'ffffff').replace('#', '')}"></div>
            </details>
            <h2 style="margin-top:14px">照片库 <span class="style-count">${state.images.length} 张</span></h2>
            <div class="photo-strip">${photos}</div>
            <p class="panel-note">点缩略图放进当前格 · 点 × 两下移除（不会动手机原图）</p>`;
    }

    function setLayout(name) {
        if (!PUZZLE_N[name] || state.puzzle.layout === name) return;
        pushUndo();
        state.puzzle.layout = name;
        state.puzzle.axisVals = {};
        clampActiveSlot();
        render('puzzle');
    }
    function assignSlot(i, imageIndex) {
        if (!state.images[imageIndex]) return;
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (i < 0 || i >= n) return;
        pushUndo();
        state.puzzle.slots[i] = { imageIndex, rotate: 0 };
        state.activeSlot = i;
        render('puzzle');
    }
    function fillAll() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (!state.images.length) { hint('先导入照片'); return; }
        const empty = [];
        for (let i = 0; i < n; i++) if (!state.puzzle.slots[i]) empty.push(i);
        if (!empty.length) { hint('格子已经铺满了 · 点单格可换照片'); return; }
        pushUndo();
        empty.forEach((i) => {
            state.puzzle.slots[i] = { imageIndex: i % state.images.length, rotate: 0 };
        });
        clampActiveSlot();
        render('puzzle');
    }

    const GRADE_UI = [
        ['exp', '曝光', -5, 5, 0.01], ['con', '对比度', -100, 100, 1],
        ['hi', '高光', -100, 100, 1], ['sh', '阴影', -100, 100, 1],
        ['white', '白色', -100, 100, 1], ['black', '黑色', -100, 100, 1],
        ['gam', '中间调', -100, 100, 1], ['temp', '色温', -100, 100, 1],
        ['tint', '色调', -100, 100, 1], ['vib', '自然饱和度', -100, 100, 1], ['sat', '饱和度', -100, 100, 1]
    ];

    // ── 我的调色：把当前照片的全局调色存成预设，跨照片复用 ────────────────
    const GRADE_STORE = 'qfm_grades';
    let gradePresets = [];
    try {
        const raw = JSON.parse(localStorage.getItem(GRADE_STORE) || '[]');
        if (Array.isArray(raw)) gradePresets = raw.filter((x) => x && x.name && x.grade).slice(0, 12);
    } catch (_) { gradePresets = []; }
    function saveGradePresets() {
        try { localStorage.setItem(GRADE_STORE, JSON.stringify(gradePresets)); } catch (_) {}
    }
    function gradeHasLook(g) {
        if (!g) return false;
        if (GRADE_UI.some(([k]) => Math.abs(Number(g[k]) || 0) > 1e-6)) return true;
        if (Array.isArray(g.masks) && g.masks.length) return true;
        return ['curve', 'cal', 'det', 'mix', 'cg', 'bw', 'cb', 'gm', 'lc'].some((k) => {
            const v = g[k];
            return v != null && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
        });
    }
    function nextGradeName() {
        const used = new Set(gradePresets.map((p) => p.name));
        let n = 1;
        while (used.has(`调色 ${n}`)) n += 1;
        return `调色 ${n}`;
    }
    function saveGradePreset() {
        if (!state.image) { hint('先导入照片'); return; }
        // 蒙版是「按这张照片的几何」画的，跨图复用会错位；与桌面端一致，不存进预调
        const g = JSON.parse(JSON.stringify(state.image.grade || {}));
        g.masks = [];
        if (!gradeHasLook(g)) { hint('蒙版不会存进预调，先调两下滑块'); return; }
        const name = nextGradeName();
        gradePresets.unshift({ name, grade: g, at: Date.now() });
        gradePresets = gradePresets.slice(0, 12);
        saveGradePresets();
        render('grade');
        hint(`已存为「${name}」`);
    }
    function applyGradePreset(i) {
        const p = gradePresets[i];
        if (!p || !state.image) return;
        pushUndo();
        // 整套替换（不是合并）：避免上一张照片残留的曲线/混色器混进新预调；
        // 旧数据里的蒙版也一并丢掉，防止贴到尺寸不同的照片上。
        const g = JSON.parse(JSON.stringify(p.grade || {}));
        g.masks = [];
        state.image.grade = g;
        delete state.image._gradeCache;
        if (typeof A.invalidateGrade === 'function') A.invalidateGrade(state.image);
        render('grade');
        hint(`已套用「${p.name}」`);
    }
    function removeGradePreset(i) {
        const p = gradePresets[i];
        if (!p) return;
        gradePresets.splice(i, 1);
        saveGradePresets();
        render('grade');
        hint(`已删除「${p.name}」`);
    }

    function gradePresetsHtml() {
        const chips = gradePresets.map((p, i) =>
            `<button class="grade-chip" data-grade-preset="${i}" title="点一下套用，长按删除">${esc(p.name)}</button>`).join('');
        return `<div class="style-head"><h2>我的调色</h2><span class="style-count">${gradePresets.length}/12</span></div>
            <div class="grade-strip">
                <button class="grade-save" id="btnSaveGrade" type="button">＋ 存当前调色</button>
                ${chips}
            </div>`;
    }

    function gradePage() {
        if (!state.image) return `<p class="panel-note">请先导入照片</p>`;
        const g = state.image.grade || {};
        const rows = GRADE_UI.map(([k, label, min, max, step]) => {
            const v = Number(g[k]) || 0;
            return `<div class="grade-row"><label>${label}</label>`
                + `<input type="range" data-grade="${k}" min="${min}" max="${max}" step="${step}" value="${v}">`
                + `<output data-out="${k}">${v}</output></div>`;
        }).join('');
        return `${currentStrip()}
            ${gradePresetsHtml()}
            <div class="text-acts"><button id="btnGradeAuto" type="button">自动调色</button></div>
            <div class="histo-card"><canvas id="gradeHisto" width="600" height="180"></canvas></div>
            <div class="grade-sliders">${rows}</div>
            ${(window.QF_EditPanel && window.QF_EditPanel.fxHtml(state.template)) || ''}
            <div class="puzzle-acts"><button id="btnGradeReset">重置调色</button></div>
            <p class="panel-note">滑块来自桌面调色引擎；直方图实时读取调色后像素。点预调套用，长按删除。</p>`;
    }

    async function exportGrid() {
        if (state.exporting) return;
        if (!state.image) { hint('先导入照片'); return; }
        const rows = state.crop.rows, cols = state.crop.cols;
        const total = rows * cols;
        const picks = Array.from(state.crop.picked)
            .filter((i) => i >= 0 && i < total)
            .sort((a, b) => a - b);
        if (!picks.length) { hint('至少勾选一块'); return; }
        const base = String(state.image.name || 'photo')
            .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
        const tag = `${rows}x${cols}`;
        state.exporting = true;
        // 与批量导出同一组标志：切图导出途中再点一次「导出块」就能停下。
        state.batchRunning = true;
        state.batchCancel = false;
        let ok = 0, fail = 0, canceled = false;
        let note = '';
        try {
            // 切图必须从「加风格/调色后的全尺寸成品」上切；预览画布只有 1600px，
            // 9 块放大到手机相册尺寸会明显糊。渲染完立即还原代理，逐块编码。
            await withFullImage(state.image, async (targetPx, fallback, capped) => {
                if (fallback) note = ' · 全尺寸解码失败，已用预览尺寸';
                else if (capped) note = ' · 已按 6000px 上限导出';
                renderPreview(true, { displayMax: targetPx, uiDprOverride: 1 });
            });
            for (let n = 0; n < picks.length; n++) {
                if (state.batchCancel) { canceled = true; break; }
                const i = picks[n];
                hint(`正在导出 ${n + 1}/${picks.length}…（再点一次导出可取消）`, 20000);
                let block = null;
                try {
                    block = sliceOne(canvas, rows, cols, i, state.crop.pad, state.crop.offX, state.crop.offY);
                    const data = exportOpts.format === 'png'
                        ? block.toDataURL('image/png')
                        : block.toDataURL('image/jpeg', exportOpts.quality);
                    const r = await window.qfsNative.saveImage(data, `${base}_${tag}_${i + 1}.${exportExt()}`);
                    if (r && r.canceled) { canceled = true; break; }
                    if (r && r.ok) ok++; else fail++;
                } catch (_) { fail++; }
                finally {
                    if (block) { block.width = 0; block.height = 0; }
                }
            }
            hint((canceled ? `已取消（已导出 ${ok} 块）`
                : `已导出 ${ok}/${picks.length} 块${fail ? `，${fail} 块失败` : ''}`) + note,
            canceled || fail ? 4200 : 2800);
        } finally {
            delete A.exportScale;
            try { renderPreview(true); } catch (_) {}
            state.exporting = false;
            state.batchRunning = false;
            state.batchCancel = false;
        }
    }

    function cropPage() {
        if (!state.image) {
            state.crop.blocks = [];
            return `<p class="panel-note">请先导入照片</p>`;
        }
        const { rows, cols } = state.crop;
        // 切的是当前成品画布（含风格/调色），不是未处理的原图。
        const src = (canvas && canvas.width) ? canvas : state.image.el;
        const blocks = (typeof A._sliceGrid === 'function' && src)
            ? A._sliceGrid(src, rows, cols, state.crop.pad, state.crop.offX, state.crop.offY) : [];
        state.crop.blocks = blocks;
        if (!state.crop.touched) {
            state.crop.picked = new Set(blocks.map((_, i) => i));
        }
        const valid = new Set(blocks.map((_, i) => i));
        state.crop.picked = new Set(Array.from(state.crop.picked).filter((i) => valid.has(i)));
        const presets = [[3, 3], [2, 2], [4, 4], [3, 4]].map(([r, c]) =>
            `<button class="chip${rows === r && cols === c ? ' active' : ''}" data-grid="${r}x${c}">${r}×${c}</button>`).join('');
        const opts = `<details class="ctl-group"><summary>切图设置</summary>
            <div class="ctl-row"><label>行 / 列</label>
                <input type="number" id="cropRows" min="1" max="12" value="${rows}">
                <input type="number" id="cropCols" min="1" max="12" value="${cols}"></div>
            <div class="ctl-row"><label>留白</label><input type="range" id="cropPad" min="0" max="40" step="1" value="${state.crop.pad}"><output>${state.crop.pad}px</output></div>
            <div class="ctl-row"><label>左右偏移</label><input type="range" id="cropOffX" min="-40" max="40" step="1" value="${state.crop.offX}"><output>${state.crop.offX}%</output></div>
            <div class="ctl-row"><label>上下偏移</label><input type="range" id="cropOffY" min="-40" max="40" step="1" value="${state.crop.offY}"><output>${state.crop.offY}%</output></div>
        </details>`;
        const cells = blocks.map((cv, i) => {
            const t = document.createElement('canvas'); t.width = 96; t.height = 96;
            const g = t.getContext('2d');
            const s = Math.min(cv.width, cv.height);
            if (s > 0) g.drawImage(cv, (cv.width - s) / 2, (cv.height - s) / 2, s, s, 0, 0, 96, 96);
            const checked = state.crop.picked.has(i) ? ' checked' : '';
            return `<label class="crop-cell"><input type="checkbox" data-block="${i}"${checked}>`
                + `<img src="${t.toDataURL('image/jpeg', 0.5)}" alt=""><small>${i + 1}</small></label>`;
        }).join('');
        return `${currentStrip()}
            <div class="chips">${presets}</div>
            ${opts}
            <div class="crop-grid">${cells}</div>
            <p class="panel-note">已勾选 ${state.crop.picked.size}/${blocks.length} 块 · 点右上角「导出块」逐块保存/分享</p>`;
    }

    const EDIT_SUBS = [['photo', '照片'], ['border', '边框'], ['text', '文字'], ['element', '元素'], ['style', '样式']];
    function editPage() {
        const chips = EDIT_SUBS.map(([k, label]) =>
            `<button class="chip${state.editSub === k ? ' active' : ''}" data-edit-sub="${k}">${label}</button>`).join('');
        if (!state.image) {
            return `<div class="chips edit-subs">${chips}</div><p class="panel-note">先导入一张照片，再选一个风格</p>`;
        }
        const body = state.editSub === 'photo'
            ? photoOrientHtml()
            : ((window.QF_EditPanel && window.QF_EditPanel.html(state.editSub, state.template, state.template.photoFrameStyle, {
                baseW: A._canvasBaseW || (state.image && state.image.el && state.image.el.naturalWidth) || 1000,
                baseH: A._canvasBaseH || (state.image && state.image.el && state.image.el.naturalHeight) || 1000
            })) || '<p class="panel-note">编辑面板尚未就绪</p>');
        return `${currentStrip()}
            <div class="chips edit-subs">${chips}</div>
            ${body}`;
    }

    const PAGES = {
        style: stylePage,
        edit: editPage,
        puzzle: puzzlePage,
        grade: gradePage,
        crop: cropPage
    };

    function render(name) {
        if (state.editingText) closeTextEditor(true);
        // 切页签/切照片/撤销都会走到这里：裁剪取景框是临时的，先收掉再重画
        if (cropEdit) closeCropEdit(false);
        state.tab = name || state.tab;
        if (state.tab === 'puzzle') clampActiveSlot();
        // 切页签先把画布画回当前照片，否则从拼图切回风格/调色时会继续显示拼图，
        // 此时点「保存」导出的是上一页的拼图。
        if (state.tab !== 'puzzle' && state.image) renderPreview(true);
        panel.innerHTML = (PAGES[state.tab] || PAGES.style)();
        // 搜索词存在时重画面板（切 tab / 套风格 / 撤销）也要重新收起不匹配的卡，
        // 否则输入框还在显示关键词，墙上的卡却全回来了。
        if (state.tab === 'style') applyStyleQuery();
        document.querySelectorAll('#tabs .tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === state.tab);
        });
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            b.addEventListener('click', () => applyPreset((window.QF_PRESETS || [])[Number(b.dataset.preset)]));
        });
        const plainBtn = document.getElementById('btnPlainStyle');
        if (plainBtn) plainBtn.addEventListener('click', applyPlainStyle);
        panel.querySelectorAll('[data-img-op]').forEach((b) => {
            b.addEventListener('click', () => applyImageOp(b.dataset.imgOp));
        });
        const imgReset = document.getElementById('btnImgReset');
        if (imgReset) imgReset.addEventListener('click', resetImageOps);
        panel.querySelectorAll('[data-crop-ratio]').forEach((b) => {
            b.addEventListener('click', () => setCropRatio(b.dataset.cropRatio));
        });
        const saveStyleBtn = document.getElementById('btnSaveStyle');
        if (saveStyleBtn) saveStyleBtn.addEventListener('click', openSaveStyleModal);
        // 我的风格：轻点套用，长按 650ms 问一句再删（删样式比删调色贵，给一次确认）
        panel.querySelectorAll('[data-my-style]').forEach((b) => {
            const idx = Number(b.dataset.myStyle);
            let hold = 0, fired = false;
            b.addEventListener('pointerdown', () => {
                fired = false;
                clearTimeout(hold);
                hold = setTimeout(() => { fired = true; hold = 0; openMyStyleActions(idx); }, 650);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
                b.addEventListener(ev, () => clearTimeout(hold)));
            b.addEventListener('click', () => {
                clearTimeout(hold);
                if (fired) { fired = false; return; }
                applyMyStyle(idx);
            });
        });
        panel.querySelectorAll('[data-tag]').forEach((b) => {
            b.addEventListener('click', () => { state.filter = b.dataset.tag; render('style'); });
        });
        const qEl = document.getElementById('styleQuery');
        if (qEl) {
            const onQuery = () => { state.query = qEl.value; applyStyleQuery(); };
            qEl.addEventListener('input', onQuery);
            qEl.addEventListener('search', onQuery);
        }
        panel.querySelectorAll('[data-fav-toggle]').forEach((b) => {
            b.addEventListener('click', () => { state.favOnly = !state.favOnly; render('style'); });
        });
        panel.querySelectorAll('[data-fav]').forEach((b) => {
            b.addEventListener('click', () => {
                const k = b.dataset.fav;
                if (!k) return;
                if (favSet.has(k)) favSet.delete(k); else favSet.add(k);
                saveFavs();
                const on = favSet.has(k);
                b.classList.toggle('on', on);
                b.setAttribute('aria-label', on ? '取消收藏' : '收藏');
                const chip = panel.querySelector('[data-fav-toggle]');
                if (chip) {
                    chip.textContent = `★ ${favSet.size}`;
                    chip.classList.toggle('on', state.favOnly);
                }
                // 「只看收藏」里取消收藏，卡片要立刻退场
                if (state.favOnly) render('style');
            });
        });
        panel.querySelectorAll('[data-del-photo]').forEach((b) => {
            b.addEventListener('click', () => removePhoto(Number(b.dataset.delPhoto)));
        });
        const addPhotos = document.getElementById('btnAddPhotos');
        if (addPhotos) addPhotos.addEventListener('click', () => {
            if (state.exporting) return;
            importPhotos();
        });
        panel.querySelectorAll('[data-edit-sub]').forEach((b) => {
            b.addEventListener('click', () => { state.editSub = b.dataset.editSub; render('edit'); });
        });
        if (state.tab === 'edit' && window.QF_EditPanel) {
            window.QF_EditPanel.bind(panel, () => { syncSignaturePref(); renderPreviewSoon(); },
                () => { render('edit'); renderPreviewSoon(); },
                () => { state.preset = null; A.template = state.template; });
        }
        panel.querySelectorAll('[data-layout]').forEach((b) => {
            b.addEventListener('click', () => setLayout(b.dataset.layout));
        });
        panel.querySelectorAll('[data-slot]').forEach((b) => {
            b.addEventListener('click', () => { state.activeSlot = Number(b.dataset.slot); render('puzzle'); });
        });
        panel.querySelectorAll('[data-photo]').forEach((b) => {
            b.addEventListener('click', () => assignSlot(state.activeSlot, Number(b.dataset.photo)));
        });
        panel.querySelectorAll('[data-current]').forEach((b) => {
            b.addEventListener('click', () => selectCurrent(Number(b.dataset.current)));
        });
        const rot = document.getElementById('btnRotateSlot');
        if (rot) rot.addEventListener('click', () => {
            const sc = state.puzzle.slots[state.activeSlot];
            if (!sc) { hint('先选一个已放照片的格子'); return; }
            pushUndo();
            // 引擎里 rotate 是「90° 的倍数」(0..3)，不是角度值。
            sc.rotate = ((Number(sc.rotate) || 0) + 1) % 4;
            renderPreview();
            hint(`第 ${state.activeSlot + 1} 格旋转 ${sc.rotate * 90}°`);
        });
        const clr = document.getElementById('btnClearSlot');
        if (clr) clr.addEventListener('click', () => {
            if (!state.puzzle.slots[state.activeSlot]) { hint('这个格子本来就是空的'); return; }
            pushUndo();
            delete state.puzzle.slots[state.activeSlot];
            render('puzzle');
        });
        const fill = document.getElementById('btnFillAll');
        if (fill) fill.addEventListener('click', fillAll);
        panel.querySelectorAll('[data-puzzle-opt]').forEach((el) => {
            const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const k = el.dataset.puzzleOpt;
                if (k === 'gap') {
                    state.puzzle.gap = Number(el.value) || 0;
                    const out = panel.querySelector('.ctl-row input[data-puzzle-opt="gap"] + output');
                    if (out) out.textContent = String(state.puzzle.gap);
                } else if (k === 'bgMode') state.puzzle.bgMode = el.checked ? 1 : 0;
                else if (k === 'canvasRatio') state.puzzle.canvasRatio = el.value;
                else if (k === 'borderColor') state.puzzle.borderColor = el.value.replace('#', '');
                renderPreviewSoon();
            });
        });

        panel.querySelectorAll('[data-grade]').forEach((b) => {
            b.addEventListener('input', () => {
                const key = b.dataset.grade, v = Number(b.value);
                if (typeof A.setGrade === 'function') A.setGrade({ [key]: v });
                else if (state.image) {
                    state.image.grade = state.image.grade || {};
                    state.image.grade[key] = v;
                }
                const out = panel.querySelector(`[data-out="${key}"]`);
                if (out) out.textContent = String(v);
                renderPreviewSoon();
            });
        });
        const saveG = document.getElementById('btnSaveGrade');
        if (saveG) saveG.addEventListener('click', saveGradePreset);
        // 预调：轻点套用，长按 650ms 删除（删除前不弹窗，靠 toast 告知）
        panel.querySelectorAll('[data-grade-preset]').forEach((b) => {
            const idx = Number(b.dataset.gradePreset);
            let hold = 0, fired = false;
            b.addEventListener('pointerdown', () => {
                fired = false;
                clearTimeout(hold);
                hold = setTimeout(() => { fired = true; hold = 0; removeGradePreset(idx); }, 650);
            });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
                b.addEventListener(ev, () => clearTimeout(hold)));
            b.addEventListener('click', () => {
                clearTimeout(hold);
                if (fired) { fired = false; return; }
                applyGradePreset(idx);
            });
        });
        const gauto = document.getElementById('btnGradeAuto');
        if (gauto) gauto.addEventListener('click', () => {
            if (typeof A.autoGrade !== 'function') { hint('自动调色模块未就绪'); return; }
            if (A.autoGrade() !== false) {
                hint('已按直方图自动调色（可撤销）');
                renderPreviewSoon();
                render('grade');
            }
        });
        if (state.tab === 'grade' && window.QF_EditPanel) {
            window.QF_EditPanel.bindFx(panel, () => renderPreviewSoon(), () => render('grade'), state.template);
        }
        const greset = document.getElementById('btnGradeReset');
        if (greset) greset.addEventListener('click', () => {
            if (typeof A.resetGrade !== 'function') { hint('重置调色模块未就绪'); return; }
            A.resetGrade();
            hint('已重置调色');
            render('grade');
        });
        if (state.tab === 'grade' && window.QfsHistogram && state.image) {
            setTimeout(() => { try { window.QfsHistogram.refresh(state.image); } catch (_) {} }, 30);
        }
        panel.querySelectorAll('[data-grid]').forEach((b) => {
            b.addEventListener('click', () => {
                const [r, c] = b.dataset.grid.split('x').map(Number);
                state.crop.rows = r; state.crop.cols = c;
                state.crop.picked = new Set();
                state.crop.blocks = [];
                state.crop.touched = false;
                const ic = document.getElementById('inpGridCols');
                const ir = document.getElementById('inpGridRows');
                if (ic) ic.value = String(c);
                if (ir) ir.value = String(r);
                render('crop');
            });
        });
        ['cropRows', 'cropCols', 'cropPad', 'cropOffX', 'cropOffY'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => {
                const key = id === 'cropRows' ? 'rows' : id === 'cropCols' ? 'cols'
                    : id === 'cropPad' ? 'pad' : id === 'cropOffX' ? 'offX' : 'offY';
                let v = Number(el.value) || 0;
                if (key === 'rows' || key === 'cols') v = Math.max(1, Math.min(12, v));
                if (key === 'offX' || key === 'offY') v = Math.max(-40, Math.min(40, v));
                state.crop[key] = v;
                state.crop.picked = new Set();
                state.crop.touched = false;
                render('crop');
            });
        });
        panel.querySelectorAll('[data-block]').forEach((b) => {
            b.addEventListener('change', () => {
                const i = Number(b.dataset.block);
                state.crop.touched = true;
                if (b.checked) state.crop.picked.add(i); else state.crop.picked.delete(i);
                const note = panel.querySelector('.panel-note');
                if (note) note.textContent = `已勾选 ${state.crop.picked.size}/${state.crop.blocks.length} 块 · 点右上角「导出块」逐块保存/分享`;
                stageBar(`切图 · ${state.crop.rows}×${state.crop.cols}`,
                    `${state.crop.picked.size}/${state.crop.blocks.length} 块`);
            });
        });

        const pick = document.getElementById('btnPick');
        pick.textContent = '＋';
        const pickLabel = state.tab === 'puzzle' ? '加照片' : '导入照片';
        pick.setAttribute('aria-label', pickLabel);
        pick.title = pickLabel;
        const ex = document.getElementById('btnExport');
        ex.textContent = state.tab === 'crop' ? '导出块'
            : (state.tab === 'puzzle' ? '存拼图' : '导出');
        ex.setAttribute('aria-label', state.tab === 'crop' ? '导出选中块'
            : (state.tab === 'puzzle' ? '保存拼图' : '保存或分享'));
        updateEmpty();
        if (state.tab === 'puzzle') {
            stageBar('拼图 · ' + puzzleLabel(state.puzzle.layout),
                state.images.length ? `${PUZZLE_N[state.puzzle.layout] || 1} 格 · ${state.images.length} 张照片` : '未导入照片');
            if (state.images.length) renderPreview();
        } else if (state.tab === 'crop') {
            stageBar(`切图 · ${state.crop.rows}×${state.crop.cols}`,
                state.image ? `${state.crop.picked.size}/${state.crop.blocks.length} 块` : '未导入照片');
        } else if (state.tab === 'edit') {
            const sub = (EDIT_SUBS.find(([k]) => k === state.editSub) || EDIT_SUBS[0])[1];
            stageBar(state.image ? (state.preset ? presetLabel() : state.image.name) : '编辑',
                state.image ? `编辑 · ${sub} · ${dimsOf(state.image)}` : '未导入照片');
        } else if (state.tab === 'grade') {
            stageBar(state.image ? (state.preset ? presetLabel() : state.image.name) : '调色',
                state.image ? dimsOf(state.image) : '未导入照片');
        } else {
            stageBar(state.preset ? presetLabel() : '选一个风格',
                state.image ? `${dimsOf(state.image)} · ${state.images.length} 张` : '未导入照片');
        }
    }

    // 顶栏导出常驻：切页签只换面板，不换导出按钮的位置
    document.getElementById('btnPick').addEventListener('click', () => {
        if (state.exporting) return;
        importPhotos();
    });
    // 轻点 = 按上次的设置直接导出；长按 = 打开选项（长边/格式/画质）
    const exportBtn = document.getElementById('btnExport');
    let exportHoldTimer = 0;
    let exportHeld = false;
    exportBtn.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        // 导出中不挂长按：这时候点它是「取消批量」，不该再弹设置面板
        if (state.exporting) return;
        exportHeld = false;
        clearTimeout(exportHoldTimer);
        exportHoldTimer = setTimeout(() => { exportHeld = true; openExportSheet(); }, 450);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
        exportBtn.addEventListener(ev, () => clearTimeout(exportHoldTimer)));
    exportBtn.addEventListener('click', () => {
        clearTimeout(exportHoldTimer);
        if (exportHeld) { exportHeld = false; return; }
        // 批量导出跑到一半时，再点一次导出 = 停在第 n 张
        if (state.exporting) {
            if (state.batchRunning) state.batchCancel = true;
            return;
        }
        if (state.tab === 'crop') exportGrid();
        else exportCurrent();
    });

    document.getElementById('tabs').addEventListener('click', (e) => {
        // 导出/切图途中切工具会把画布重画回预览，正在编码的那一帧就废了
        if (state.exporting) return;
        const tab = e.target.closest('.tab');
        if (!tab || !tab.dataset.tab) return;
        if (state.page !== 'edit') showPage('edit');
        render(tab.dataset.tab);
    });

    /* ══ 页面路由：首页 / 编辑 / 我的 ═══════════════════════════════
       首页负责「发现」，编辑页负责「调整」，我的负责「资产与设置」。
       三页共用一条顶栏和一粒胶囊导航，画布只存在于编辑页。 */
    const appEl = document.getElementById('app');
    const pageHome = document.getElementById('pageHome');
    const pageEdit = document.getElementById('pageEdit');
    const pageMine = document.getElementById('pageMine');
    let homePrevPage = 'home';

    function setHeader(title, meta) {
        const n = document.getElementById('hdrName');
        const m = document.getElementById('hdrMeta');
        if (n) n.textContent = title || '';
        if (m) m.textContent = meta || '';
        const img = document.getElementById('hdrThumbImg');
        if (img) {
            const src = state.image ? thumbOf(state.image, 0.5) : '';
            if (src) img.src = src; else img.removeAttribute('src');
        }
    }
    function showPage(page) {
        if (['home', 'edit', 'mine'].indexOf(page) < 0) page = 'home';
        if (page !== 'home' && state.page !== page) homePrevPage = state.page || 'home';
        if (page !== 'edit' && cropEdit) closeCropEdit(false);
        state.page = page;
        appEl.dataset.page = page;
        pageHome.hidden = page !== 'home';
        pageEdit.hidden = page !== 'edit';
        pageMine.hidden = page !== 'mine';
        document.querySelectorAll('#tabbar .nav-item').forEach((b) => {
            b.classList.toggle('active', b.dataset.page === page);
        });
        if (page === 'home') {
            setHeader('清框影', '为摄影爱好者提供最好的边框');
            renderHome();
            return;
        }
        if (page === 'mine') {
            setHeader('我的', '本地处理 · 无账号');
            refreshMine();
            return;
        }
        // 编辑页：重画一次画布，并把顶栏切回「风格名 + 尺寸」
        currentStrip();
        renderPreview(true);
        const styleName = (state.template && state.template.templateName) || '';
        stageBar(state.image ? (styleName || state.image.name) : '未选择风格',
            state.image ? `${dimsOf(state.image)} · ${state.images.length} 张照片` : '先导入一张照片');
        updateUndoUI();
    }

    /* ── 首页：一条纵向信息流，每段是一排横滑卡 ─────────────────── */
    function coverOf(im, edge) {
        if (!im || !im.el) return '';
        const key = '_cover' + edge;
        if (im[key]) return im[key];
        try {
            const iw = im.el.naturalWidth || im.el.width || 0;
            const ih = im.el.naturalHeight || im.el.height || 0;
            if (!iw || !ih) return '';
            const k = Math.min(1, edge / Math.max(iw, ih));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(iw * k));
            c.height = Math.max(1, Math.round(ih * k));
            c.getContext('2d').drawImage(im.el, 0, 0, c.width, c.height);
            im[key] = c.toDataURL('image/jpeg', 0.72);
            return im[key];
        } catch (_) { return ''; }
    }
    // 首页大图直接用画布上的「成品帧」：用户看到的就是刚才那张带边框的照片，
    // 而不是原始底图 —— 比再开一条离屏渲染便宜，也更符合「继续编辑」的语义。
    function styledCover() {
        try {
            if (!canvas || !canvas.width || !state.image) return '';
            const k = Math.min(1, 720 / Math.max(canvas.width, canvas.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(canvas.width * k));
            c.height = Math.max(1, Math.round(canvas.height * k));
            c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.72);
        } catch (_) { return ''; }
    }
    function wallOf(name) {
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        return items.find((it) => it.preset === name) || null;
    }
    function homeCardHtml(idx, name, cover, tag) {
        return `<button class="home-card" type="button" data-home-preset="${idx}" aria-label="${esc(name)}">`
            + `${cover ? `<img src="${esc(cover)}" loading="lazy" alt="">` : ''}`
            + `${tag ? `<span class="home-card-badge">${esc(tag)}</span>` : ''}`
            + `<span class="home-card-name">${esc(name)}</span></button>`;
    }
    function myCardHtml(i, s2) {
        return `<button class="home-card" type="button" data-home-my="${i}" aria-label="${esc(s2.name)}">`
            + `${s2.cover ? `<img src="${esc(s2.cover)}" loading="lazy" alt="">` : ''}`
            + `<span class="home-card-badge">我的</span>`
            + `<span class="home-card-name">${esc(s2.name)}</span></button>`;
    }
    function homeSection(title, tag, cards, more, muted, filterTag) {
        if (!cards) return '';
        return `<section class="home-section">
            <div class="home-sec-head"><h3>${esc(title)}</h3>${tag ? `<span class="home-sec-tag${muted ? ' muted' : ''}">${esc(tag)}</span>` : ''}
            ${more ? `<button class="home-sec-more" type="button" data-open-styles data-tag="${esc(filterTag || '')}">${esc(more)}</button>` : ''}</div>
            <div class="home-rail">${cards}</div></section>`;
    }
    const RECENT_KEY = 'qfm_recent';
    let recentKeys = [];
    try { recentKeys = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(Boolean).slice(0, 8); }
    catch (_) { recentKeys = []; }
    function rememberRecent(p) {
        const key = favKey(p);
        if (!key) return;
        recentKeys = [key, ...recentKeys.filter((k) => k !== key)].slice(0, 8);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentKeys)); } catch (_) {}
    }
    function homeRecentHtml() {
        if (!recentKeys.length) return '';
        const presets = window.QF_PRESETS || [];
        const byKey = new Map(presets.map((p, i) => [favKey(p), i]));
        const cards = recentKeys.map((k) => {
            const i = byKey.get(k);
            if (i == null) return '';
            const p = presets[i];
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const wall = wallOf(name);
            return homeCardHtml(i, name, wall && wall.cover, '');
        }).join('');
        return homeSection('最近使用', '', cards, '全部风格 ›');
    }
    function homeMineHtml() {
        if (!myStyles.length) return '';
        const cards = myStyles.slice(0, 8).map((s2, i) => myCardHtml(i, s2)).join('');
        return homeSection('我的风格', `${myStyles.length} 个`, cards, '管理 ›');
    }
    function homeTagSections() {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const counts = new Map();
        items.forEach((it) => { if (it.tag) counts.set(it.tag, (counts.get(it.tag) || 0) + 1); });
        // 分类顺序按「编辑推荐」而不是纯数量：数量排序会让「个性」这种泛分类排在最前
        const pref = ['经典', '胶片', '拍立得', '水印', '极简', '复古', '黑白', '艺术', '个性'];
        const rank = (t) => { const i = pref.indexOf(t); return i < 0 ? 99 : i; };
        // 首页就是完整风格目录：所有分类、每组全部预设都要露出。
        // 横滑 rail 只影响「一屏看到几张」，不该把没滑到的预设直接砍掉。
        return Array.from(counts.entries())
            .sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1] - a[1]))
            .map(([tag, n]) => {
                const cards = [];
                presets.forEach((p, i) => {
                    const name = p.templateName || p._fileName || '';
                    const wall = byName.get(name);
                    if (!wall || wall.tag !== tag) return;
                    cards.push(homeCardHtml(i, name, wall.cover, ''));
                });
                return homeSection(tag, `${n} 款`, cards.join(''), '全部 ›', true, tag);
            }).join('');
    }
    function homeSearchHtml(q) {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const hits = [];
        presets.forEach((p, i) => {
            const name = p.templateName || p._fileName || '';
            const wall = byName.get(name);
            const tag = (wall && wall.tag) || '';
            if ((name + ' ' + tag).toLowerCase().indexOf(q) >= 0) hits.push(homeCardHtml(i, name, wall && wall.cover, tag));
        });
        myStyles.forEach((s2, i) => {
            if (s2.name.toLowerCase().indexOf(q) >= 0) hits.push(myCardHtml(i, s2));
        });
        if (!hits.length) return '<p class="home-empty">没有匹配的风格，换个关键词试试。</p>';
        return `<section class="home-section">
            <div class="home-sec-head"><h3>搜索结果</h3><span class="home-sec-tag">${hits.length}</span></div>
            <div class="home-grid">${hits.join('')}</div></section>`;
    }
    function renderHome() {
        const hero = document.getElementById('homeHero');
        const im = state.image;
        if (hero) {
            if (im) {
                // 左文右图：缩略图用 contain，边框不会被 hero 的横条比例裁掉
                const bg = styledCover() || coverOf(im, 900);
                hero.className = 'home-hero filled';
                hero.style.backgroundImage = '';
                hero.innerHTML = `<div class="hero-txt">
                        <div class="hero-kicker">继续编辑</div>
                        <h2>${esc((state.template && state.template.templateName) || '未套用风格')}</h2>
                        <p>${esc(dimsOf(im))} · ${state.images.length} 张照片</p>
                        <button class="hero-btn" type="button" data-goto-edit>回到编辑</button>
                    </div>
                    ${bg ? `<img class="hero-thumb" src="${esc(bg)}" alt="当前成品">` : ''}`;
            } else {
                hero.className = 'home-hero is-empty';
                hero.style.backgroundImage = '';
                // 空态只留一条引导：首屏优先给风格，别让一张 136px 的卡把列表压到第二屏
                hero.innerHTML = `<div class="hero-txt">
                        <h2>给照片一个边框</h2>
                        <p>${(window.QF_PRESETS || []).length} 款风格 · 相机参数水印 · 本地处理</p>
                    </div>
                    <button class="hero-btn" type="button" data-pick>导入照片</button>`;
            }
        }
        const host = document.getElementById('homeSections');
        if (!host) return;
        const q = (state.homeQuery || '').trim().toLowerCase();
        if (q) { host.innerHTML = homeSearchHtml(q); return; }
        host.innerHTML = [homeRecentHtml(), homeMineHtml(), homeTagSections()].filter(Boolean).join('')
            || '<p class="home-empty">风格库还没加载好，稍后再试。</p>';
    }

    /* ── 我的：资产与设置 ───────────────────────────────────────── */
    function refreshMine() {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('mineStylesCount', String(myStyles.length));
        set('mineGradesCount', String(gradePresets.length));
        set('minePhotosCount', String(state.images.length));
        set('mineExportSum', `${exportOpts.maxEdge ? exportOpts.maxEdge + 'px' : '原图'} · ${exportOpts.format.toUpperCase()}`);
        set('mineProfileSum', getUserName() || '未设置');
        set('mineFocalSum', (state.template && state.template.focalEq === 1) ? '等效焦距' : '原始焦距');
        set('minePlatform', window.qfsNative.platform());
    }

    /* ── 用户资料：昵称/署名只存本机，头像沿用 QF_Avatar ─────────── */
    const USER_NAME_KEY = 'qfm_user_name';
    const USER_SIGN_KEY = 'qfm_user_signature';
    function getUserName() {
        try { return localStorage.getItem(USER_NAME_KEY) || ''; } catch (_) { return ''; }
    }
    function setUserName(v) {
        try { localStorage.setItem(USER_NAME_KEY, v); } catch (_) {}
    }
    function getUserSignature() {
        try { return localStorage.getItem(USER_SIGN_KEY) || ''; } catch (_) { return ''; }
    }
    function setUserSignature(v) {
        try {
            if (v) localStorage.setItem(USER_SIGN_KEY, v);
            else localStorage.removeItem(USER_SIGN_KEY);
        } catch (_) {}
    }
    // 编辑页「署名内容」也能改署名，改完同步回偏好，切预设时才不会退回旧值。
    // 票券类的空签名是设计的一部分，不参与同步。
    function syncSignaturePref() {
        const t = state.template;
        if (!t || sigRowOffOf(t)) return;
        setUserSignature(String(t.userSignature || ''));
    }
    function openProfileModal() {
        const name = getUserName();
        const sig = getUserSignature() || (state.template && state.template.userSignature) || '';
        const el = openStyleModal({
            title: '昵称与签名',
            body: `<input id="profileName" class="modal-input name-input" value="${esc(name)}" maxlength="18" placeholder="昵称（只存在本机）">`
                + `<textarea id="profileSign" class="modal-input" rows="2" maxlength="24" placeholder="照片署名，如 © 2026 张三">${esc(sig)}</textarea>`
                + `<p class="modal-note">昵称只存在本机；署名写进当前风格，供「签名 + 头像」等预设使用。票券类预设默认不显示署名。</p>`,
            actions: [
                { label: '取消' },
                { label: '保存', primary: true, onClick: (root) => {
                    const n = (root.querySelector('#profileName').value || '').trim().slice(0, 18);
                    const s = (root.querySelector('#profileSign').value || '').trim().slice(0, 24);
                    closeStyleModal();
                    saveProfile(n, s);
                } }
            ]
        });
        const inp = el.querySelector('#profileName');
        if (inp) { inp.focus(); inp.select(); }
    }
    function saveProfile(name, signature) {
        setUserName(name);
        setUserSignature(signature);
        if (state.template) {
            // 署名优先；没填署名时用昵称；两者都清空则回到默认「清框影」。
            // 用户手动清空输入框就是明确要清掉旧署名，不该悄悄留着上一版。
            state.template.userSignature = signature || name || '清框影';
            A.template = state.template;
            renderPreview(true);
        }
        refreshMine();
        if (window.QF_Avatar) window.QF_Avatar.updateUI();
        hint(name || signature ? '昵称与署名已保存到本机' : '已清空昵称与署名');
    }

    function toggleFocalType() {
        if (!state.template) { hint('先套一个风格'); return; }
        state.template.focalEq = state.template.focalEq === 1 ? 0 : 1;
        A.template = state.template;
        renderPreview(true);
        refreshMine();
        hint(state.template.focalEq === 1 ? '已启用 35mm 等效焦距' : '已恢复原始焦距');
    }

    function openLegalModal(title, html) {
        openStyleModal({
            title,
            body: `<div class="legal-text">${html}</div>`,
            actions: [{ label: '知道了', primary: true, onClick: () => closeStyleModal() }]
        });
    }

    // 首页交互：卡片直接套用并进编辑页
    pageHome.addEventListener('click', (e) => {
        const card = e.target.closest('[data-home-preset]');
        if (card) {
            const p = (window.QF_PRESETS || [])[Number(card.dataset.homePreset)];
            if (p) { applyPreset(p); showPage('edit'); }
            return;
        }
        const mine = e.target.closest('[data-home-my]');
        if (mine) { applyMyStyle(Number(mine.dataset.homeMy)); showPage('edit'); return; }
        if (e.target.closest('[data-pick]')) { importPhotos(); return; }
        if (e.target.closest('[data-goto-edit]')) { showPage('edit'); return; }
        const more = e.target.closest('[data-open-styles]');
        if (more) {
            // 「全部 ›」带着分区名进风格工具，直接落到该分类，而不是回到「全部」
            state.filter = more.dataset.tag || '全部';
            showPage('edit');
            render('style');
        }
    });
    const homeQueryEl = document.getElementById('homeQuery');
    if (homeQueryEl) {
        homeQueryEl.addEventListener('input', () => {
            state.homeQuery = homeQueryEl.value || '';
            renderHome();
        });
    }

    // 导航 / 顶栏
    document.getElementById('tabbar').addEventListener('click', (e) => {
        const b = e.target.closest('.nav-item');
        if (b) showPage(b.dataset.page);
    });
    document.getElementById('btnBack').addEventListener('click', () => {
        // 已经在首页：返回键当作「回到顶部」，而不是点了个寂寞
        if (state.page === 'home') {
            const sc = document.getElementById('homeScroll');
            // 直接赋值：平滑滚动在隐藏窗口/原生 WebView 里可能不触发，点了就像没反应
            if (sc) sc.scrollTop = 0;
            return;
        }
        showPage(state.page === 'mine' ? (homePrevPage || 'home') : 'home');
    });
    document.getElementById('btnSettings').addEventListener('click', () => showPage('mine'));
    document.getElementById('panelGrip').addEventListener('click', () => {
        const page = document.getElementById('pageEdit');
        const on = page.classList.toggle('expanded');
        hint(on ? '面板已展开' : '面板已收起');
    });
    document.getElementById('hdrThumb').addEventListener('click', () => showPage('edit'));
    const filmstripEl = document.getElementById('filmstrip');
    if (filmstripEl) {
        filmstripEl.addEventListener('click', (e) => {
            if (e.target.closest('[data-film-add]')) { importPhotos(); return; }
            const b = e.target.closest('[data-current]');
            if (b) selectCurrent(Number(b.dataset.current));
        });
    }

    // 我的页入口
    document.getElementById('btnOpenExport').addEventListener('click', openExportSheet);
    document.getElementById('btnShareStyle').addEventListener('click', openShareCodeModal);
    document.getElementById('btnImportStyle').addEventListener('click', openImportCodeModal);
    document.getElementById('mineStylesRow').addEventListener('click', () => { showPage('edit'); render('style'); });
    document.getElementById('mineGradesRow').addEventListener('click', () => { showPage('edit'); render('grade'); });
    document.getElementById('minePhotosRow').addEventListener('click', () => { showPage('edit'); render('puzzle'); });
    document.getElementById('mineProfileRow').addEventListener('click', openProfileModal);
    document.getElementById('mineFocalRow').addEventListener('click', toggleFocalType);
    document.getElementById('mineLogoRow').addEventListener('click', () => {
        showPage('edit');
        // 元素页不是独立 tab，是编辑 tab 下的一个子页；直接 render('element') 会掉回风格页
        state.tab = 'edit';
        state.editSub = 'element';
        render('edit');
        hint('在这里添加 Logo 文字，画布上可直接拖动');
    });
    document.getElementById('btnUserTerms').addEventListener('click', () => openLegalModal('用户协议',
        '<b>使用范围</b>清框影是本地照片加框工具，供个人合法使用。导入的照片、调好的风格与署名都只处理在本机。'
        + '<b>你的内容</b>你保留照片与成片的所有权利。软件不上传照片、不要求账号，也不会替你发布内容。'
        + '<b>免责</b>软件按“现状”提供；请自行确认导出成片的使用场景符合当地法律与他人权利。'
        + '<b>反馈</b>问题与建议可通过项目 Issues 提出。'));
    document.getElementById('btnPrivacy').addEventListener('click', () => openLegalModal('隐私政策',
        '<b>照片与资料</b>照片、风格、昵称、头像与署名都在本机处理与保存，不上传本项目服务器。'
        + '<b>账号</b>没有账号体系，也不收集登录信息、分析数据或埋点。'
        + '<b>本机存储</b>设置、模板、头像等保存在应用数据目录；卸载时系统可能保留这些文件，需要可手动清除。'
        + '<b>网络</b>手机版不主动联网；分享码由你手动复制发给别人，是否发送完全由你决定。'
        + '<b>联系</b>隐私问题可通过项目 Issues 提出。'));
    document.getElementById('btnAbout').addEventListener('click', () => openLegalModal('关于我们',
        '<b>清框影</b>为摄影爱好者提供最好的边框。照片全程本地处理，不上传、不需要账号。'
        + '<b>版本</b>0.1 · 内测版。'
        + '<b>能力</b>风格墙、调色、拼图与切图、自定义署名与头像、分享码互通。'));

    // 用户头像：加载本机头像，换头像后重绘预览（引擎读 window.__qfsAvatarImg）
    if (window.QF_Avatar) window.QF_Avatar.bind({ onChange: () => renderPreview(true), hint });

    // 有引擎时先用它，否则降级自绘
    if (typeof window.__render !== 'function') paintFallback();
    updateEmpty();
    render('style');
    updateUndoUI();
    showPage('home');
    window.QF_MOBILE_READY = true;
})();
