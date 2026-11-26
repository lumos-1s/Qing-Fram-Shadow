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
        tab: 'style', editSub: 'border', selectedElement: '', editingText: null,
        filter: '全部', activeSlot: 0, importing: false, exporting: false,
        puzzle: { enabled: 1, layout: 'grid4', gap: 6, bgMode: 0, canvasRatio: 'auto', borderColor: 'ffffff', slots: {} },
        crop: { rows: 3, cols: 3, pad: 0, offX: 0, offY: 0, picked: new Set(), blocks: [], touched: false }
    };

    const textEditor = document.getElementById('textEditor');
    let textOrig = '';
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
    function currentStrip() {
        if (state.images.length < 2) return '';
        const items = state.images.map((im, i) => {
            const active = im === state.image ? ' active' : '';
            return `<button class="photo-thumb${active}" data-current="${i}" title="${esc(im.name)}">`
                + `<img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`;
        }).join('');
        return `<div class="photo-strip current-strip">${items}</div>`;
    }
    function presetLabel() {
        return (state.preset && (state.preset.templateName || state.preset._fileName)) || '已套用风格';
    }
    // 顶栏就是新的「状态条」：风格名 + 尺寸/张数，导出固定在右侧。
    // 保留 stageBar(name, meta) 这个老接口，各页签的调用一行都不用改。
    function stageBar(name, meta) {
        const n = document.getElementById('hdrName');
        const m = document.getElementById('hdrMeta');
        if (n) n.textContent = name || '未选择风格';
        if (m) m.textContent = meta || '—';
        const th = document.getElementById('hdrThumb');
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

    function applyPreset(p) {
        if (!p) return;
        state.preset = p;
        state.template = clone(p);
        state.template.templateName = p.templateName || p._fileName || '';
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
                // 拼图版式坐标固定在 1000 单位，只有 exportScale 能把成品真正放大到 4000px
                renderPreview(true, { displayMax: 4000, uiDprOverride: 1, exportScale: 4000 });
                try { data = canvas.toDataURL('image/jpeg', 0.92); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            } else {
                // 先渲染全尺寸帧，再释放原图、编码。编码期间不再占着两张 6000px 画布。
                await withFullImage(state.image, async (targetPx, fallback, capped) => {
                    if (fallback) note = ' · 全尺寸解码失败，已用预览尺寸';
                    else if (capped) note = ' · 已按 6000px 上限导出';
                    renderPreview(true, { displayMax: targetPx, uiDprOverride: 1 });
                });
                try { data = canvas.toDataURL('image/jpeg', 0.92); }
                catch (e) { hint('导出失败：' + ((e && e.message) || e), 4200); return; }
            }
            if (!data || data.length < 64) { hint('导出失败：画布为空'); return; }
            const base = String((state.image && state.image.name) || 'photo')
                .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
            const suffix = isPuzzle ? '_拼图' : '_清框影';
            hint('正在保存…', 12000);
            const r = await window.qfsNative.saveImage(data, `${base}${suffix}.jpg`);
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

    function stylePage() {
        const presets = window.QF_PRESETS || [];
        const items = (window.QF_WALL && window.QF_WALL.items) || [];
        const byName = new Map(items.map((it) => [it.preset, it]));
        const tags = ['全部', ...Array.from(new Set(items.map((it) => it.tag).filter(Boolean)))];
        const all = presets.map((p, i) => ({ p, i, wall: byName.get(p.templateName || p._fileName) }));
        const shown = state.filter === '全部' ? all : all.filter((x) => x.wall && x.wall.tag === state.filter);
        const chips = tags.map((t) => `<button class="chip${state.filter === t ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
        // 横向大卡：封面就是风格效果，点一下立刻套到画布上（实时预览）
        const cards = shown.map(({ p, i, wall }) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const active = state.preset && state.preset._fileName === p._fileName;
            const cover = wall && wall.cover ? wall.cover : '';
            return `<button class="style-big${active ? ' active' : ''}" data-preset="${i}" aria-label="${esc(name)}">`
                + `${cover ? `<img src="${esc(cover)}" loading="lazy" alt="">` : ''}<span>${esc(name)}</span></button>`;
        }).join('');
        return `
            <div class="style-head"><h2>选一个风格</h2><span class="style-count">${shown.length} / ${presets.length} 款</span></div>
            ${currentStrip()}
            <div class="chips">${chips}</div>
            <div class="style-rail">${cards || '<p class="panel-note">这个分类下暂无风格</p>'}</div>`;
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
            return `<button class="slot${state.activeSlot === i ? ' active' : ''}" data-slot="${i}">`
                + `${thumb || '<span>空格</span>'}<small>${i + 1}</small></button>`;
        }).join('');
        const photos = state.images.map((im, i) => {
            return `<button class="photo-thumb" data-photo="${i}"><img src="${thumbOf(im, 0.5)}" alt=""><small>${i + 1}</small></button>`;
        }).join('');
        return `
            <div class="chips">${chips}</div>
            <div class="puzzle-grid">${cells}</div>
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
            <h2 style="margin-top:14px">照片库</h2>
            <div class="photo-strip">${photos || '<p class="panel-note">先导入照片</p>'}</div>`;
    }

    function setLayout(name) {
        if (!PUZZLE_N[name]) return;
        state.puzzle.layout = name;
        state.puzzle.axisVals = {};
        clampActiveSlot();
        render('puzzle');
    }
    function assignSlot(i, imageIndex) {
        if (!state.images[imageIndex]) return;
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (i < 0 || i >= n) return;
        state.puzzle.slots[i] = { imageIndex, rotate: 0 };
        state.activeSlot = i;
        render('puzzle');
    }
    function fillAll() {
        const n = PUZZLE_N[state.puzzle.layout] || 1;
        if (!state.images.length) { hint('先导入照片'); return; }
        for (let i = 0; i < n; i++) {
            if (!state.puzzle.slots[i]) {
                state.puzzle.slots[i] = { imageIndex: i % state.images.length, rotate: 0 };
            }
        }
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
            <div class="text-acts"><button id="btnGradeAuto" type="button">自动调色</button></div>
            <div class="histo-card"><canvas id="gradeHisto" width="600" height="180"></canvas></div>
            <div class="grade-sliders">${rows}</div>
            ${(window.QF_EditPanel && window.QF_EditPanel.fxHtml(state.template)) || ''}
            <div class="puzzle-acts"><button id="btnGradeReset">重置调色</button></div>
            <p class="panel-note">滑块来自桌面调色引擎；直方图实时读取调色后像素</p>`;
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
                const i = picks[n];
                hint(`正在导出 ${n + 1}/${picks.length}…`, 12000);
                let block = null;
                try {
                    block = sliceOne(canvas, rows, cols, i, state.crop.pad, state.crop.offX, state.crop.offY);
                    const data = block.toDataURL('image/jpeg', 0.92);
                    const r = await window.qfsNative.saveImage(data, `${base}_${tag}_${i + 1}.jpg`);
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

    const EDIT_SUBS = [['border', '边框'], ['text', '文字'], ['element', '元素'], ['style', '样式']];
    function editPage() {
        const chips = EDIT_SUBS.map(([k, label]) =>
            `<button class="chip${state.editSub === k ? ' active' : ''}" data-edit-sub="${k}">${label}</button>`).join('');
        if (!state.image) {
            return `<div class="chips edit-subs">${chips}</div><p class="panel-note">先导入一张照片，再选一个风格</p>`;
        }
        return `${currentStrip()}
            <div class="chips edit-subs">${chips}</div>
            ${(window.QF_EditPanel && window.QF_EditPanel.html(state.editSub, state.template, state.template.photoFrameStyle, {
                baseW: A._canvasBaseW || (state.image && state.image.el && state.image.el.naturalWidth) || 1000,
                baseH: A._canvasBaseH || (state.image && state.image.el && state.image.el.naturalHeight) || 1000
            })) || '<p class="panel-note">编辑面板尚未就绪</p>'}`;
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
        state.tab = name || state.tab;
        if (state.tab === 'puzzle') clampActiveSlot();
        // 切页签先把画布画回当前照片，否则从拼图切回风格/调色时会继续显示拼图，
        // 此时点「保存」导出的是上一页的拼图。
        if (state.tab !== 'puzzle' && state.image) renderPreview(true);
        panel.innerHTML = (PAGES[state.tab] || PAGES.style)();
        document.querySelectorAll('#tabs .tab').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === state.tab);
        });
        panel.querySelectorAll('[data-preset]').forEach((b) => {
            b.addEventListener('click', () => applyPreset((window.QF_PRESETS || [])[Number(b.dataset.preset)]));
        });
        panel.querySelectorAll('[data-tag]').forEach((b) => {
            b.addEventListener('click', () => { state.filter = b.dataset.tag; render('style'); });
        });
        panel.querySelectorAll('[data-edit-sub]').forEach((b) => {
            b.addEventListener('click', () => { state.editSub = b.dataset.editSub; render('edit'); });
        });
        if (state.tab === 'edit' && window.QF_EditPanel) {
            window.QF_EditPanel.bind(panel, () => renderPreviewSoon(),
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
            // 引擎里 rotate 是「90° 的倍数」(0..3)，不是角度值。
            sc.rotate = ((Number(sc.rotate) || 0) + 1) % 4;
            renderPreview();
            hint(`第 ${state.activeSlot + 1} 格旋转 ${sc.rotate * 90}°`);
        });
        const clr = document.getElementById('btnClearSlot');
        if (clr) clr.addEventListener('click', () => {
            if (!state.puzzle.slots[state.activeSlot]) { hint('这个格子本来就是空的'); return; }
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
            window.QF_EditPanel.bindFx(panel, () => renderPreviewSoon(), () => render('grade'));
        }
        const greset = document.getElementById('btnGradeReset');
        if (greset) greset.addEventListener('click', () => {
            if (typeof A.resetGrade === 'function') A.resetGrade();
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
    document.getElementById('btnExport').addEventListener('click', () => {
        if (state.exporting) return;
        if (state.tab === 'crop') exportGrid();
        else exportCurrent();
    });

    document.getElementById('tabs').addEventListener('click', (e) => {
        // 导出/切图途中切页签会把画布重画回预览，正在编码的那一帧就废了
        if (state.exporting) return;
        const tab = e.target.closest('.tab');
        if (!tab) return;
        if (typeof window.qfOpenSheet === 'function') window.qfOpenSheet('half');
        render(tab.dataset.tab);
    });
    // ── 抽屉：露头 / 半屏 / 全屏三档 ─────────────────────────────────────
    // 画布优先：默认半屏；看照片时把抽屉压到露头，只留五个页签 + 顶栏导出。
    const sheet = document.getElementById('sheet');
    const sheetHandle = document.getElementById('sheetHandle');
    const SHEET_STATES = ['peek', 'half', 'full'];
    function sheetState() {
        return SHEET_STATES.find((s) => sheet.classList.contains(s)) || 'half';
    }
    function safeBottom() {
        const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'));
        return isFinite(v) ? v : 0;
    }
    function sheetTargets() {
        const h = document.documentElement.clientHeight || window.innerHeight || 800;
        return { peek: Math.round(66 + safeBottom()), half: Math.round(h * 0.46), full: Math.round(h * 0.78) };
    }
    function setSheet(next) {
        if (SHEET_STATES.indexOf(next) < 0) next = 'half';
        sheet.style.height = '';
        sheet.classList.remove('dragging');
        SHEET_STATES.forEach((s) => sheet.classList.toggle(s, s === next));
    }
    function cycleSheet() {
        const cur = sheetState();
        setSheet(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'peek');
    }
    let sheetDrag = null;
    if (sheetHandle) {
        sheetHandle.addEventListener('pointerdown', (e) => {
            if (e.button != null && e.button !== 0) return;
            sheetDrag = {
                id: e.pointerId, y0: e.clientY, h0: sheet.getBoundingClientRect().height,
                moved: false
            };
            try { sheetHandle.setPointerCapture(e.pointerId); } catch (_) {}
        });
        sheetHandle.addEventListener('pointermove', (e) => {
            if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
            const dy = sheetDrag.y0 - e.clientY;
            if (!sheetDrag.moved && Math.abs(dy) > 4) {
                sheetDrag.moved = true;
                sheet.classList.add('dragging');
            }
            if (!sheetDrag.moved) return;
            const t = sheetTargets();
            const h = Math.max(t.peek, Math.min(t.full, sheetDrag.h0 + dy));
            sheet.style.height = h + 'px';
        });
        const endDrag = (e) => {
            if (!sheetDrag || (e && e.pointerId != null && e.pointerId !== sheetDrag.id)) return;
            const moved = sheetDrag.moved;
            sheetDrag = null;
            if (!moved) { cycleSheet(); return; }
            const t = sheetTargets();
            const h = sheet.getBoundingClientRect().height;
            const best = ['peek', 'half', 'full']
                .map((k) => [k, Math.abs(h - t[k])])
                .sort((a, b) => a[1] - b[1])[0][0];
            setSheet(best);
        };
        sheetHandle.addEventListener('pointerup', endDrag);
        sheetHandle.addEventListener('pointercancel', endDrag);
        sheetHandle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSheet(); }
        });
    }
    // 抽屉收起时点页签，自动展开到半屏（否则点了没反应）
    window.qfOpenSheet = function (next) {
        if (sheetState() === 'peek') setSheet(next || 'half');
    };

    document.getElementById('btnSettings').addEventListener('click', () => {
        window.qfOpenSheet('half');
        panel.innerHTML = `<h2>设置</h2><p class="panel-note">运行平台：${window.qfsNative.platform()} · 内测版 · 无账号、无上传。</p>`;
    });
    const thumbBtn = document.getElementById('btnThumb');
    if (thumbBtn) thumbBtn.addEventListener('click', () => {
        if (state.tab !== 'style') render('style');
        setSheet(sheetState() === 'peek' ? 'half' : sheetState());
    });

    // 有引擎时先用它，否则降级自绘
    if (typeof window.__render !== 'function') paintFallback();
    updateEmpty();
    render('style');
    window.QF_MOBILE_READY = true;
})();
