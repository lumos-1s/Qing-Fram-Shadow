// RAW 显影面板与像素换装。
//
// 交互模型（为什么不是"每拖一下重解全尺寸"）：
//   · 拖动时用半尺寸代理（长边 1600，解码 ~0.5s），够看清曝光/高光/白平衡；
//   · 停手 1.1s 后自动升到全尺寸（~2s），导出/拼图前也会强制补齐；
//   · 两组结果都落在主进程磁盘缓存里，参数回到旧值就直接命中，不重复解码。
//
// 显影参数属于"这张照片"（和调色一样按图存），写进草稿；换图、重启都还在。
(function () {
    const DEFAULTS = { exposure: 0, contrast: 0, highlights: 25, temperature: 0, tint: 0 };
    const PROXY_EDGE = 1600;
    const DEBOUNCE = 220;
    const FULL_IDLE = 1100;

    const FIELDS = [
        { k: 'exposure', sl: 'slRawExp', lbl: 'lblRawExp', fmt: (v) => (v > 0 ? '+' + v.toFixed(2) : String(v.toFixed(2))) },
        { k: 'contrast', sl: 'slRawCon', lbl: 'lblRawCon', fmt: (v) => (v > 0 ? '+' + v : String(v)) },
        { k: 'highlights', sl: 'slRawHi', lbl: 'lblRawHi', fmt: (v) => (v > 0 ? '+' + v : String(v)) },
        { k: 'temperature', sl: 'slRawTemp', lbl: 'lblRawTemp', fmt: (v) => (v > 0 ? '+' + v : String(v)) },
        { k: 'tint', sl: 'slRawTint', lbl: 'lblRawTint', fmt: (v) => (v > 0 ? '+' + v : String(v)) }
    ];

    window.App = Object.assign(window.App || {}, {
        RAW_DEFAULTS: DEFAULTS,
        RAW_PROXY_EDGE: PROXY_EDGE,

        // 路径 + 参数 + 长边 → qflocal URL。参数变了 URL 就变，浏览器不会拿旧像素，
        // 主进程也能按 URL 里的参数直接命中缓存。
        rawSrc(filePath, params, edge) {
            const p = Object.assign({}, DEFAULTS, params || {});
            return 'qflocal://img?p=' + encodeURIComponent(filePath)
                + '&raw=' + encodeURIComponent(JSON.stringify(p))
                + '&q=' + (edge || 0);
        },

        rawParamsOf(im) {
            if (!im || !im.raw) return null;
            return Object.assign({}, DEFAULTS, im.raw.params || {});
        },

        rawUrl(im, edge) {
            return this.rawSrc(im.path, this.rawParamsOf(im), edge);
        },

        initRawPanel() {
            const d = {
                wrap: document.getElementById('grpRaw'),
                badge: document.getElementById('rawBadge'),
                state: document.getElementById('rawState'),
                reset: document.getElementById('btnRawReset'),
                sliders: {},
                labels: {}
            };
            for (const f of FIELDS) {
                const s = document.getElementById(f.sl);
                if (s) [d.sliders[f.k], d.labels[f.k]] = [s, document.getElementById(f.lbl)];
            }
            if (!d.wrap || !Object.keys(d.sliders).length) return;
            this._rawDom = d;
            d.wrap.hidden = true;

            for (const f of FIELDS) {
                const s = d.sliders[f.k];
                if (!s) continue;
                s.addEventListener('input', () => this._rawOnInput(f, Number(s.value)));
                // change = 松手/键盘松开：这时才值得排一次全尺寸
                s.addEventListener('change', () => this._rawQueueFull(0));
            }
            if (d.reset) {
                d.reset.addEventListener('click', () => {
                    const im = this.image;
                    if (!im || !im.raw) return;
                    im.raw.params = Object.assign({}, DEFAULTS);
                    this.syncRawUI();
                    this._rawApplyParams(im, PROXY_EDGE);
                    this._rawQueueFull(800);
                    this.setStatus('RAW 显影已回到默认');
                });
            }
        },

        _rawOnInput(field, value) {
            const im = this.image;
            if (!im || !im.raw) return;
            im.raw.params = Object.assign({}, this.rawParamsOf(im), { [field.k]: value });
            if (this._rawDom && this._rawDom.labels[field.k]) {
                this.updateLabel(field.lbl, field.fmt(value));
            }
            this._rawApplyParams(im, PROXY_EDGE);
        },

        // 参数改了就重来一帧代理图；连续拖动只保留最后一次（seq 令牌作废旧请求）。
        _rawApplyParams(im, edge) {
            clearTimeout(this._rawDebounce);
            this._rawDebounce = setTimeout(() => {
                this._rawReload(im, edge).then((ok) => {
                    if (ok && im === this.image) this._rawQueueFull(FULL_IDLE);
                });
            }, DEBOUNCE);
        },

        _rawQueueFull(delay) {
            clearTimeout(this._rawFullTimer);
            const im = this.image;
            if (!im || !im.raw || im.raw.full) return;
            this._rawFullTimer = setTimeout(() => {
                if (this.image === im) this.rawEnsureFull(im);
            }, delay == null ? FULL_IDLE : delay);
        },

        // 把某个参数组合显影出来并换进 im.el。返回是否真的换了。
        _rawReload(im, edge) {
            if (!im || !im.raw || !im.path) return Promise.resolve(false);
            const seq = (im.raw.seq || 0) + 1;
            im.raw.seq = seq;
            const url = this.rawUrl(im, edge);
            const img = window.qfsImage();
            img.decoding = 'async';
            return new Promise((resolve) => {
                const settle = async (ok) => {
                    // 更新的请求已经发出：这次的结果作废，别把旧像素盖回去
                    if (im.raw.seq !== seq) { resolve(false); return; }
                    if (!ok || !img.naturalWidth) { resolve(false); return; }
                    // 用户如果旋转过这张图，新像素必须补回同样的角度，
                    // 否则调一次显影就把旋转"撤销"了（而旋转本身是不可逆操作）。
                    let el = img;
                    let w = img.naturalWidth;
                    let h = img.naturalHeight;
                    if (im.rotate) {
                        try {
                            const r = await this._rawRotateEl(img, im.rotate);
                            if (r) { el = r.el; w = r.w; h = r.h; }
                        } catch (e) { /* 转不动就用未旋转的，至少画面在 */ }
                        if (im.raw.seq !== seq) { resolve(false); return; }
                    }
                    im.el = el;
                    im.w = w;
                    im.h = h;
                    im.raw.edge = edge;
                    im.raw.full = edge === 0;
                    // 调色缓存按"画布尺寸 + 内容指纹"记，换了像素必须清掉，否则会沿用旧图
                    im._grade = { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' };
                    im._tqAt = 0;
                    if (typeof this.queueThumb === 'function') this.queueThumb(im);
                    if (im === this.image) this.scheduleRender(true);
                    resolve(true);
                };
                img.onload = () => { settle(true); };
                img.onerror = () => { settle(false); };
                img.src = url;
            });
        },

        // 把顺时针 90°×turns 烘进像素，返回 { el, w, h }。与 rotateImage 用同一条画布路径，
        // 只是不碰 rotate 计数、不存原图（那两件事属于用户操作，不属于显影）。
        async _rawRotateEl(img, turns) {
            let el = img;
            let w = img.naturalWidth;
            let h = img.naturalHeight;
            for (let i = 0; i < (turns % 4); i++) {
                const c = document.createElement('canvas');
                c.width = h;
                c.height = w;
                const g = c.getContext('2d');
                g.translate(h / 2, w / 2);
                g.rotate(Math.PI / 2);
                g.drawImage(el, -w / 2, -h / 2);
                const out = window.qfsImage();
                await new Promise((r) => { out.onload = r; out.onerror = r; out.src = c.toDataURL('image/jpeg', 0.95); });
                if (!out.naturalWidth) return null;
                el = out;
                w = c.width;
                h = c.height;
            }
            return { el, w, h };
        },

        // 全尺寸显影：导出、松手后自动调用。并发同一个参数时只跑一次。
        async rawEnsureFull(im) {
            if (!im || !im.raw || im.raw.full) return true;
            if (im.raw.fullPending) return im.raw.fullPending;
            const t0 = Date.now();
            if (this._rawDom && this._rawDom.state && im === this.image) {
                this._rawDom.state.textContent = '显影中…';
            }
            im.raw.fullPending = this._rawReload(im, 0).then((ok) => {
                im.raw.fullPending = null;
                if (im === this.image) {
                    this.syncRawUI();
                    if (ok) this.setStatus(`RAW 已按全尺寸显影（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
                }
                return ok;
            });
            return im.raw.fullPending;
        },

        // 导出/拼图前调用：参与输出的 RAW 图必须都是全尺寸，否则成品只有 1600px。
        async rawPrepareOutput(images) {
            // 拼图会把别的照片画进同一张成品，那些槽位图也得是全尺寸，否则成品里
            // 只有主图清晰、其他格子糊。槽位按 imageIndex 指回 this.images。
            const list = [];
            const seen = new Set();
            const push = (im) => {
                if (im && im.raw && !im.raw.full && !seen.has(im)) { seen.add(im); list.push(im); }
            };
            for (const im of images || []) {
                push(im);
                const tpl = this.getTpl ? this.getTpl(im) : null;
                const slots = tpl && tpl.puzzle && tpl.puzzle.slots;
                if (slots) {
                    for (const k in slots) {
                        const sc = slots[k];
                        if (sc && sc.imageIndex != null) push(this.images[sc.imageIndex]);
                    }
                }
            }
            if (!list.length) return;
            if (list.length > 1) this.setStatus(`正在按全尺寸显影 ${list.length} 张 RAW…`);
            for (const im of list) await this.rawEnsureFull(im);
        },

        // 面板显隐与数值同步。切图、撤销、套预设后都会被 syncGradeUI 顺带叫到。
        syncRawUI() {
            const d = this._rawDom;
            if (!d) return;
            const im = this.image;
            const on = !!(im && im.raw);
            d.wrap.hidden = !on;
            if (!on) return;
            const p = this.rawParamsOf(im);
            for (const f of FIELDS) {
                const s = d.sliders[f.k];
                if (s && String(s.value) !== String(p[f.k])) s.value = String(p[f.k]);
                this.updateLabel(f.lbl, f.fmt(Number(p[f.k]) || 0));
            }
            if (d.badge) {
                const ext = String(im.path || '').split('.').pop().toUpperCase();
                d.badge.textContent = ext && ext.length <= 4 ? ext : 'RAW';
            }
            if (d.state) {
                if (im.raw.fullPending) d.state.textContent = '显影中…';
                else if (im.raw.full) d.state.textContent = `${im.w}×${im.h}`;
                else d.state.textContent = `${Math.max(im.w, im.h)}px 代理`;
            }
        }
    });
})();
