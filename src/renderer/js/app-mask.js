'use strict';
/* 蒙版调色：线性渐变 / 径向椭圆 / 画笔 / 亮度范围，多蒙版叠加，每个蒙版一套 9 档参数。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 蒙版只作用于**像素调色**（9 档；曲线/校准/混色器仍是全局）。烘焙顺序：
 *    全局参数烘一次 → 依次「用该蒙版的参数再烘一层 → 按蒙版权重合成」。
 *    这样蒙版的调整天然叠在全局之上（与 PS 调整图层的堆叠语义一致），
 *    而且不用把 9 档参数和曲线/LUT 混进一个函数。
 * 2) 蒙版权重 = 一张灰度画布的 alpha。生成一次（线性/椭圆是渐变，画笔是描边后模糊，
 *    亮度范围读低分辨率像素再放大），合成时用 destination-in 当遮罩，不做逐像素 JS。
 * 3) 编辑期只重绘叠加层、不重烘照片：拖形状时 60fps 跟手，松手才烘一次。
 *    滑块（羽化/浓度/参数）才走实时烘焙。
 * 4) 坐标一律存**照片归一化坐标**（0..1），与缩放/画布尺寸/导出分辨率无关；
 *    叠加层用 engine 记录的 app._photoRect 把指针换算进来。
 */
(function () {
    const TYPES = [
        { k: 'linear', label: '渐变' },
        { k: 'radial', label: '椭圆' },
        { k: 'brush', label: '画笔' },
        { k: 'lum', label: '亮度' }
    ];
    const MASK_KEYS = ['exp', 'con', 'sat', 'temp', 'tint', 'hi', 'sh', 'white', 'black'];

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

    function defaultMaskParams() {
        const p = {};
        for (const k of MASK_KEYS) p[k] = 0;
        return p;
    }

    function defaultShape(type) {
        if (type === 'linear') return { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.62 };
        if (type === 'radial') return { cx: 0.5, cy: 0.42, rx: 0.34, ry: 0.28 };
        if (type === 'brush') return { size: 18, strokes: [] };
        return { lo: 0, hi: 45 };   // lum：只选亮度 0~45% 的区域
    }

    let _seq = 0;
    function newMask(type) {
        _seq += 1;
        return {
            id: 'mk' + Date.now().toString(36) + _seq,
            type: TYPES.some((t) => t.k === type) ? type : 'linear',
            on: 1,
            inv: 0,
            feather: type === 'brush' ? 35 : 50,
            density: 100,
            shape: defaultShape(type),
            p: defaultMaskParams()
        };
    }

    function clampSlide(v) { return Math.max(-100, Math.min(100, Math.round(num(v, 0)))); }

    function sanitizeMask(m) {
        if (!m || !m.type) return null;
        const type = TYPES.some((t) => t.k === m.type) ? m.type : 'linear';
        const out = {
            id: String(m.id || ('mk' + (++_seq))),
            type,
            on: m.on === 0 ? 0 : 1,
            inv: m.inv ? 1 : 0,
            feather: Math.max(0, Math.min(100, Math.round(num(m.feather, 50)))),
            density: Math.max(0, Math.min(100, Math.round(num(m.density, 100)))),
            shape: defaultShape(type),
            p: defaultMaskParams()
        };
        if (type === 'linear' || type === 'radial') {
            const keys = type === 'linear' ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'rx', 'ry'];
            const s = m.shape || {};
            for (const k of keys) out.shape[k] = clamp01(num(s[k], out.shape[k]));
            if (type === 'radial') {
                out.shape.rx = Math.max(0.02, Math.min(1, num(s.rx, out.shape.rx)));
                out.shape.ry = Math.max(0.02, Math.min(1, num(s.ry, out.shape.ry)));
            }
            if (type === 'linear' && Math.abs(out.shape.x2 - out.shape.x1) < 1e-4
                && Math.abs(out.shape.y2 - out.shape.y1) < 1e-4) {
                out.shape.y2 = clamp01(out.shape.y1 + 0.2);
            }
        } else if (type === 'brush') {
            const s = m.shape || {};
            out.shape.size = Math.max(2, Math.min(80, Math.round(num(s.size, 18))));
            out.shape.strokes = [];
            for (const st of (Array.isArray(s.strokes) ? s.strokes : []).slice(0, 400)) {
                if (!st || !Array.isArray(st.pts) || st.pts.length < 2) continue;
                const pts = [];
                for (const pt of st.pts.slice(0, 4000)) {
                    if (!Array.isArray(pt) || pt.length < 2) continue;
                    pts.push([clamp01(num(pt[0], 0)), clamp01(num(pt[1], 0))]);
                }
                if (pts.length >= 2) {
                    out.shape.strokes.push({
                        size: Math.max(2, Math.min(80, Math.round(num(st.size, out.shape.size)))),
                        erase: st.erase ? 1 : 0,
                        pts
                    });
                }
            }
        } else {
            const s = m.shape || {};
            const lo = Math.max(0, Math.min(90, Math.round(num(s.lo, 0))));
            const hi = Math.max(lo + 5, Math.min(100, Math.round(num(s.hi, 45))));
            out.shape.lo = lo;
            out.shape.hi = hi;
        }
        const src = m.p || {};
        for (const k of MASK_KEYS) out.p[k] = clampSlide(src[k]);
        return out;
    }

    function sanitizeMasks(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const m of list.slice(0, 12)) {
            const s = sanitizeMask(m);
            if (s) out.push(s);
        }
        return out;
    }

    // 有参数才算「会改变画面」；只画了形状没调参数时不必重烘（但叠加层照常可编辑）
    function maskHasParams(m) {
        if (!m || !m.p) return false;
        for (const k of MASK_KEYS) if (Number(m.p[k]) || 0) return true;
        return false;
    }

    function activeMasks(list) {
        return (list || []).filter((m) => m.on !== 0 && maskHasParams(m));
    }

    function maskSignature(m) {
        const s = m.shape || {};
        const base = [m.type, m.on, m.inv, m.feather, m.density,
            MASK_KEYS.map((k) => m.p ? m.p[k] : 0).join(',')];
        if (m.type === 'brush') {
            base.push(s.size, (s.strokes || []).map((st) => (st.erase ? 'e' : 'w') + st.size + ':'
                + st.pts.map((p) => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(';')).join('|'));
        } else if (m.type === 'lum') {
            base.push(s.lo, s.hi);
        } else {
            base.push(s.x1, s.y1, s.x2, s.y2, s.cx, s.cy, s.rx, s.ry);
        }
        return base.join('|');
    }

    // ── 蒙版权重画布（alpha 即权重） ─────────────────────────────
    function newCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    function fillGradient(g, w, h, m) {
        const s = m.shape;
        const f = Math.max(0.001, m.feather / 100);
        const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
        const grad = g.createLinearGradient(x1, y1, x2, y2);
        const a = clamp01(0.5 - f / 2), b = clamp01(0.5 + f / 2);
        // 权重必须体现在 **alpha** 上（合成时走 destination-in）：
        // 用黑色填充 alpha 仍是 1，会把整张图都当蒙版内。
        const clear = 'rgba(255,255,255,0)';
        const solid = 'rgba(255,255,255,1)';
        const c0 = m.inv ? solid : clear;
        const c1 = m.inv ? clear : solid;
        grad.addColorStop(0, c0);
        grad.addColorStop(a, c0);
        grad.addColorStop(b, c1);
        grad.addColorStop(1, c1);
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
    }

    function fillRadial(g, w, h, m) {
        const s = m.shape;
        const f = Math.max(0.001, m.feather / 100);
        g.save();
        g.translate(s.cx * w, s.cy * h);
        g.scale(Math.max(0.01, s.rx) * w, Math.max(0.01, s.ry) * h);
        const grad = g.createRadialGradient(0, 0, Math.max(0, 1 - f), 0, 0, 1);
        const c0 = m.inv ? 'rgba(255,255,255,0)' : 'rgba(255,255,255,1)';
        const c1 = m.inv ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0)';
        grad.addColorStop(0, c0);
        grad.addColorStop(1, c1);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, 1.02, 0, Math.PI * 2);
        g.fill();
        g.restore();
    }

    // 画笔 = 若干条描边 + 羽化模糊。擦除用 destination-out，保证「先涂后擦」的顺序语义。
    function fillBrush(g, w, h, m, out) {
        const strokes = (m.shape.strokes || []);
        const short = Math.min(w, h);
        const draw = (ctx2, blurPx) => {
            for (const st of strokes) {
                const lw = Math.max(1, (st.size / 100) * short);
                ctx2.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
                ctx2.strokeStyle = '#fff';
                ctx2.fillStyle = '#fff';
                ctx2.lineWidth = lw;
                ctx2.lineCap = 'round';
                ctx2.lineJoin = 'round';
                const pts = st.pts;
                if (pts.length === 1) {
                    ctx2.beginPath();
                    ctx2.arc(pts[0][0] * w, pts[0][1] * h, lw / 2, 0, Math.PI * 2);
                    ctx2.fill();
                    continue;
                }
                ctx2.beginPath();
                ctx2.moveTo(pts[0][0] * w, pts[0][1] * h);
                for (let i = 1; i < pts.length; i++) ctx2.lineTo(pts[i][0] * w, pts[i][1] * h);
                ctx2.stroke();
            }
            void blurPx;
        };
        // 硬度由羽化控制：羽化越大边缘越糊。先画在临时层，再带模糊合成到目标层
        const tmp = newCanvas(w, h);
        const tg = tmp.getContext('2d');
        draw(tg, 0);
        const blur = (m.feather / 100) * Math.max(1, (m.shape.size / 100) * short) * 0.6;
        g.save();
        if (blur > 0.4) g.filter = 'blur(' + blur.toFixed(2) + 'px)';
        g.drawImage(tmp, 0, 0);
        g.filter = 'none';
        g.restore();
        if (m.inv) {
            // 反相：把当前 alpha 反过来（白色铺底后挖掉已有的）
            const inv = newCanvas(w, h);
            const ig = inv.getContext('2d');
            ig.fillStyle = '#fff';
            ig.fillRect(0, 0, w, h);
            ig.globalCompositeOperation = 'destination-out';
            ig.drawImage(out, 0, 0);
            g.save();
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, w, h);
            g.drawImage(inv, 0, 0);
            g.restore();
        }
    }

    function fillLuma(g, w, h, m, src) {
        const s = m.shape;
        // 低分辨率采样再放大：亮度蒙版本身就是软过渡，320px 足够，逐像素成本可控
        const tw = Math.max(32, Math.min(320, Math.round(w / 4)));
        const th = Math.max(1, Math.round(tw * h / w));
        const small = newCanvas(tw, th);
        const sg = small.getContext('2d');
        try { sg.drawImage(src, 0, 0, tw, th); } catch (_) { /* 源不可用时留空 */ }
        let data;
        try { data = sg.getImageData(0, 0, tw, th); } catch (_) { return; }
        const d = data.data;
        const lo = s.lo / 100, hi = s.hi / 100;
        const soft = Math.max(0.02, (hi - lo) * 0.35);
        for (let i = 0; i < d.length; i += 4) {
            const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
            let v = 0;
            if (y >= lo && y <= hi) {
                const a = Math.min(1, (y - lo) / soft);
                const b = Math.min(1, (hi - y) / soft);
                v = Math.min(a, b);
            }
            let a8 = Math.round(clamp01(v) * 255);
            if (m.inv) a8 = 255 - a8;
            d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a8;
        }
        sg.putImageData(data, 0, 0);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(small, 0, 0, w, h);
    }

    // 生成蒙版 alpha 画布（w×h 与烘焙图层一致）
    function render(m, w, h, src) {
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        if (!g) return out;
        if (m.type === 'linear') fillGradient(g, out.width, out.height, m);
        else if (m.type === 'radial') fillRadial(g, out.width, out.height, m);
        else if (m.type === 'brush') fillBrush(g, out.width, out.height, m, out);
        else fillLuma(g, out.width, out.height, m, src);
        // 浓度：整体压权重（100 不动、0 完全无效）
        const dens = Math.max(0, Math.min(100, m.density != null ? m.density : 100)) / 100;
        if (dens < 1) {
            const scaled = newCanvas(out.width, out.height);
            const sg = scaled.getContext('2d');
            sg.globalAlpha = dens;
            sg.drawImage(out, 0, 0);
            return scaled;
        }
        return out;
    }

    // base 打底，把 layer 按 alpha 的权重叠上去
    function composite(base, layer, alpha) {
        const w = base.width, h = base.height;
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        g.drawImage(base, 0, 0);
        const tmp = newCanvas(w, h);
        const t = tmp.getContext('2d');
        t.drawImage(layer, 0, 0);
        t.globalCompositeOperation = 'destination-in';
        t.drawImage(alpha, 0, 0);
        g.drawImage(tmp, 0, 0);
        return out;
    }

    window.QfsMask = {
        TYPES, MASK_KEYS, newMask, defaultMaskParams, sanitizeMasks, sanitizeMask,
        maskHasParams, activeMasks, maskSignature, render, composite
    };
})();

/* ── 面板与画布叠加层 ─────────────────────────────────────────── */
(function () {
    const $ = (id) => document.getElementById(id);
    const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

    function overlayEl() { return $('maskOverlay'); }

    Object.assign(window.App || (window.App = {}), {
        _activeMaskId: null,

        masksOf(im) {
            const g = (im || this.image || {}).grade;
            return (g && Array.isArray(g.masks)) ? g.masks : [];
        },

        activeMask(im) {
            const list = this.masksOf(im);
            if (!this._activeMaskId) return null;
            for (const m of list) if (m.id === this._activeMaskId) return m;
            return null;
        },

        setActiveMask(id) {
            const list = this.masksOf(this.image);
            this._activeMaskId = (id && list.some((m) => m.id === id)) ? id : null;
            if (this.syncGradeUI) this.syncGradeUI();
            if (this.syncMaskUI) this.syncMaskUI();
            this.drawMaskOverlay();
            return true;
        },

        addMask(type) {
            const im = this.image;
            if (!im) return false;
            const p = this.gradeOf(im);
            const m = window.QfsMask.newMask(type);
            const masks = (p.masks || []).concat([m]);
            this._activeMaskId = m.id;
            this.setGrade({ masks });
            this.setStatus('已添加' + (window.QfsMask.TYPES.find((t) => t.k === type) || {}).label + '蒙版');
            return true;
        },

        removeMask(id) {
            const im = this.image;
            if (!im) return false;
            const p = this.gradeOf(im);
            const masks = (p.masks || []).filter((m) => m.id !== id);
            if (this._activeMaskId === id) this._activeMaskId = masks.length ? masks[masks.length - 1].id : null;
            this.setGrade({ masks });
            this.setStatus('已删除蒙版');
            return true;
        },

        /* 蒙版形状改了：叠加层立刻重画，照片等松手再烘（拖动期不烘焙=跟手） */
        commitMaskShape(reason) {
            const im = this.image;
            if (!im) return;
            if (this.invalidateGrade) this.invalidateGrade(im);
            if (this.rebuildGrade) this.rebuildGrade(reason === 'drag' ? 'low' : 'full');
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
        },

        /* 叠加层几何与缩放同步（canvas 的 CSS 尺寸/位移变化时调用） */
        // 画布基准坐标宽高（模板/照片矩形用的那套单位）
        _baseSize() {
            const cv = this.dom && this.dom.canvas;
            if (!cv) return { w: 1, h: 1 };
            if (this._canvasBaseW && this._canvasBaseH) return { w: this._canvasBaseW, h: this._canvasBaseH };
            const sc = this._canvasScale || 1;
            return { w: Math.max(1, (cv._logW || cv.width) / sc),
                     h: Math.max(1, (cv._logH || cv.height) / sc) };
        },

        /* 叠加层几何：直接按画布的**视觉矩形**摆放。
           以前是复制 canvas.style.width 与 transform —— 只要有一条改样式的路径没走到
           applyZoomStyle（导出临时放大、窗口/侧栏变化、fit 重算），两边就会不同步，
           蒙版范围看起来就"跑位"了。现在每次都读真实矩形，不存在第二个真相。 */
        syncOverlayGeometry() {
            const ov = overlayEl();
            const cv = this.dom && this.dom.canvas;
            if (!ov || !cv) return;
            const host = ov.parentElement;
            const cr = cv.getBoundingClientRect();
            const hr = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
            const bl = host ? host.clientLeft : 0;
            const bt = host ? host.clientTop : 0;
            const cssW = Math.max(1, cr.width);
            const cssH = Math.max(1, cr.height);
            ov.style.left = (cr.left - hr.left - bl) + 'px';
            ov.style.top = (cr.top - hr.top - bt) + 'px';
            ov.style.right = 'auto';
            ov.style.bottom = 'auto';
            ov.style.margin = '0';
            ov.style.width = cssW + 'px';
            ov.style.height = cssH + 'px';
            ov.style.transform = 'none';
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const bw = Math.max(1, Math.round(cssW * dpr));
            const bh = Math.max(1, Math.round(cssH * dpr));
            if (ov.width !== bw || ov.height !== bh) { ov.width = bw; ov.height = bh; }
        },

        /* 指针 → 照片归一化坐标 */
        _maskPoint(e) {
            const ov = overlayEl();
            if (!ov) return null;
            const r = ov.getBoundingClientRect();
            const base = this._baseSize();
            // 叠加层就是画布的视觉矩形：比例直接乘基准宽高即可回到照片矩形所在的坐标
            const x = (e.clientX - r.left) / Math.max(1, r.width) * base.w;
            const y = (e.clientY - r.top) / Math.max(1, r.height) * base.h;
            const pr = this._photoRect;
            if (!pr) return null;
            return { x: clamp01((x - pr.x) / Math.max(1, pr.w)), y: clamp01((y - pr.y) / Math.max(1, pr.h)) };
        },

        /* 叠加层绘制：蒙版范围染成青绿色 + 形状手柄；拖动期只跑这一条路径 */
        drawMaskOverlay() {
            const ov = overlayEl();
            if (!ov) return;
            this.syncOverlayGeometry();
            const g = ov.getContext('2d');
            if (!g) return;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, ov.width, ov.height);
            const m = this.activeMask(this.image);
            if (!m || !this.image) { ov.classList.remove('active'); return; }
            const pr = this._photoRect;
            if (!pr) { ov.classList.remove('active'); return; }
            ov.classList.add('active');

            const dpr = Math.min(2, window.devicePixelRatio || 1);
            // 只用一个比例：叠加层像素 / 画布基准单位。
            // 以前是 canvasScale × zoom × dpr 三个比例相乘，任一环（fit 重算、导出临时放大、
            // 高分屏）取值不同步，蒙版范围就会跟着变；现在 ov 已贴在画布视觉矩形上，
            // 这个比例天然包含缩放与 DPR，没有第二个真相。
            const base = this._baseSize();
            const k = ov.width / Math.max(1, base.w);
            const sx = pr.x * k, sy = pr.y * k;
            const sw = pr.w * k, sh = pr.h * k;

            // 线性和椭圆直接在叠加层上用矢量渐变画：位置就是照片矩形本身，
            // 不经过「低分辨率遮罩 → 放大」，避免再出现错位/看起来是硬边矩形。
            // 画笔和亮度是像素型蒙版，仍走低分辨率遮罩放大。
            // 叠层只表示「范围」：不乘浓度。否则把浓度调低、或照片被压暗后，
            // 半透明绿在暗背景上几乎看不见，看起来就像蒙版自己缩小了。
            const TINT = [64, 208, 150];
            const baseA = 0.5;
            const rgba = (a) => 'rgba(' + TINT[0] + ',' + TINT[1] + ',' + TINT[2] + ',' + a.toFixed(3) + ')';
            g.save();
            g.beginPath();
            if (m.type === 'radial') {
                g.ellipse(sx + m.shape.cx * sw, sy + m.shape.cy * sh,
                    Math.max(1, m.shape.rx * sw), Math.max(1, m.shape.ry * sh), 0, 0, Math.PI * 2);
            } else {
                g.rect(sx, sy, sw, sh);
            }
            g.clip();
            if (m.type === 'linear') {
                const f = Math.max(0.001, m.feather / 100);
                const grad = g.createLinearGradient(sx + m.shape.x1 * sw, sy + m.shape.y1 * sh,
                    sx + m.shape.x2 * sw, sy + m.shape.y2 * sh);
                const a = Math.max(0, 0.5 - f / 2), b = Math.min(1, 0.5 + f / 2);
                const c0 = rgba(m.inv ? baseA : 0), c1 = rgba(m.inv ? 0 : baseA);
                grad.addColorStop(0, c0);
                grad.addColorStop(a, c0);
                grad.addColorStop(b, c1);
                grad.addColorStop(1, c1);
                g.fillStyle = grad;
                g.fillRect(sx, sy, sw, sh);
            } else if (m.type === 'radial') {
                const f = Math.max(0.001, m.feather / 100);
                const cx = sx + m.shape.cx * sw, cy = sy + m.shape.cy * sh;
                const rx = Math.max(1, m.shape.rx * sw), ry = Math.max(1, m.shape.ry * sh);
                g.translate(cx, cy);
                g.scale(rx, ry);
                // 单位圆内的径向渐变：内圈到 (1-f) 是满权重，之外衰减到 0
                const grad = g.createRadialGradient(0, 0, Math.max(0, 1 - f), 0, 0, 1);
                const c0 = rgba(m.inv ? 0 : baseA), c1 = rgba(m.inv ? baseA : 0);
                grad.addColorStop(0, c0);
                grad.addColorStop(1, c1);
                g.fillStyle = grad;
                g.fillRect(-1.05, -1.05, 2.1, 2.1);
            } else if (m.type === 'brush' || m.type === 'lum') {
                const pw = Math.max(64, Math.min(400, Math.round(pr.w)));
                const ph = Math.max(32, Math.round(pw * pr.h / Math.max(1, pr.w)));
                // 源必须是**原图**：亮度蒙版按像素亮度选区，若用调过色的烘焙图，
                // 一压暗选区就变大、一提亮就变小 —— 用户看到的就是「调完色蒙版范围变了」。
                const alpha = window.QfsMask.render(m, pw, ph, this.image.el);
                const tint = document.createElement('canvas');
                tint.width = pw; tint.height = ph;
                const tg = tint.getContext('2d');
                tg.fillStyle = rgba(1);
                tg.fillRect(0, 0, pw, ph);
                tg.globalCompositeOperation = 'destination-in';
                tg.drawImage(alpha, 0, 0);
                g.imageSmoothingEnabled = true;
                g.drawImage(tint, sx, sy, sw, sh);
            }
            g.restore();

            // 手柄（线性：两端点；径向：中心 + 四个方向点）
            const P = (x, y) => ({ x: sx + x * sw, y: sy + y * sh });
            const dot = (p, r) => {
                g.beginPath();
                g.arc(p.x, p.y, r * dpr, 0, Math.PI * 2);
                g.fillStyle = 'rgba(255,255,255,.95)';
                g.fill();
                g.lineWidth = 1.5 * dpr;
                g.strokeStyle = 'rgba(0,0,0,.55)';
                g.stroke();
            };
            g.save();
            if (m.type === 'linear') {
                const a = P(m.shape.x1, m.shape.y1), b = P(m.shape.x2, m.shape.y2);
                g.lineWidth = 1.4 * dpr;
                g.strokeStyle = 'rgba(255,255,255,.85)';
                g.setLineDash([5 * dpr, 4 * dpr]);
                g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
                g.setLineDash([]);
                dot(a, 5); dot(b, 5);
            } else if (m.type === 'radial') {
                const c = P(m.shape.cx, m.shape.cy);
                const rx = m.shape.rx * sw, ry = m.shape.ry * sh;
                g.lineWidth = 1.4 * dpr;
                g.strokeStyle = 'rgba(255,255,255,.85)';
                g.setLineDash([5 * dpr, 4 * dpr]);
                g.beginPath();
                g.ellipse(c.x, c.y, Math.max(2, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
                g.stroke();
                g.setLineDash([]);
                dot(c, 5);
            }
            g.restore();
        },

        initMasks() {
            const types = $('maskTypes');
            if (types) {
                types.querySelectorAll('[data-mt]').forEach((b) => {
                    b.addEventListener('click', () => this.addMask(b.dataset.mt));
                });
            }
            const list = $('maskList');
            if (list) {
                list.addEventListener('click', (e) => {
                    const row = e.target.closest('[data-mask-id]');
                    if (!row) return;
                    if (e.target.closest('[data-mask-del]')) { this.removeMask(row.dataset.maskId); return; }
                    this.setActiveMask(row.dataset.maskId || null);
                });
            }
            const del = $('btnMaskDel');
            if (del) {
                del.addEventListener('click', () => {
                    const m = this.activeMask(this.image);
                    if (m) this.removeMask(m.id);
                });
            }
            // 羽化/浓度/笔刷/亮度范围：改数值 → 重新烘焙
            const bindNum = (id, apply) => {
                const el = $(id);
                if (!el) return;
                el.addEventListener('input', () => { apply(Number(el.value) || 0, false); });
                el.addEventListener('change', () => { apply(Number(el.value) || 0, true); });
            };
            bindNum('slMaskFeather', (v, done) => this._patchMask({ feather: v }, done));
            bindNum('slMaskDensity', (v, done) => this._patchMask({ density: v }, done));
            bindNum('slMaskBrushSize', (v) => {
                const m = this.activeMask(this.image);
                if (!m || m.type !== 'brush') return;
                m.shape.size = v;
                this.commitMaskShape('live');
            });
            bindNum('slMaskLo', (v, done) => this._patchLum(v, null, done));
            bindNum('slMaskHi', (v, done) => this._patchLum(null, v, done));
            const inv = $('cbMaskInv');
            if (inv) inv.addEventListener('change', () => this._patchMask({ inv: inv.checked ? 1 : 0 }, true));
            this._bindMaskOverlay();
            this.syncMaskUI();
            this.drawMaskOverlay();
        },

        _patchMask(patch, done) {
            const m = this.activeMask(this.image);
            if (!m) return;
            Object.assign(m, patch);
            this.commitMaskShape(done ? 'full' : 'live');
            this.syncMaskUI();
        },

        _patchLum(lo, hi, done) {
            const m = this.activeMask(this.image);
            if (!m || m.type !== 'lum') return;
            if (lo != null) m.shape.lo = Math.max(0, Math.min(m.shape.hi - 5, lo));
            if (hi != null) m.shape.hi = Math.min(100, Math.max(m.shape.lo + 5, hi));
            this.commitMaskShape(done ? 'full' : 'live');
            this.syncMaskUI();
        },

        _bindMaskOverlay() {
            const ov = overlayEl();
            if (!ov) return;
            let drag = null;
            let pending = null;   // 按下但还没拖动：单击不应该改动蒙版
            const hit = (pt, target, rCss) => {
                const ovr = ov.getBoundingClientRect();
                const lw = this.dom.canvas._logW || 1, lh = this.dom.canvas._logH || 1;
                const pr = this._photoRect;
                if (!pr) return false;
                const px = (pr.x + target.x * pr.w) / lw * ovr.width;
                const py = (pr.y + target.y * pr.h) / lh * ovr.height;
                const mx = (pr.x + pt.x * pr.w) / lw * ovr.width;
                const my = (pr.y + pt.y * pr.h) / lh * ovr.height;
                return Math.hypot(px - mx, py - my) <= rCss;
            };
            // 点到线段的距离（CSS 像素），用来判断「抓线整体拖」
            const distToLine = (pt, s) => {
                const ovr = ov.getBoundingClientRect();
                const pr = this._photoRect;
                if (!pr) return 1e9;
                const toCss = (x, y) => ({ x: (pr.x + x * pr.w) / (this.dom.canvas._logW || 1) * ovr.width,
                                           y: (pr.y + y * pr.h) / (this.dom.canvas._logH || 1) * ovr.height });
                const a = toCss(s.x1, s.y1), b = toCss(s.x2, s.y2), p = toCss(pt.x, pt.y);
                const dx = b.x - a.x, dy = b.y - a.y;
                const len2 = dx * dx + dy * dy || 1e-6;
                let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                const cx = a.x + t * dx, cy = a.y + t * dy;
                return Math.hypot(p.x - cx, p.y - cy);
            };

            ov.addEventListener('pointerdown', (e) => {
                const m = this.activeMask(this.image);
                if (!m) return;
                const pt = this._maskPoint(e);
                if (!pt) return;
                try { ov.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有活动指针 */ }
                e.preventDefault();
                if (m.type === 'linear') {
                    if (hit(pt, { x: m.shape.x1, y: m.shape.y1 }, 12)) drag = { kind: 'p1' };
                    else if (hit(pt, { x: m.shape.x2, y: m.shape.y2 }, 12)) drag = { kind: 'p2' };
                    else if (distToLine(pt, m.shape) <= 14) {
                        // 抓到线上 → 整条线平移，而不是重新画
                        drag = { kind: 'moveLine', px: pt.x, py: pt.y, orig: Object.assign({}, m.shape) };
                    } else {
                        // 空白处按下先不动：拖出距离才当成新渐变，
                        // 否则「点一下看看」会把调好的蒙版塌成一个点（用户踩过）。
                        pending = { kind: 'newLine', start: pt, orig: Object.assign({}, m.shape) };
                    }
                } else if (m.type === 'radial') {
                    const dx = (pt.x - m.shape.cx) / Math.max(0.01, m.shape.rx);
                    const dy = (pt.y - m.shape.cy) / Math.max(0.01, m.shape.ry);
                    const rr = Math.hypot(dx, dy);
                    if (hit(pt, { x: m.shape.cx, y: m.shape.cy }, 12) || rr < 0.95) {
                        drag = { kind: 'move', ox: m.shape.cx, oy: m.shape.cy, px: pt.x, py: pt.y };
                    } else if (rr < 1.35) {
                        // 记住按下时的半径与位置：按「离中心的距离比」等比缩放。
                        // 直接取 |pt-cx| 作为新半径的话，斜着抓边缘会让两个轴同时跳小 —— 越拖越小。
                        drag = { kind: 'size', rx0: m.shape.rx, ry0: m.shape.ry,
                                 cx: m.shape.cx, cy: m.shape.cy,
                                 d0: Math.max(0.01, Math.hypot(pt.x - m.shape.cx, pt.y - m.shape.cy)) };
                    } else {
                        pending = { kind: 'newRadial', start: pt, orig: Object.assign({}, m.shape) };
                    }
                } else if (m.type === 'brush') {
                    drag = { kind: 'brush' };
                    m.shape.strokes = m.shape.strokes || [];
                    m.shape.strokes.push({
                        size: m.shape.size || 18,
                        erase: (e.altKey || e.button === 2) ? 1 : 0,
                        pts: [[pt.x, pt.y], [pt.x + 0.0005, pt.y]]
                    });
                } else {
                    drag = null;
                }
                if (drag) this.drawMaskOverlay();
            });

            ov.addEventListener('pointermove', (e) => {
                const m = this.activeMask(this.image);
                if (!m) return;
                // 注意：pending（按下未拖）也要进这里，否则「拖出新渐变」永远升级不了
                if (!drag && !pending) return;
                const pt = this._maskPoint(e);
                if (!pt) return;
                if (pending) {
                    // 拖动超过阈值才把「空白处按下」升级成新形状
                    const moved = Math.hypot(pt.x - pending.start.x, pt.y - pending.start.y);
                    if (moved < 0.008) return;
                    if (pending.kind === 'newLine') {
                        m.shape.x1 = pending.start.x; m.shape.y1 = pending.start.y;
                        m.shape.x2 = pt.x; m.shape.y2 = pt.y;
                        pending = null;
                        drag = { kind: 'p2' };
                    } else {
                        m.shape.cx = pending.start.x; m.shape.cy = pending.start.y;
                        m.shape.rx = Math.max(0.02, Math.abs(pt.x - m.shape.cx));
                        m.shape.ry = Math.max(0.02, Math.abs(pt.y - m.shape.cy));
                        pending = null;
                        drag = { kind: 'size' };
                    }
                    this.drawMaskOverlay();
                    return;
                }
                if (drag.kind === 'moveLine') {
                    const dx = pt.x - drag.px, dy = pt.y - drag.py;
                    m.shape.x1 = drag.orig.x1 + dx; m.shape.y1 = drag.orig.y1 + dy;
                    m.shape.x2 = drag.orig.x2 + dx; m.shape.y2 = drag.orig.y2 + dy;
                } else if (drag.kind === 'p1') { m.shape.x1 = pt.x; m.shape.y1 = pt.y; }
                else if (drag.kind === 'p2') { m.shape.x2 = pt.x; m.shape.y2 = pt.y; }
                else if (drag.kind === 'move') {
                    const dx = pt.x - drag.px, dy = pt.y - drag.py;
                    m.shape.cx = clamp01(drag.ox + dx);
                    m.shape.cy = clamp01(drag.oy + dy);
                } else if (drag.kind === 'size') {
                    const d = Math.hypot(pt.x - drag.cx, pt.y - drag.cy);
                    const k = Math.max(0.05, d / drag.d0);
                    m.shape.rx = Math.max(0.02, Math.min(1, drag.rx0 * k));
                    m.shape.ry = Math.max(0.02, Math.min(1, drag.ry0 * k));
                } else if (drag.kind === 'brush') {
                    const st = m.shape.strokes[m.shape.strokes.length - 1];
                    st.pts.push([pt.x, pt.y]);
                }
                this.drawMaskOverlay();
            });

            const end = (e) => {
                // 只是在蒙版上点了一下：保持原样，绝不重置已调好的位置
                pending = null;
                if (!drag) return;
                const wasBrush = drag.kind === 'brush';
                drag = null;
                try { if (ov.hasPointerCapture(e.pointerId)) ov.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                // 松手烘一次全分辨率：拖动期只画叠加层，保证跟手
                this.commitMaskShape('full');
                if (wasBrush) this.syncMaskUI();
            };
            ov.addEventListener('pointerup', end);
            ov.addEventListener('pointercancel', end);
            ov.addEventListener('contextmenu', (e) => { if (this.activeMask(this.image)) e.preventDefault(); });
        },

        syncMaskUI() {
            const list = $('maskList');
            const masks = this.masksOf(this.image);
            const act = this.activeMask(this.image);
            if (list) {
                const rows = ['<button class="mask-row' + (act ? '' : ' active') + '" data-mask-id="" type="button">'
                    + '<span class="mask-name">全局</span><span class="mask-type">整张图</span></button>'];
                for (let i = 0; i < masks.length; i++) {
                    const m = masks[i];
                    const t = window.QfsMask.TYPES.find((x) => x.k === m.type) || { label: m.type };
                    const on = act && act.id === m.id;
                    rows.push('<button class="mask-row' + (on ? ' active' : '') + (m.on === 0 ? ' off' : '') + '" data-mask-id="' + m.id + '" type="button">'
                        + '<span class="mask-name">蒙版 ' + (i + 1) + '</span>'
                        + '<span class="mask-type">' + t.label + '</span>'
                        + '<span class="mask-del" data-mask-del="1" title="删除">×</span></button>');
                }
                list.innerHTML = rows.join('');
            }
            const opts = $('maskOpts');
            if (opts) opts.style.display = act ? '' : 'none';
            const brushRow = $('rowMaskBrush');
            if (brushRow) brushRow.style.display = (act && act.type === 'brush') ? '' : 'none';
            const lumLo = $('rowMaskLo'), lumHi = $('rowMaskHi');
            if (lumLo) lumLo.style.display = (act && act.type === 'lum') ? '' : 'none';
            if (lumHi) lumHi.style.display = (act && act.type === 'lum') ? '' : 'none';
            const tip = $('maskEditTip');
            if (tip) {
                tip.style.display = act ? '' : 'none';
                if (act) {
                    const pr = this._photoRect;
                    tip.textContent = pr ? ({
                        linear: '拖线身整体移动、拖两端点改过渡；空白处拖一下可重画',
                        radial: '拖椭圆内部移动、拖边缘改大小；外面拖出新椭圆',
                        brush: '按住涂抹；按住 Alt 或右键涂抹 = 擦除',
                        lum: '按亮度自动选区，调下面的暗部/亮部阈值'
                    })[act.type] : '当前样式下无法在画布上编辑蒙版（切回默认模板样式即可）';
                }
            }
            const badge = $('grpMask');
            if (badge) badge.classList.toggle('mask-on', masks.length > 0);
            // 数值回显
            const setV = (id, v) => {
                const el = $(id);
                if (!el) return;
                el.value = String(v);
                const lbl = $('lbl' + id.slice(2));
                if (lbl && this.updateLabel) this.updateLabel(lbl.id, String(v));
            };
            if (act) {
                setV('slMaskFeather', act.feather);
                setV('slMaskDensity', act.density);
                if (act.type === 'brush') setV('slMaskBrushSize', act.shape.size);
                if (act.type === 'lum') { setV('slMaskLo', act.shape.lo); setV('slMaskHi', act.shape.hi); }
                const inv = $('cbMaskInv');
                if (inv) inv.checked = act.inv === 1;
            }
            this.drawMaskOverlay();
        }
    });
})();
