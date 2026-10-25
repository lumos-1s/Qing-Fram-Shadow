// 沉浸式照片展示：照片墙 + 中央毛玻璃展示
// 只做「看」：不切换当前编辑图、不改选区、不改缩放/平移。退出必须原样回到编辑器。
window.App = Object.assign(window.App || {}, {
    initImmersive() {
        if (this._immersiveBound) return;
        this._immersiveBound = true;

        const $ = (id) => document.getElementById(id);
        const el = this._immersiveDom = {
            overlay: $('immersion'),
            wall: $('immersionWall'),
            card: $('immersionCard'),
            stage: $('immersionStage'),
            imgA: $('immersionImgA'),
            imgB: $('immersionImgB'),
            loading: $('immersionLoading'),
            close: $('immersionClose'),
            prev: $('immersionPrev'),
            next: $('immersionNext'),
            count: $('immersionCount'),
            no: $('immersionNo'),
            file: $('immersionFile'),
            preset: $('immersionPreset'),
            trigger: $('btnImmersive')
        };
        if (!el.overlay) return;

        if (el.trigger) el.trigger.addEventListener('click', () => this.openImmersive());
        el.close.addEventListener('click', () => this.closeImmersive());
        el.prev.addEventListener('click', () => this.stepImmersive(-1));
        el.next.addEventListener('click', () => this.stepImmersive(1));

        // 捕获阶段处理，避免编辑器的方向键/空格/快捷键在弹层打开时抢事件
        document.addEventListener('keydown', (event) => this._onImmersiveKey(event), true);
        window.addEventListener('pointermove', () => this.wakeImmersiveChrome(), { passive: true });
        window.addEventListener('pointerdown', () => this.wakeImmersiveChrome(), { passive: true });
        window.addEventListener('wheel', () => this.wakeImmersiveChrome(), { passive: true });
        window.addEventListener('resize', () => {
            if (!this._immersionOpen) return;
            clearTimeout(this._immersionResizeTimer);
            this._immersionResizeTimer = setTimeout(() => this.layoutImmersiveWall(true), 120);
        });

        this.updateImmersiveEntry();
    },

    // 画布右上角入口：没有照片时隐藏；勾选多张时提示会展示勾选顺序
    updateImmersiveEntry() {
        const btn = (this._immersiveDom && this._immersiveDom.trigger) || document.getElementById('btnImmersive');
        if (!btn) return;
        const n = (this.images && this.images.length) || 0;
        const selected = (this.batchSel && this.batchSel.length > 1) ? this.batchSel.length : 0;
        btn.hidden = n === 0;
        btn.disabled = n === 0;
        if (n === 0) {
            btn.title = '先导入照片';
            btn.setAttribute('aria-label', '先导入照片');
            return;
        }
        const mod = typeof this.modKeyLabel === 'function' ? this.modKeyLabel() : 'Ctrl';
        btn.title = selected
            ? `沉浸展示勾选的 ${selected} 张 (${mod}+Shift+P)`
            : `全屏沉浸展示 (${mod}+Shift+P)`;
        btn.setAttribute('aria-label', selected ? `沉浸展示勾选的 ${selected} 张照片` : '全屏沉浸展示');
    },

    openImmersive() {
        if (this._immersionOpen) return;
        if (!this.images || !this.images.length) {
            this.setStatus('先导入照片，再进入沉浸展示');
            return;
        }
        const otherModal = Array.from(document.querySelectorAll('.modal-overlay'))
            .some((m) => {
                const cs = getComputedStyle(m);
                return cs.display !== 'none' && cs.visibility !== 'hidden' && m.getClientRects().length > 0;
            });
        if (otherModal) {
            this.setStatus('先关闭当前弹窗，再进入沉浸展示');
            return;
        }

        const list = this.immersionList();
        if (!list.length) {
            this.setStatus('没有可展示的照片');
            return;
        }

        const start = Math.max(0, list.findIndex((item) => item.im === this.image));
        const state = {
            list,
            index: start,
            front: 'a',
            loadToken: 0,
            renderToken: 0,
            renderTimer: 0,
            cache: new Map(),
            tileW: 220,
            tileH: 268,
            wallGap: 12,
            wallCols: 6,
            wallRows: 4,
            stageAspect: 0,
            lastFocus: document.activeElement
        };
        this._immersion = state;
        this._immersionOpen = true;
        // 展示期间不响应编辑器的“适应窗口”重算，退出后保留原缩放/平移
        clearTimeout(this._fitResizeT);

        if (typeof this.closeCtx === 'function') this.closeCtx();
        const exportPop = document.getElementById('exportPop');
        if (exportPop) exportPop.style.display = 'none';

        const el = this._immersiveDom;
        clearTimeout(this._immersionIdleTimer);
        clearTimeout(this._immersionResizeTimer);
        [el.imgA, el.imgB].forEach((img) => {
            img.classList.remove('is-front');
            img.removeAttribute('src');
            img.alt = '';
            img.onload = null;
            img.onerror = null;
        });
        el.loading.classList.remove('is-on');
        el.overlay.hidden = false;
        el.overlay.setAttribute('aria-hidden', 'false');
        el.overlay.classList.remove('is-idle');
        el.overlay.classList.toggle('is-single', list.length <= 1);
        document.body.classList.add('immersion-open');

        const app = document.getElementById('app');
        if (app) app.setAttribute('inert', '');

        this.layoutImmersiveWall(true);
        this.showImmersiveAt(start, { immediate: true });
        this.wakeImmersiveChrome();

        requestAnimationFrame(() => {
            if (this._immersionOpen) el.close.focus({ preventScroll: true });
        });
    },

    closeImmersive() {
        if (!this._immersionOpen) return;
        const state = this._immersion;
        const el = this._immersiveDom;
        const last = state && state.lastFocus;

        this._immersionOpen = false;
        clearTimeout(this._immersionIdleTimer);
        clearTimeout(this._immersionResizeTimer);
        if (state) clearTimeout(state.renderTimer);
        this._immersion = null;

        if (el) {
            el.overlay.classList.remove('is-idle');
            el.overlay.classList.remove('is-single');
            el.overlay.hidden = true;
            el.overlay.setAttribute('aria-hidden', 'true');
            el.wall.replaceChildren();
            el.card.style.width = '';
            el.stage.style.width = '';
            el.stage.style.height = '';
            [el.imgA, el.imgB].forEach((img) => {
                img.classList.remove('is-front');
                img.removeAttribute('src');
                img.alt = '';
                img.onload = null;
                img.onerror = null;
            });
            el.loading.classList.remove('is-on');
        }

        document.body.classList.remove('immersion-open');
        const app = document.getElementById('app');
        if (app) app.removeAttribute('inert');
        if (last && last.isConnected && typeof last.focus === 'function') {
            try { last.focus({ preventScroll: true }); } catch (_) {}
        }
    },

    // 有勾选（>1 张）就按勾选顺序；否则按胶片条顺序
    immersionList() {
        const all = this.images || [];
        const picked = (this.batchSel && this.batchSel.length > 1)
            ? this.batchSel.map((i) => all[i]).filter(Boolean)
            : all.slice();
        const seen = new Set();
        return picked.filter((im) => {
            if (!im || seen.has(im)) return false;
            seen.add(im);
            return true;
        }).map((im) => ({
            im,
            name: im.name || '未命名照片',
            preset: this.immersionPresetName(im),
            wallSrc: im.thumb || (im.el && im.el.src) || ''
        }));
    },

    immersionPresetName(im) {
        const saved = this.getTpl(im);
        const tpl = (im === this.image ? (this.template || saved) : (saved || this.template))
            || (this.defaultTemplate ? this.defaultTemplate() : null);
        const name = tpl && (tpl.templateName || tpl.photoFrameStyle);
        return name || '原图';
    },

    // 让毛玻璃卡片跟着成片比例走：横片更宽，竖片更窄，不再留出一大片空玻璃。
    fitImmersiveCard(aspect) {
        const state = this._immersion;
        const el = this._immersiveDom;
        if (!state || !el || !el.card || !el.stage) return;
        if (!aspect || !isFinite(aspect) || aspect <= 0) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const compact = vw <= 1100;
        const maxCard = Math.min(vw * (compact ? 0.78 : 0.74), 1120);
        const cs = getComputedStyle(el.card);
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const maxStageW = Math.max(180, maxCard - padX);
        const maxStageH = Math.min(vh * (compact ? 0.64 : 0.66), 680);
        let stageW = maxStageW;
        let stageH = stageW / aspect;
        if (stageH > maxStageH) {
            stageH = maxStageH;
            stageW = stageH * aspect;
        }
        stageW = Math.max(160, Math.min(stageW, maxStageW));
        stageH = Math.max(120, Math.min(stageH, maxStageH));
        state.stageAspect = aspect;
        el.stage.style.width = Math.round(stageW) + 'px';
        el.stage.style.height = Math.round(stageH) + 'px';
        el.card.style.width = Math.round(stageW + padX) + 'px';
    },

    // 与缩略图口径一致：有独立模板用独立模板；没有则沿用当前模板，但剔除用户元素，
    // 避免当前图的 logo/贴纸/自由文字串到别的照片上。
    immersionTemplateFor(im) {
        const saved = this.getTpl(im);
        const current = im === this.image;
        let tpl = current ? (this.template || saved) : (saved || this.template);
        if (!tpl && this.defaultTemplate) tpl = this.defaultTemplate();
        if (!tpl) return null;
        tpl = JSON.parse(JSON.stringify(tpl));
        if (!current && !saved) {
            delete tpl.logoElements;
            if (tpl.decorConfig) {
                delete tpl.decorConfig.stickers;
                delete tpl.decorConfig.textLines;
            }
        }
        return tpl;
    },

    // 离屏渲染一张高分辨率的装框成品。不能碰主画布、当前图、当前模板、选区、缩放。
    renderImmersionFrame(im) {
        const fallback = im && (im.thumb || (im.el && im.el.src)) || '';
        if (!im || !im.el || !window.__render || !this.dom) return fallback;
        const tpl = this.immersionTemplateFor(im);
        if (!tpl) return fallback;

        const prev = {
            canvas: this.dom.canvas,
            displayMax: this.displayMax,
            uiDprOverride: this.uiDprOverride,
            image: this.image,
            template: this.template,
            selectedEls: this.selectedEls
        };
        const cv = document.createElement('canvas');
        cv.width = 1;
        cv.height = 1;
        cv.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;pointer-events:none;';
        try {
            this.dom.canvas = cv;
            this.displayMax = 1800;
            this.uiDprOverride = 1;
            this.image = im;
            this.template = tpl;
            // 引擎在画布尺寸变化时会 requestAnimationFrame(fitZoom())；给一个假选区阻止它，
            // 否则展示一次回来会污染用户当前缩放。渲染完立即还原。
            this.selectedEls = [{ kind: 'immersive', obj: {} }];
            window.__render(this, false);
            const webp = cv.toDataURL('image/webp', 0.94);
            if (webp && webp.indexOf('data:image/webp') === 0) return webp;
            return cv.toDataURL('image/jpeg', 0.94) || fallback;
        } catch (_) {
            return fallback;
        } finally {
            this.dom.canvas = prev.canvas;
            if (prev.displayMax === undefined) delete this.displayMax; else this.displayMax = prev.displayMax;
            if (prev.uiDprOverride === undefined) delete this.uiDprOverride; else this.uiDprOverride = prev.uiDprOverride;
            this.image = prev.image;
            this.template = prev.template;
            this.selectedEls = prev.selectedEls;
        }
    },

    layoutImmersiveWall(rebuild) {
        const state = this._immersion;
        const el = this._immersiveDom;
        if (!state || !el || !el.wall) return;
        const vw = el.overlay.clientWidth || window.innerWidth;
        const vh = el.overlay.clientHeight || window.innerHeight;
        const gap = 12;
        const tileW = Math.max(156, Math.min(246, Math.round(vw / 6)));
        const tileH = Math.round(tileW * 1.22);
        const cols = Math.max(5, Math.ceil(vw / (tileW + gap)) + 1);
        const rows = Math.max(4, Math.ceil(vh / (tileH + gap)) + 1);

        state.tileW = tileW;
        state.tileH = tileH;
        state.wallGap = gap;
        state.wallCols = cols;
        state.wallRows = rows;
        el.wall.style.setProperty('--imm-cols', String(cols));
        el.wall.style.setProperty('--imm-rows', String(rows));
        el.wall.style.setProperty('--imm-tile-w', tileW + 'px');
        el.wall.style.setProperty('--imm-tile-h', tileH + 'px');
        el.wall.style.setProperty('--imm-gap', gap + 'px');

        if (rebuild || !el.wall.childElementCount) {
            const total = cols * rows;
            const frag = document.createDocumentFragment();
            for (let i = 0; i < total; i++) {
                const item = state.list[i % state.list.length];
                const tile = document.createElement('div');
                tile.className = 'immersion-tile';
                tile.dataset.index = String(i % state.list.length);
                if (item && item.wallSrc) {
                    const img = document.createElement('img');
                    img.src = item.wallSrc;
                    img.alt = '';
                    img.draggable = false;
                    tile.appendChild(img);
                }
                frag.appendChild(tile);
            }
            el.wall.replaceChildren(frag);
        }
        this.updateImmersiveWall();
        if (state.stageAspect) this.fitImmersiveCard(state.stageAspect);
    },

    updateImmersiveWall() {
        const state = this._immersion;
        const el = this._immersiveDom;
        if (!state || !el || !el.wall) return;
        const current = state.index;
        Array.from(el.wall.children).forEach((tile) => {
            tile.classList.toggle('is-current', Number(tile.dataset.index) === current);
        });
        const stepX = state.tileW + state.wallGap;
        const stepY = state.tileH + state.wallGap;
        const col = current % state.wallCols;
        const row = Math.floor(current / state.wallCols) % state.wallRows;
        const x = -((col - (state.wallCols - 1) / 2) * stepX * 0.18);
        const y = -((row - (state.wallRows - 1) / 2) * stepY * 0.14);
        el.wall.style.setProperty('--imm-x', x.toFixed(1) + 'px');
        el.wall.style.setProperty('--imm-y', y.toFixed(1) + 'px');
    },

    showImmersiveAt(index, opts) {
        const state = this._immersion;
        const el = this._immersiveDom;
        if (!state || !el) return;
        const n = state.list.length;
        if (!n) return;
        state.index = ((index % n) + n) % n;
        const item = state.list[state.index];
        const no = String(state.index + 1).padStart(2, '0');
        el.no.textContent = no;
        el.count.textContent = `${no} / ${String(n).padStart(2, '0')}`;
        el.file.textContent = item.name;
        el.file.title = item.name;
        el.preset.textContent = item.preset;
        el.preset.title = item.preset;

        this.showImmersiveLayer(state, item.wallSrc, item.name, !!(opts && opts.immediate));
        this.updateImmersiveWall();
        this.startImmersiveRender(state.index);
        this.wakeImmersiveChrome();
    },

    // 两个 img 交叉淡入；新图 onload 后再撤掉旧图，避免切换时闪黑
    showImmersiveLayer(state, src, alt, immediate) {
        const el = this._immersiveDom;
        const current = state.front === 'a' ? el.imgA : el.imgB;
        let next = current;
        let old = null;
        if (immediate || !current) {
            state.front = 'a';
            next = el.imgA;
            old = el.imgB;
        } else {
            next = current === el.imgA ? el.imgB : el.imgA;
            old = current;
            state.front = next === el.imgA ? 'a' : 'b';
        }
        next.alt = alt || '';
        const token = ++state.loadToken;
        const commit = () => {
            if (this._immersion !== state || state.loadToken !== token) return;
            next.classList.add('is-front');
            if (old && old !== next) old.classList.remove('is-front');
            if (next.naturalWidth && next.naturalHeight) {
                this.fitImmersiveCard(next.naturalWidth / next.naturalHeight);
            }
        };
        next.onload = commit;
        next.onerror = () => {
            if (this._immersion !== state || state.loadToken !== token) return;
            if (old && old !== next) old.classList.add('is-front');
        };
        if (src) {
            next.src = src;
            if (next.complete && next.naturalWidth) commit();
        } else {
            commit();
        }
    },

    startImmersiveRender(index) {
        const state = this._immersion;
        const el = this._immersiveDom;
        if (!state || !el) return;
        const item = state.list[index];
        if (!item) return;
        const token = ++state.renderToken;
        clearTimeout(state.renderTimer);
        if (state.cache.has(item.im)) {
            this.applyImmersiveFrame(state, index, state.cache.get(item.im));
            return;
        }
        el.loading.classList.add('is-on');
        // 先让低清缩略图/原图完成一帧，再同步离屏渲染高分辨率版本
        state.renderTimer = setTimeout(() => {
            if (!this._immersion || this._immersion !== state || state.index !== index || state.renderToken !== token) return;
            const data = this.renderImmersionFrame(item.im);
            if (!this._immersion || this._immersion !== state || state.index !== index || state.renderToken !== token) return;
            if (data) {
                state.cache.set(item.im, data);
                // 展示几十张时不要把每一张 1800px 成品都留在内存里
                if (state.cache.size > 8) state.cache.delete(state.cache.keys().next().value);
            }
            this.applyImmersiveFrame(state, index, data);
        }, 40);
    },

    applyImmersiveFrame(state, index, src) {
        const el = this._immersiveDom;
        if (!el) return;
        if (!src) {
            el.loading.classList.remove('is-on');
            return;
        }
        const img = state.front === 'a' ? el.imgA : el.imgB;
        if (!img) return;
        if (img.getAttribute('src') === src) {
            img.classList.add('is-front');
            this.fitImmersiveCard(img.naturalWidth / img.naturalHeight);
            el.loading.classList.remove('is-on');
            return;
        }
        const token = ++state.loadToken;
        const commit = () => {
            if (this._immersion !== state || state.loadToken !== token) return;
            img.classList.add('is-front');
            const other = img === el.imgA ? el.imgB : el.imgA;
            other.classList.remove('is-front');
            this.fitImmersiveCard(img.naturalWidth / img.naturalHeight);
            el.loading.classList.remove('is-on');
        };
        img.onload = commit;
        img.onerror = () => {
            if (this._immersion === state && state.loadToken === token) el.loading.classList.remove('is-on');
        };
        img.src = src;
        if (img.complete && img.naturalWidth) commit();
    },

    stepImmersive(delta) {
        if (!this._immersionOpen || !this._immersion) return;
        if (this._immersion.list.length <= 1) return;
        this.showImmersiveAt(this._immersion.index + delta);
    },

    wakeImmersiveChrome() {
        if (!this._immersionOpen || !this._immersiveDom) return;
        const el = this._immersiveDom;
        clearTimeout(this._immersionIdleTimer);
        el.overlay.classList.remove('is-idle');
        this._immersionIdleTimer = setTimeout(() => {
            if (!this._immersionOpen || !this._immersion) return;
            el.overlay.classList.add('is-idle');
            // 工具层隐藏后不要留一个看不见的焦点，避免回车误触关闭
            const active = document.activeElement;
            if (active && el.overlay.contains(active) && active.blur) active.blur();
        }, 2000);
    },

    _onImmersiveKey(event) {
        if (!this._immersionOpen) return;
        const el = this._immersiveDom;
        if (!el) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closeImmersive();
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            this.stepImmersive(-1);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            this.stepImmersive(1);
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            event.stopPropagation();
            const n = this._immersion ? this._immersion.list.length : 0;
            if (n) this.showImmersiveAt(event.key === 'Home' ? 0 : n - 1);
            return;
        }
        if (event.key === 'Tab') {
            this.wakeImmersiveChrome();
            if (typeof this.trapFocus === 'function') this.trapFocus(el.overlay, event);
            return;
        }
        this.wakeImmersiveChrome();
    }
});
