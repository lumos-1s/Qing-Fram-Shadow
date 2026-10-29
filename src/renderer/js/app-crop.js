// 照片裁切工具：工具栏「裁切」→ 全屏弹层里拖框 → 应用后把 im.el 换成裁好的位图。
//
// 交互与几何参考 we-cropper（github.com/we-plugin/we-cropper）：
//   · 遮罩用四块矩形拼出来（ctx.fillRect 四次），不整体 clip——整块 clip 后再 drawImage
//     在 Chromium 里会走裁剪慢路径，缩放照片还会出摩尔纹横线（engine.js 里也踩过同一个坑）；
//   · 越界一律夹回边界（we-cropper 的 outsideBound 是同一个思路，只是它夹图片、我们夹框）；
//   · 角标只画四个 L 形，不画完整描边，裁切框落在暗部照片上仍然看得清；
//   · 结果从原始位图按源坐标取，不从屏幕画布取——屏幕画布是 DPR 缩放过的，二次采样会糊。
//
// 与 we-cropper 的差别：它是「裁切框固定、拖图片」，这里是「图片固定、框自由」。
// 桌面端鼠标直接拉框更直觉，也不需要 pinch 缩放那套；比例锁定时改由锚点+宽高比反算另一条边。
const CROP_MIN_SRC = 8;      // 裁切框最小边长（源像素）

window.App = Object.assign(window.App || {}, {
    initCrop() {
        const $ = (id) => document.getElementById(id);
        const dom = {
            overlay: $('cropModal'),
            stage: $('cropStage'), canvas: $('cropCanvas'),
            size: $('cropSize'), ratios: $('cropRatios'), ratioInp: $('cropRatioCustom'),
            rotate: $('cropRotate'), reset: $('cropRevert'), restoreOrig: $('cropRestoreOriginal'),
            cancel: $('cropDiscard'), apply: $('cropApply'), close: $('cropClose')
        };
        if (!dom.overlay || !dom.canvas) return;
        this._cropDom = dom;
        this._crop = { open: false };

        const btn = $('btnCrop');
        if (btn) btn.addEventListener('click', () => this.openCrop());
        const btnRestore = $('btnRestoreOriginal');
        if (btnRestore) btnRestore.addEventListener('click', () => this.restoreOriginalPhoto());
        if (dom.close) dom.close.addEventListener('click', () => this.closeCrop());
        if (dom.cancel) dom.cancel.addEventListener('click', () => this.closeCrop());
        if (dom.apply) dom.apply.addEventListener('click', () => this.applyCrop());
        if (dom.rotate) dom.rotate.addEventListener('click', () => this.rotateCropImage());
        if (dom.reset) dom.reset.addEventListener('click', () => this.resetCrop());
        if (dom.restoreOrig) dom.restoreOrig.addEventListener('click', () => this.restoreCropSource());
        // 点弹层空白（不是卡片）也算取消：和系统弹窗一致，别逼用户找按钮
        if (dom.overlay) {
            dom.overlay.addEventListener('mousedown', (e) => {
                if (e.target === dom.overlay) this.closeCrop();
            });
        }

        if (dom.ratios) {
            dom.ratios.addEventListener('click', (e) => {
                const chip = (e.target instanceof Element) ? e.target.closest('[' + 'data-r]') : null;
                if (!chip) return;
                this.setCropRatio(chip.dataset.r);
            });
        }
        // 自定义比例：回车生效，失焦也生效（值没变就不重算，见 applyCustomCropRatio）
        if (dom.ratioInp) {
            dom.ratioInp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!this.applyCustomCropRatio()) {
                        dom.ratioInp.classList.add('is-bad');
                    }
                }
            });
            dom.ratioInp.addEventListener('input', () => dom.ratioInp.classList.remove('is-bad'));
            dom.ratioInp.addEventListener('blur', () => {
                if (this._crop && this._crop.open) this.applyCustomCropRatio();
            });
        }

        // 鼠标：按下在 canvas，移动/抬起挂 window —— 拖出窗口再松手不能把状态留在"拖拽中"
        dom.canvas.addEventListener('mousedown', (e) => this._cropDown(e));
        window.addEventListener('mousemove', (e) => this._cropMove(e));
        window.addEventListener('mouseup', () => this._cropUp());

        // 弹层尺寸变化（窗口缩放 / 侧栏折叠）后 canvas 要跟着改，否则坐标全错
        if (typeof ResizeObserver === 'function' && dom.stage) {
            this._cropRO = new ResizeObserver(() => {
                if (!this._crop || !this._crop.open) return;
                if (this._cropRaf) return;
                this._cropRaf = requestAnimationFrame(() => {
                    this._cropRaf = 0;
                    this.layoutCrop();
                });
            });
            this._cropRO.observe(dom.stage);
        }
    },

    // 打开裁切：以当前照片的位图为底，框默认铺满整张（不做"看起来像选区"的假内缩，
    // 否则用户直接点应用就白丢 8% 画面）
    openCrop() {
        const im = this.image;
        if (!im || !im.el) { this.setStatus('请先导入照片'); return false; }
        if (this._crop && this._crop.open) return true;
        const W = im.el.naturalWidth || im.w || 0;
        const H = im.el.naturalHeight || im.h || 0;
        if (!W || !H) { this.setStatus('这张照片还没加载完成，稍等一下再裁切'); return false; }
        const d = this._cropDom;
        if (!d) return false;
        this._crop = {
            open: true, src: im.el, W, H,
            box: { x: 0, y: 0, w: W, h: H },
            ratio: 0, ratioKey: 'free', customText: '',
            // 最小框边长：照片本身比 8px 还小时不能让下限比图还大
            minSide: Math.max(1, Math.min(CROP_MIN_SRC, W, H)),
            useOrig: false,
            drag: null, viewW: 0, viewH: 0, fit: 1, ox: 0, oy: 0, dpr: 1
        };
        d.overlay.style.display = 'flex';
        if (d.ratioInp) { d.ratioInp.value = ''; d.ratioInp.classList.remove('is-bad', 'is-on'); }
        this.syncCropChips();
        this.syncCropSize();
        this.syncCropOriginalBtn();
        // 先量再画：display:none → flex 之后才拿得到真实尺寸
        requestAnimationFrame(() => {
            if (!this._crop || !this._crop.open) return;
            this.layoutCrop();
            if (d.apply && d.apply.focus) { try { d.apply.focus({ preventScroll: true }); } catch (_) {} }
        });
        this._cropKey = (e) => this.onCropKey(e);
        document.addEventListener('keydown', this._cropKey, true);
        return true;
    },

    closeCrop(silent) {
        const d = this._cropDom;
        if (this._cropKey) {
            document.removeEventListener('keydown', this._cropKey, true);
            this._cropKey = null;
        }
        if (this._cropRaf) { cancelAnimationFrame(this._cropRaf); this._cropRaf = 0; }
        if (d && d.overlay) d.overlay.style.display = 'none';
        const wasOpen = !!(this._crop && this._crop.open);
        this._crop = { open: false };
        if (wasOpen && !silent) {
            const btn = document.getElementById('btnCrop');
            if (btn && btn.focus) { try { btn.focus({ preventScroll: true }); } catch (_) {} }
        }
        return wasOpen;
    },

    /* ══ 布局与绘制 ══ */
    layoutCrop() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d || !d.stage) return;
        const rect = d.stage.getBoundingClientRect();
        const vw = Math.max(1, Math.round(rect.width));
        const vh = Math.max(1, Math.round(rect.height));
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const cv = d.canvas;
        if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(vh * dpr)) {
            cv.width = Math.round(vw * dpr);
            cv.height = Math.round(vh * dpr);
        }
        cv.style.width = vw + 'px';
        cv.style.height = vh + 'px';
        st.viewW = vw; st.viewH = vh; st.dpr = dpr;
        // 图片等比放进裁切区（留 20px 呼吸），小图允许放大——否则 300px 的小图在
        // 1000px 的弹层里只有指甲盖大，根本抠不准框
        const pad = 20;
        let fit = Math.min((vw - pad * 2) / st.W, (vh - pad * 2) / st.H);
        if (!isFinite(fit) || fit <= 0) fit = 1;
        st.fit = Math.min(fit, 8);
        st.ox = (vw - st.W * st.fit) / 2;
        st.oy = (vh - st.H * st.fit) / 2;
        this.drawCrop();
    },

    // 源像素 → 画布 CSS 像素（绘制、命中、指针换算共用一套，避免三处各算一遍）
    cropRectOnScreen(box) {
        const st = this._crop;
        const b = box || st.box;
        return {
            x: st.ox + b.x * st.fit,
            y: st.oy + b.y * st.fit,
            w: b.w * st.fit,
            h: b.h * st.fit
        };
    },

    drawCrop() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d) return;
        const ctx = d.canvas.getContext('2d');
        const W = st.viewW, H = st.viewH;
        if (!W || !H) return;
        ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0D1211';
        ctx.fillRect(0, 0, W, H);
        // 底图：先整张画出来，再由遮罩把框外压暗（比"只画框内"更接近取景器手感）
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(st.src, st.ox, st.oy, st.W * st.fit, st.H * st.fit);

        const r = this.cropRectOnScreen();
        const bx = r.x, by = r.y, bw = r.w, bh = r.h;

        // 遮罩：四块矩形，避开裁剪态（见文件头注释）
        ctx.fillStyle = 'rgba(0,0,0,.58)';
        ctx.fillRect(0, 0, W, by);
        ctx.fillRect(0, by, bx, bh);
        ctx.fillRect(bx + bw, by, W - (bx + bw), bh);
        ctx.fillRect(0, by + bh, W, H - (by + bh));

        // 三分线：构图用的最轻提示，别抢框的视觉
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
            const gx = Math.round(bx + (bw * i) / 3) + .5;
            const gy = Math.round(by + (bh * i) / 3) + .5;
            ctx.moveTo(gx, by); ctx.lineTo(gx, by + bh);
            ctx.moveTo(bx, gy); ctx.lineTo(bx + bw, gy);
        }
        ctx.stroke();
        ctx.restore();

        // 框线 + 四个 L 角标（we-cropper 的 setBoundStyle 同款思路）
        ctx.strokeStyle = 'rgba(255,255,255,.62)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(bx) + .5, Math.round(by) + .5, Math.round(bw), Math.round(bh));
        const arm = Math.min(18, Math.max(8, Math.min(bw, bh) * 0.22));
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        // 左上
        ctx.moveTo(bx, by + arm); ctx.lineTo(bx, by); ctx.lineTo(bx + arm, by);
        // 右上
        ctx.moveTo(bx + bw - arm, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + arm);
        // 右下
        ctx.moveTo(bx + bw, by + bh - arm); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - arm, by + bh);
        // 左下
        ctx.moveTo(bx + arm, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - arm);
        ctx.stroke();

        // 8 个手柄：白方块 + 深描边，压在照片亮部也看得见
        const hs = 9;
        const pts = [
            [bx, by], [bx + bw / 2, by], [bx + bw, by],
            [bx + bw, by + bh / 2], [bx + bw, by + bh],
            [bx + bw / 2, by + bh], [bx, by + bh], [bx, by + bh / 2]
        ];
        for (const p of pts) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = 'rgba(0,0,0,.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(p[0] - hs / 2, p[1] - hs / 2, hs, hs);
            ctx.fill();
            ctx.stroke();
        }
    },

    /* ══ 命中与拖拽 ══ */
    // 画布 CSS 坐标 → 源像素坐标（夹在图片范围内：框永远不许跑到照片外面）
    cropPointToSource(p) {
        const st = this._crop;
        const x = (p.x - st.ox) / (st.fit || 1);
        const y = (p.y - st.oy) / (st.fit || 1);
        return {
            x: Math.max(0, Math.min(st.W, x)),
            y: Math.max(0, Math.min(st.H, y))
        };
    },

    cropEventPoint(e) {
        const rect = this._cropDom.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },

    // 命中顺序：手柄 > 框内 > 框外（框外算"重新框选"，和 PS 一致）
    cropHitTest(p) {
        const st = this._crop;
        if (!st || !st.open) return null;
        const r = this.cropRectOnScreen();
        const hs = 10;
        const near = (x, y) => Math.abs(p.x - x) <= hs && Math.abs(p.y - y) <= hs;
        if (near(r.x, r.y)) return 'nw';
        if (near(r.x + r.w, r.y)) return 'ne';
        if (near(r.x, r.y + r.h)) return 'sw';
        if (near(r.x + r.w, r.y + r.h)) return 'se';
        if (near(r.x + r.w / 2, r.y)) return 'n';
        if (near(r.x + r.w / 2, r.y + r.h)) return 's';
        if (near(r.x, r.y + r.h / 2)) return 'w';
        if (near(r.x + r.w, r.y + r.h / 2)) return 'e';
        if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return 'move';
        return null;
    },

    cropCursor(hit) {
        if (!hit) return 'crosshair';
        if (hit === 'move') return 'move';
        if (hit === 'nw' || hit === 'se') return 'nwse-resize';
        if (hit === 'ne' || hit === 'sw') return 'nesw-resize';
        if (hit === 'n' || hit === 's') return 'ns-resize';
        return 'ew-resize';
    },

    _cropDown(e) {
        const st = this._crop;
        if (!st || !st.open || e.button !== 0) return;
        e.preventDefault();
        const p = this.cropEventPoint(e);
        const hit = this.cropHitTest(p);
        const src = this.cropPointToSource(p);
        if (hit) {
            st.drag = { mode: hit, start: src, box0: { x: st.box.x, y: st.box.y, w: st.box.w, h: st.box.h } };
            return;
        }
        // 框外按下 = 从这里重新框选（起始为 0 尺寸，move 时再撑开）
        st.drag = { mode: 'new', start: src, box0: { x: src.x, y: src.y, w: 0, h: 0 } };
        st.box = { x: src.x, y: src.y, w: 0, h: 0 };
        this.syncCropSize();
        this.drawCrop();
    },

    _cropMove(e) {
        const st = this._crop;
        if (!st || !st.open) return;
        const p = this.cropEventPoint(e);
        if (!st.drag) {
            if (this._cropDom && this._cropDom.canvas) {
                this._cropDom.canvas.style.cursor = this.cropCursor(this.cropHitTest(p));
            }
            return;
        }
        const src = this.cropPointToSource(p);
        const mode = st.drag.mode;
        if (mode === 'move') {
            const dx = src.x - st.drag.start.x;
            const dy = src.y - st.drag.start.y;
            const b0 = st.drag.box0;
            st.box.x = Math.max(0, Math.min(st.W - b0.w, b0.x + dx));
            st.box.y = Math.max(0, Math.min(st.H - b0.h, b0.y + dy));
        } else if (mode === 'new') {
            st.box = this.cropBoxFromDrag(st.drag.start, src);
        } else {
            st.box = this.cropBoxFromResize(mode, src, st.drag.box0);
        }
        this.syncCropSize();
        this.drawCrop();
    },

    _cropUp() {
        const st = this._crop;
        if (!st || !st.open || !st.drag) return;
        const minS = st.minSide || CROP_MIN_SRC;
        // 点一下没拖动（框外单击）会把框收成 0 尺寸 —— 按最小尺寸兜一下，别留一个点
        if (st.box.w < minS || st.box.h < minS) {
            st.box = st.drag.box0.w >= minS ? st.drag.box0 : this.cropBoxFromDrag(st.drag.start, {
                x: st.drag.start.x + minS, y: st.drag.start.y + minS
            });
        }
        st.drag = null;
        this.syncCropSize();
        this.drawCrop();
    },

    // 框外拖拽：从起点到当前点归一化；锁比例时按较长边补成目标比例，
    // 补出来的部分顶出图片就整体缩回去（左上角不动，视觉上跟手）
    cropBoxFromDrag(a, b) {
        const st = this._crop;
        const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
        let w = Math.max(1, Math.abs(b.x - a.x));
        let h = Math.max(1, Math.abs(b.y - a.y));
        const r = st.ratio;
        if (r > 0) {
            if (w / h > r) h = w / r; else w = h * r;
            const k = Math.min(1, (st.W - x1) / w, (st.H - y1) / h);
            w *= k; h *= k;
        }
        return {
            x: Math.max(0, Math.min(x1, st.W - 1)),
            y: Math.max(0, Math.min(y1, st.H - 1)),
            w: Math.max(1, Math.min(w, st.W - x1)),
            h: Math.max(1, Math.min(h, st.H - y1))
        };
    },

    // 手柄缩放。自由比例：四个边各自夹紧、互不影响；锁定比例：以对边/对角为锚点，
    // 由拖拽方向的一条边反算另一条边，锚点不动（这样按住角拉时框不会"漂"）
    cropBoxFromResize(mode, p, box0) {
        const st = this._crop;
        const r = st.ratio;
        const minS = st.minSide || CROP_MIN_SRC;
        const hasW = mode.indexOf('w') >= 0, hasE = mode.indexOf('e') >= 0;
        const hasN = mode.indexOf('n') >= 0, hasS = mode.indexOf('s') >= 0;

        if (!(r > 0)) {
            let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
            if (hasW) x1 = Math.max(0, Math.min(x2 - minS, p.x));
            if (hasE) x2 = Math.min(st.W, Math.max(x1 + minS, p.x));
            if (hasN) y1 = Math.max(0, Math.min(y2 - minS, p.y));
            if (hasS) y2 = Math.min(st.H, Math.max(y1 + minS, p.y));
            return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
        }

        const dirX = hasE ? 1 : (hasW ? -1 : 0);
        const dirY = hasS ? 1 : (hasN ? -1 : 0);
        // 锚点：有方向的轴用对边，没方向的轴用中线（左右手柄拉宽时上下对称扩张）
        const ax = dirX ? (dirX > 0 ? box0.x : box0.x + box0.w) : box0.x + box0.w / 2;
        const ay = dirY ? (dirY > 0 ? box0.y : box0.y + box0.h) : box0.y + box0.h / 2;
        let w = dirX ? Math.abs(p.x - ax) : Math.abs(p.y - ay) * r;
        // 可用空间：有方向的轴受锚点到边界限制；没方向的轴两侧都要放得下
        const spaceX = dirX ? (dirX > 0 ? st.W - ax : ax) : 2 * Math.min(ax, st.W - ax);
        const spaceY = dirY ? (dirY > 0 ? st.H - ay : ay) : 2 * Math.min(ay, st.H - ay);
        const maxW = Math.max(1, Math.min(spaceX, spaceY * r));   // 该比例下放得下的最大宽
        w = Math.max(Math.min(minS, maxW), Math.min(maxW, w));     // 下限不能超过上限
        const h = w / r;
        return {
            x: dirX ? (dirX > 0 ? ax : ax - w) : ax - w / 2,
            y: dirY ? (dirY > 0 ? ay : ay - h) : ay - h / 2,
            w, h
        };
    },

    /* ══ 比例 / 旋转 / 还原 ══ */
    // data-r：free / orig / 'w:h'。orig 取当前工作图的宽高比
    cropRatioValue(key) {
        const st = this._crop;
        if (!st || !st.open) return 0;
        if (!key || key === 'free') return 0;
        if (key === 'orig') return st.W / st.H;
        const m = String(key).split(':');
        const w = Number(m[0]), h = Number(m[1]);
        return (w > 0 && h > 0) ? w / h : 0;
    },

    setCropRatio(key) {
        const st = this._crop;
        if (!st || !st.open) return;
        // 点预设比例 = 放弃自定义输入框里的内容，否则"输入框还亮着、框却是 1:1"会自相矛盾
        if (this._cropDom && this._cropDom.ratioInp) this._cropDom.ratioInp.value = '';
        st.customText = '';
        this.applyCropRatioValue(this.cropRatioValue(key), key || 'free');
    },

    // 把「比例 = 宽/高」落到框上：切比例时框重置成该比例下能放的最大框并居中，
    // 这样 1:1 / 16:9 切换一眼能看出差别，而不是在原框上硬掰出一个歪比例。
    // 极端比例（100:1 之类）按"最短边不小于 minSide"夹一下，免得框被压成一条线。
    applyCropRatioValue(r, key) {
        const st = this._crop;
        if (!st || !st.open) return;
        const minS = st.minSide || CROP_MIN_SRC;
        let ratio = Number(r) > 0 ? Number(r) : 0;
        if (ratio > 0) {
            const maxR = st.W / minS;
            const minR = minS / st.H;
            ratio = Math.min(maxR, Math.max(minR, ratio));
        }
        st.ratio = ratio;
        st.ratioKey = key || 'free';
        if (ratio > 0) {
            const w = st.W / st.H > ratio ? st.H * ratio : st.W;
            const h = w / ratio;
            st.box = { x: (st.W - w) / 2, y: (st.H - h) / 2, w, h };
        }
        this.syncCropChips();
        this.syncCropSize();
        this.drawCrop();
    },

    // 解析用户输入：5:7 / 16：9（全角）/ 16/9 / 2.35 / 1.5x2 都收
    parseCropRatio(text) {
        let s = String(text == null ? '' : text).trim();
        if (!s) return 0;
        s = s.replace(/：/g, ':').replace(/[×xX*]/g, ':').replace(/／/g, '/').replace(/\s+/g, '');
        const m = s.split(/[:/]/);
        if (m.length >= 2) {
            const w = Number(m[0]), h = Number(m[1]);
            if (w > 0 && h > 0 && isFinite(w) && isFinite(h)) return w / h;
            return 0;
        }
        const v = Number(s);
        return (v > 0 && isFinite(v)) ? v : 0;
    },

    // 输入框里的比例：回车或失焦生效。值没变就不重算（否则点「应用」时的 blur
    // 会把用户刚拖好的框又重置成最大框）
    applyCustomCropRatio() {
        const st = this._crop, d = this._cropDom;
        if (!st || !st.open || !d || !d.ratioInp) return false;
        const raw = d.ratioInp.value.trim();
        if (raw === (st.customText || '')) return false;
        const r = this.parseCropRatio(raw);
        if (!(r > 0)) {
            d.ratioInp.classList.add('is-bad');
            return false;
        }
        d.ratioInp.classList.remove('is-bad');
        st.customText = raw;
        this.applyCropRatioValue(r, 'custom');
        return true;
    },

    syncCropChips() {
        const d = this._cropDom;
        const st = this._crop;
        if (!d || !d.ratios || !st) return;
        for (const chip of d.ratios.querySelectorAll('[' + 'data-r]')) {
            const on = chip.dataset.r === (st.ratioKey || 'free');
            chip.classList.toggle('is-on', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        if (d.ratioInp) {
            const custom = st.ratioKey === 'custom';
            d.ratioInp.classList.toggle('is-on', custom);
            if (!custom) d.ratioInp.classList.remove('is-bad');
        }
    },

    syncCropSize() {
        const d = this._cropDom, st = this._crop;
        if (!d || !d.size || !st || !st.open) return;
        const w = Math.max(1, Math.round(st.box.w));
        const h = Math.max(1, Math.round(st.box.h));
        const pct = Math.round((w * h * 100) / (st.W * st.H));
        d.size.textContent = w + ' × ' + h + ' px · ' + pct + '%';
    },

    // 旋转只作用于这次裁切：把工作位图转 90°，框重置为整张（比例锁保留）
    rotateCropImage() {
        const st = this._crop;
        if (!st || !st.open) return;
        const c = document.createElement('canvas');
        c.width = st.H;
        c.height = st.W;
        const ctx = c.getContext('2d');
        ctx.translate(st.H / 2, st.W / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(st.src, -st.W / 2, -st.H / 2);
        st.src = c;
        const W = st.W;
        st.W = st.H;
        st.H = W;
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        if (st.ratioKey === 'orig') { st.ratio = st.W / st.H; }
        // 先按新宽高重算 fit，再套用比例：否则 1:1 的框会按旋转前的缩放画一次
        this.layoutCrop();
        if (st.ratio > 0) this.applyCropRatioValue(st.ratio, st.ratioKey);
        this.syncCropSize();
    },

    resetCrop() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im || !im.el) return;
        st.src = im.el;
        st.W = im.el.naturalWidth || im.w || st.W;
        st.H = im.el.naturalHeight || im.h || st.H;
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        st.ratio = 0;
        st.ratioKey = 'free';
        st.customText = '';
        st.useOrig = false;
        if (this._cropDom && this._cropDom.ratioInp) {
            this._cropDom.ratioInp.value = '';
            this._cropDom.ratioInp.classList.remove('is-bad');
        }
        this.syncCropChips();
        this.layoutCrop();
        this.syncCropSize();
    },

    /* ══ 原图备份 / 还原 ══ */
    // 第一次动位图（裁切或旋转）前把原始 Image 留一份。只留引用、不复制像素：
    // 解码后的位图本来就在内存里，多留一个引用几乎不增加开销，但能一键回到原图。
    // 只保留"最初那张"：连裁两次之后还原，回的仍然是最早的原图。
    savePhotoOrigin(im) {
        const t = im || this.image;
        if (!t || !t.el || t.orig) return false;
        t.orig = {
            el: t.el,
            w: t.el.naturalWidth || t.w || 0,
            h: t.el.naturalHeight || t.h || 0
        };
        return true;
    },

    // 把照片换回原图（工具栏右键 / 裁切弹层共用）。返回是否真的还原了
    restoreOriginalPhoto(im, opts) {
        const t = im || this.image;
        if (!t || !t.orig || !t.orig.el) return false;
        t.el = t.orig.el;
        t.w = t.orig.w;
        t.h = t.orig.h;
        delete t.orig;
        t.thumb = null;
        t._tqAt = 0;
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        if (this.queueThumb) this.queueThumb(t);
        if (this.buildThumbnails) this.buildThumbnails();
        this.scheduleRender(true);
        this.syncCropOriginalBtn();
        if (!opts || !opts.silent) this.setStatus('已还原为原图');
        return true;
    },

    // 裁切弹层里的「还原原图」：不立刻落盘，只把工作底图换成原图，
    // 用户可以按原图重新框一次；直接点应用则等于撤销之前的裁切。
    restoreCropSource() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im || !im.orig) return false;
        st.src = im.orig.el;
        st.W = im.orig.w || im.orig.el.naturalWidth || st.W;
        st.H = im.orig.h || im.orig.el.naturalHeight || st.H;
        st.minSide = Math.max(1, Math.min(CROP_MIN_SRC, st.W, st.H));
        st.box = { x: 0, y: 0, w: st.W, h: st.H };
        st.ratio = 0;
        st.ratioKey = 'free';
        st.customText = '';
        st.useOrig = true;
        if (this._cropDom && this._cropDom.ratioInp) {
            this._cropDom.ratioInp.value = '';
            this._cropDom.ratioInp.classList.remove('is-bad');
        }
        this.syncCropChips();
        this.layoutCrop();
        this.syncCropSize();
        this.setStatus('已切回原图，按原图重新框选后点应用；直接应用则撤销之前的裁切');
        return true;
    },

    // 「还原原图」有两处：右侧栏照片组（常驻入口）、裁切弹层（框内入口）。
    // 统一在这里按"当前照片有没有原始备份"决定显隐，避免两处各写一套判断。
    syncCropOriginalBtn() {
        const has = !!(this.image && this.image.orig);
        const d = this._cropDom;
        if (d && d.restoreOrig) d.restoreOrig.hidden = !has;
        const side = document.getElementById('btnRestoreOriginal');
        if (side) side.hidden = !has;
    },

    onCropKey(e) {
        const st = this._crop;
        if (!st || !st.open) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            // 焦点在自定义比例输入框里：打字/退格归它，只有 Esc 仍然整体关闭
            if (e.key === 'Escape') { e.preventDefault(); this.closeCrop(); }
            return;
        }
        // 其余情况键盘全归我管：拦在捕获阶段，别让画布的 Delete/Esc 抢走
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); this.closeCrop(); return; }
        if (e.key === 'Enter') { e.preventDefault(); this.applyCrop(); return; }
        const step = e.shiftKey ? 10 : 1;
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        else return;
        e.preventDefault();
        const b = st.box;
        b.x = Math.max(0, Math.min(st.W - b.w, b.x + dx));
        b.y = Math.max(0, Math.min(st.H - b.h, b.y + dy));
        this.syncCropSize();
        this.drawCrop();
    },

    /* ══ 应用 ══ */
    async applyCrop() {
        const st = this._crop, im = this.image;
        if (!st || !st.open || !im) return false;
        const x = Math.max(0, Math.round(st.box.x));
        const y = Math.max(0, Math.round(st.box.y));
        const w = Math.max(1, Math.min(st.W - x, Math.round(st.box.w)));
        const h = Math.max(1, Math.min(st.H - y, Math.round(st.box.h)));
        const fullBox = x === 0 && y === 0 && w === st.W && h === st.H;
        // 点了「还原原图」又没重新框：直接换回原图，别绕一圈重新编码
        if (st.useOrig && fullBox) {
            const ok = this.restoreOriginalPhoto(im, { silent: true });
            this.closeCrop(true);
            this.setStatus(ok ? '已还原为原图' : '没有改动，照片未做处理');
            return ok;
        }
        // 没动过框也没旋转：不重编码，避免"点一下应用，画质掉一层"
        const untouched = st.src === im.el && fullBox;
        if (untouched) {
            this.closeCrop(true);
            this.setStatus('没有改动，照片未做处理');
            return false;
        }
        // 换掉位图之前先留一份原图：裁切本身不可撤销，但"回到原图"必须一直可用
        this.savePhotoOrigin(im);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(st.src, x, y, w, h, 0, 0, w, h);
        // PNG 而不是 JPEG：裁切不该顺手做一次有损压缩（导出格式由导出设置决定）
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        if (!blob) { this.setStatus('裁切失败：无法生成图片'); return false; }
        const url = URL.createObjectURL(blob);
        const out = new Image();
        await new Promise((r) => { out.onload = r; out.onerror = r; out.src = url; });
        URL.revokeObjectURL(url);
        if (!out.naturalWidth) { this.setStatus('裁切失败：图片解码出错'); return false; }

        im.el = out;                 // 渲染/导出/拼图都直接取 im.el，换掉即全面生效
        im.w = w;
        im.h = h;
        // 缩略图必须重做：不清掉 thumb 的话 queueThumb 会认为"350ms 内刚做过"直接跳过
        im.thumb = null;
        im._tqAt = 0;
        this.closeCrop(true);
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        // 位图已换，调色缓存失效；参数保留，渲染时在新底图上重放
        if (this.invalidateGrade) this.invalidateGrade(im);
        if (this.queueThumb) this.queueThumb(im);
        if (this.buildThumbnails) this.buildThumbnails();
        this.scheduleRender(true);
        this.setStatus('已裁切为 ' + w + ' × ' + h + '，导出与拼图都用这张');
        this.syncCropOriginalBtn();
        return true;
    }
});
