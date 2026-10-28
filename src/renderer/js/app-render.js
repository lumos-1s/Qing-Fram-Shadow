// 渲染模块：rAF 调度队列 / 拖动背景缓存 / 帧合成 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 渲染调度 ══ */
    // 单一 rAF 队列 + 脏标记。任意多次 scheduleRender 合并为「下一帧渲一次」,
    // 帧回调天然与屏幕刷新对齐,不会出现 setTimeout 落在两次 vblank 之间造成的撕裂/半帧感。
    // 取代旧的 setTimeout(dly) 尾随防抖:旧实现手势期要等 120ms 才出下一帧,手感明显拖尾。
    scheduleRender(immediate) {
        if (!this.image) return;
        this._renderDirty = true;
        // 手势拖动中(滑块/文本框聚焦)降频:按帧跳过,而不是靠定时器延迟
        this._renderUrgent = this._renderUrgent || !!immediate;
        this._renderSkip = immediate ? 0 : (this._gesture ? 2 : 0);
        if (this._renderRaf) return;
        this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
    },

    // 帧回调:按 _renderSkip 决定本帧是否真的合成。
    // 跳帧时把脏标记留着并重新排下一帧,保证手势结束前不会漏掉最后一次刷新。
    _drainRenderQueue() {
        this._renderRaf = 0;
        if (!this._renderDirty) return;
        if (this._renderSkip > 0) {
            this._renderSkip--;
            this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
            return;
        }
        this._renderDirty = false;
        this._renderSkip = 0;
        this._renderUrgent = false;
        this.renderPreview();
        // 兑现 flushRender 等待者:此时本帧已真正合成,调用方可安全读像素
        if (this._renderFlushResolvers.length) {
            const rs = this._renderFlushResolvers;
            this._renderFlushResolvers = [];
            rs.forEach(res => res());
        }
    },

    // 导出/测像素等必须等某一帧真正画完的场合用:提交渲染并同步等到该帧回调跑完。
    // 走同一个队列,避免与 scheduleRender 并行排两帧导致读到半成品。
    flushRender() {
        if (!this.image) return Promise.resolve();
        this._renderDirty = true;
        this._renderUrgent = true;
        this._renderSkip = 0;
        if (this._renderRaf) return new Promise(res => {
            const prev = this._renderFlushResolvers;
            prev.push(res);
            return undefined;
        });
        return new Promise(res => {
            this._renderFlushResolvers = [res];
            this._renderRaf = requestAnimationFrame(() => this._drainRenderQueue());
        });
    },

    // 照片切换时清空 AWT 样式缓存(模糊底/取色/高斯核)
    invalidateStyleCaches() {
        const es = window.EngineStyles;
        if (!es || typeof es.clearCaches !== 'function') return;
        try { es.clearCaches(); } catch (e) {}
    },

    // 模板是否已含有效边框设置(区别于默认原图模板)
    hasBorderSettings(t) {
        if (!t) return false;
        if (t.templateName || t.templateTag || t.photoFrameStyle) return true;
        const m = t.baseMargin;
        if (m) {
            if (m.marginTop || m.marginBottom || m.marginLeft || m.marginRight) return true;
            if (m.imgScale && m.imgScale !== 1) return true;
        }
        return false;
    },

    /* ══ 拖动叠加层:拖拽期间避免每帧全量重合成 ══
       问题:移动 logo/贴纸/文字时每帧都会走完整引擎(实测 52~143ms/帧,见 tools/measure-drag.js),
       而 logo 是最后绘制的一层,前面所有内容(照片+边框+光影)在拖动期间完全不变。
       做法:拖动首帧把"不含被拖元素"的整帧结果缓存成背景位图,之后每帧只 blit 背景 +
       重绘被拖元素 + 选择框/参考线,把每帧成本从「全量合成」降到「一次位图拷贝」。
       正确性:缓存键包含画布尺寸/模板引用/图源,任一变化即重建;拖动结束后清缓存并整帧重渲染。 */
    _dragBaseValid() {
        const c = this._dragBase;
        const cv = this.dom.canvas;
        return !!(c
            && c.bmp
            && c.w === cv.width && c.h === cv.height
            && c.tpl === this.template
            && c.img === (this.image && this.image.el));
    },

    _dragBaseBuild() {
        const canvas = this.dom.canvas;
        const bmp = document.createElement('canvas');
        bmp.width = canvas.width;
        bmp.height = canvas.height;
        // 此时被拖元素已从整帧绘制中排除,拷出来即是干净背景
        bmp.getContext('2d').drawImage(canvas, 0, 0);
        this._dragBase = { bmp, w: canvas.width, h: canvas.height, tpl: this.template, img: this.image && this.image.el };
    },

    _blitDragBase() {
        const canvas = this.dom.canvas;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 背景位图是在「拖动态当时」的画布尺寸下建的,而拖动期间 displayMax 会变(降级到 900 再复原),
        // 因此要按当前画布尺寸缩放贴回,否则会把小图直接摊在画布一角
        const b = this._dragBase.bmp;
        if (b.width === canvas.width && b.height === canvas.height) ctx.drawImage(b, 0, 0);
        else ctx.drawImage(b, 0, 0, b.width, b.height, 0, 0, canvas.width, canvas.height);
    },

    // 注意不再接收 cw/ch:元素几何一律按「基准画布」口径计算(与引擎 drawLogoElements 一致),
    // 传入最终画布尺寸反而会误用。保留参数位会让调用方以为尺寸有效,故直接去掉。
    _drawDraggedEl(ctx, el, kind) {
        if (!el) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 关键:引擎在 drawLogoElements 里用 canvas._logW/_logH(基准画布)作为 rel 比例的分母,
        // 即 rx/ry 是「相对基准画布」的比例,元素几何也在基准口径下计算。
        // 叠加层必须与引擎完全一致,否则拖动中元素位置/大小会与松手后不同(会跳一下)。
        // 因此这里不做额外缩放,直接按基准口径绘制(与引擎同一坐标系)。
        const ovBase = this.logoBaseForOverlay();
        if (kind === 'logo' || kind === 'sticker') {
            const src = kind === 'logo' ? el.dataUrl : el.src;
            if (!src) return;
            // 复用引擎的同一份位图缓存,避免拖动中重复解码
            const img = window.getElementBitmap ? window.getElementBitmap(src) : null;
            if (!img || !img.complete || !img.naturalWidth) return;
            const size = kind === 'logo' ? Math.max(2, el.size || 60) : 0;
            let dw, dh, cx, cy;
            if (kind === 'logo') {
                const ratio = img.naturalHeight / img.naturalWidth || 1;
                dw = size; dh = size * ratio;
                // 走 logoPos 统一解析 rel / 锚点 / 旧像素三种形式,并传基准口径尺寸
                const bp = this.logoPos(el, ovBase.w, ovBase.h, size);
                cx = bp.cx; cy = bp.cy;
            } else {
                dw = img.naturalWidth * (el.scale || 1);
                dh = img.naturalHeight * (el.scale || 1);
                cx = el.x || 0; cy = el.y || 0;
            }
            const op = el.opacity == null ? 100 : el.opacity;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, op / 100));
            ctx.translate(cx, cy);
            if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
            ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
        } else if (kind === 'text') {
            // 自由文字复用引擎绘制,同样传基准口径(引擎也是这么调的)
            if (el.text && el.align === 'free' && window.drawTextLine) {
                window.drawTextLine(ctx, el, ovBase.w, ovBase.h, false, 0, 0);
            }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    },

    _dropDragBase() { this._dragBase = null; },

    // 帧回调内同步执行整帧合成。旧实现在这里再套一层 rAF + token,
    // 与外层调度器构成双重排队,白白多等一帧,且 renderToken 的作废判断在同步体内永远为真、
    // 形同死代码。现在由 _drainRenderQueue 保证「每帧至多一次、且不丢最后一次」,这里直接画。
    renderPreview() {
        if (!this.image) return;
        this.renderToken++;
        // 对比原图是一次性旁路:取用本帧挂载的 compare 标记后立即清空,避免污染后续正常帧
        if (this._comparePending) {
            this._comparePending = false;
            window.__render(this, true);
            this.updateStatusBar();
            return;
        }
        this.draggingCompare = false;
        {
            // 交互进行中(格内拖动/平移/拖元素/手势)不得用旧快照替换当前模板,否则会将正在编辑的
            // 拼图平移/缩放瞬时回退到保存前的状态
            // 不再用 customSettings 替换 this.template,保持编辑对象引用稳定
            this.normalizeTemplate();
            this.dom.stage.classList.toggle('has-img', !!this.image);
            // 拖动中且背景缓存有效 → 只拷贝背景 + 重绘被拖元素,跳过整帧合成
            // (缓存键在校验尺寸/模板/图源,任一变即回落到正常整帧渲染)
            const dragRef = this._dragEl && this._dragEl.ref;
            if (dragRef && this._dragBaseValid()) {
                this._blitDragBase();
                this._drawDraggedEl(this.dom.canvas.getContext('2d'), dragRef, this._dragEl.kind);
                this.drawSelectionBox();
                this.drawLogoGuides();
                this.updateStatusBar();
                return;
            }
            // 未使用预设的图:画布直接展示原图;当前图只要有边框设置,就把最新模板写回该图记录
            // (既标记“已用预设”,也保证切走再切回时保留最新编辑)
            const im = this.image;
            if (this.hasBorderSettings(this.template)) this.setTpl(im, this.template);
            const assigned = !!this.getTpl(im);
            const previewTpl = assigned ? this.template : this.defaultTemplate();
            const prevTpl = this.template;
            this.template = previewTpl;
            // 拖动首帧:合成完整帧(此时被拖元素已被 _skipUserEl 排除)后缓存为背景,供后续帧复用
            const needDragBase = !!(dragRef && this._dragEl
                && (!this._dragBase || !this._dragBaseValid()));
            try {
                const puzzle = previewTpl && previewTpl.puzzle && previewTpl.puzzle.enabled;
                const fire = () => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false);
                    else window.__render(this, false);
                };
                fire();
                // 引擎在分辨率刚变化时首帧不稳定(实测同一路径连渲两次,首帧与次帧最大通道差可达 86),
                // 而缓存一旦建在这种帧上,整个拖动过程都会沿用错误背景。再渲一次取其稳定结果。
                if (needDragBase) fire();
            } finally {
                this.template = prevTpl;
            }
            if (needDragBase && this._dragEl) this._dragBaseBuild();
            this.drawSelectionBox();
            this.drawLogoGuides();
            if (this.autoFit) {
                this.autoFit = false;
                requestAnimationFrame(() => this.fitZoom());
            }
            this.updateStatusBar();
        }
    },

    // 把任意来源(.qfs / 模板 JSON / 旧草稿)的对象收成引擎能安全消费的形状。
    // 旧实现只判断 truthy:layerList 是字符串时也能过 `!t.layerList.length`,
    // 下一行 .forEach 直接抛异常 → 导入坏工程即白屏。
    coerceTemplate(t) {
        const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
        if (!isObj(t)) t = this.defaultTemplate();
        for (const k of ['baseMargin', 'cornerConfig', 'filmTearConfig', 'lightEffect', 'decorConfig']) {
            if (!isObj(t[k])) t[k] = {};
        }
        if (t._draftText) delete t._draftText;
        if (!Array.isArray(t.layerList)) t.layerList = [];
        t.layerList = t.layerList.filter(isObj).slice(0, 200);
        if (!t.layerList.length) {
            const dl = this.defaultTemplate().layerList;
            t.layerList = [(dl && dl[0]) || {}];
        }
        for (const lay of t.layerList) {
            if (!isObj(lay.fillConfig)) lay.fillConfig = {};
            if (!Array.isArray(lay.fillConfig.gradientStops)) {
                lay.fillConfig.gradientStops = [{ position: 0, color: 'eeeeee' }, { position: 1, color: 'bbbbbb' }];
            }
            if (!isObj(lay.strokeConfig)) lay.strokeConfig = {};
            if (!isObj(lay.shadowGlowConfig)) lay.shadowGlowConfig = {};
        }
        if (!Array.isArray(t.logoElements)) t.logoElements = [];
        t.logoElements = t.logoElements.filter(isObj).slice(0, 500);
        if (!isObj(t.puzzle)) t.puzzle = this.defaultTemplate().puzzle;
        for (const k of ['slots', 'axisVals', 'captions', 'gapCaptions']) {
            if (!isObj(t.puzzle[k])) t.puzzle[k] = {};
        }
        return t;
    },

    normalizeTemplate() {
        const t = this.coerceTemplate(this.template);
        this.template = t;
        // 旧格式(rx 以基准画布为分母)在此一次性换算为显示画布分数,须在引擎绘制前完成
        this.migrateRelCanvasFrac();
        if (t.baseMargin.refTop == null) {
            t.baseMargin.refTop = t.baseMargin.marginTop != null ? t.baseMargin.marginTop : 80;
            t.baseMargin.refBottom = t.baseMargin.marginBottom != null ? t.baseMargin.marginBottom : 120;
            t.baseMargin.refLeft = t.baseMargin.marginLeft != null ? t.baseMargin.marginLeft : 80;
            t.baseMargin.refRight = t.baseMargin.marginRight != null ? t.baseMargin.marginRight : 80;
        }
        const stripHash = (v) => (v == null ? '' : String(v)).replace(/^#+/, '');
        (t.layerList || []).forEach(lay => {
            if (lay.visible !== undefined) lay.visible = (lay.visible === false || lay.visible === 0) ? 0 : 1;
            const f = lay.fillConfig || {}, s = lay.strokeConfig || {}, sg = lay.shadowGlowConfig || {};
            if (f.fillHex) f.fillHex = stripHash(f.fillHex);
            (f.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (s.strokeColorHex) s.strokeColorHex = stripHash(s.strokeColorHex);
            (s.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (sg.shadowColorHex) sg.shadowColorHex = stripHash(sg.shadowColorHex);
            if (sg.glowColorHex) sg.glowColorHex = stripHash(sg.glowColorHex);
        });
    },

    requestRender() { this.scheduleRender(true); },

    setCompare(on) {
        if (!this.image) return;
        this.draggingCompare = on;
        const saved = this.getTpl(this.image);
        if (saved) this.template = saved;
        this.normalizeTemplate();
        // 走统一队列:与普通帧 FIFO,不再自排一条并行 rAF(那会让对比帧与
        // 已排队的正常帧争抢同一 vsync,谁先跑取决于注册顺序,表现为偶发闪回)
        this._comparePending = !!on;
        this.scheduleRender(true);
    },
});
