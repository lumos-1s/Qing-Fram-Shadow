// RAW 显影面板与像素换装。
//
// 交互模型（为什么不是"每拖一下重解全尺寸"）：
//   · 拖动时用半尺寸代理（长边 1600，解码 ~0.5s），够看清曝光/高光/白平衡；
//   · 停手 1.1s 后自动升到全尺寸（~2s），导出/拼图前也会强制补齐；
//   · 两组结果都落在主进程磁盘缓存里，参数回到旧值就直接命中，不重复解码。
//
// 显影参数属于"这张照片"（和调色一样按图存），写进草稿；换图、重启都还在。
// 裁切和旋转作为「显影视图」交给主进程：只存归一化裁切框 + 90° 次数，
// 代理和全尺寸都能重放；否则用户裁完再碰一下滑块，画面就会被重新解出来的原图冲掉。
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

        // 路径 + 参数 + 长边 + 视图（裁切/旋转）→ qflocal URL。
        // 参数变了 URL 就变，浏览器不会拿旧像素，主进程也能按 URL 里的参数直接命中缓存。
        rawSrc(filePath, params, edge, view) {
            const p = Object.assign({}, DEFAULTS, params || {});
            let url = 'qflocal://img?p=' + encodeURIComponent(filePath)
                + '&raw=' + encodeURIComponent(JSON.stringify(p))
                + '&q=' + (edge || 0);
            const rot = (((Number(view && view.rotate) || 0) % 4) + 4) % 4;
            if (rot) url += '&rot=' + rot;
            if (view && view.crop) url += '&crop=' + encodeURIComponent(JSON.stringify(view.crop));
            return url;
        },

        rawParamsOf(im) {
            if (!im || !im.raw) return null;
            return Object.assign({}, DEFAULTS, im.raw.params || {});
        },

        // 视图是显影状态的一部分：撤销、草稿、裁切都要能原样存回来。
        rawSnapshotOf(im) {
            if (!im || !im.raw) return null;
            return {
                params: Object.assign({}, DEFAULTS, im.raw.params || {}),
                crop: im.raw.crop ? Object.assign({}, im.raw.crop) : null,
                rotate: ((Number(im.rotate) || 0) % 4 + 4) % 4
            };
        },

        rawUrl(im, edge) {
            return this.rawSrc(im.path, this.rawParamsOf(im), edge, {
                crop: im.raw.crop || null,
                rotate: ((Number(im.rotate) || 0) % 4 + 4) % 4
            });
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
                // change = 松手/键盘松开：结束这一次拖动，下一次再按一次撤销。
                s.addEventListener('change', () => this._rawEndUndo());
            }
            if (d.reset) {
                d.reset.addEventListener('click', () => {
                    const im = this.image;
                    if (!im || !im.raw) return;
                    this.rawPushUndoOnce(true);
                    im.raw.params = Object.assign({}, DEFAULTS);
                    this._rawInvalidate(im);
                    this.syncRawUI();
                    this._rawApplyParams(im, PROXY_EDGE);
                    this.setStatus('RAW 显影已回到默认');
                });
            }
        },

        // 一次拖动只压一张快照。松手前的所有 input 共用同一份；
        // 键盘改数值不一定有 change，所以再加 800ms 空闲解锁。
        rawPushUndoOnce(force) {
            if (typeof this.pushUndo !== 'function') return;
            if (!force && this._rawUndoLock) {
                // 长按/连续拖：锁要一直续到停手，别在拖动中途又压一张。
                clearTimeout(this._rawUndoTimer);
                this._rawUndoTimer = setTimeout(() => { this._rawUndoLock = false; }, 800);
                return;
            }
            const top = this.undoStack && this.undoStack[this.undoStack.length - 1];
            if (top && this.sameUndoState && this.sameUndoState(top)) return;
            this.pushUndo();
            this._rawUndoLock = true;
            clearTimeout(this._rawUndoTimer);
            this._rawUndoTimer = setTimeout(() => { this._rawUndoLock = false; }, 800);
        },

        _rawEndUndo() {
            this._rawUndoLock = false;
            clearTimeout(this._rawUndoTimer);
        },

        _rawOnInput(field, value) {
            const im = this.image;
            if (!im || !im.raw) return;
            this.rawPushUndoOnce();
            // 用户开始拖滑块：取消切图时排的自动全尺寸，等这次停手后重新排。
            clearTimeout(this._rawFullTimer);
            im.raw.params = Object.assign({}, this.rawParamsOf(im), { [field.k]: value });
            if (this._rawDom && this._rawDom.labels[field.k]) {
                this.updateLabel(field.lbl, field.fmt(value));
            }
            this._rawApplyParams(im, PROXY_EDGE);
        },

        // 参数或视图变了：立刻作废在途请求和排队中的代理/全尺寸，别让旧结果盖回新画面。
        _rawInvalidate(im) {
            if (!im || !im.raw) return;
            im.raw.seq = (im.raw.seq || 0) + 1;
            im.raw.full = false;
            im.raw.fullPending = null;
            im.raw.error = false;
            // 防抖定时器是全局单例，只有它确实属于这张图时才取消；
            // 否则会把另一张图刚排的代理重解也一起掐掉。
            if (this._rawDebounceIm === im) {
                clearTimeout(this._rawDebounce);
                this._rawDebounce = 0;
                this._rawDebounceIm = null;
            }
            if (im === this.image) clearTimeout(this._rawFullTimer);
        },

        // 参数改了就重来一帧代理图；连续拖动只保留最后一次（seq 令牌作废旧请求）。
        _rawApplyParams(im, edge) {
            clearTimeout(this._rawDebounce);
            this._rawDebounceIm = im;
            this._rawDebounce = setTimeout(() => {
                this._rawDebounce = 0;
                this._rawDebounceIm = null;
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

        // 把当前参数 + 视图显影出来并换进 im.el。返回是否真的换了。
        _rawReload(im, edge) {
            if (!im || !im.raw || !im.path) return Promise.resolve(false);
            // 直接重解（导出、撤销、裁切、旋转）优先于还排着队的代理图；
            // 不取消的话，防抖计时器稍后会用代理结果把这次全尺寸请求作废。
            if (this._rawDebounceIm === im) {
                clearTimeout(this._rawDebounce);
                this._rawDebounce = 0;
                this._rawDebounceIm = null;
            }
            const seq = (im.raw.seq || 0) + 1;
            im.raw.seq = seq;
            im.raw.error = false;
            const url = this.rawUrl(im, edge);
            const img = window.qfsImage();
            img.decoding = 'async';
            return new Promise((resolve) => {
                const finish = (ok) => {
                    // 更新的请求已经发出：这次的结果作废，别把旧像素盖回去
                    if (im.raw.seq !== seq) { resolve(false); return; }
                    if (!ok || !img.naturalWidth) {
                        im.raw.error = true;
                        if (im === this.image) { this.syncRawUI(); this.scheduleRender(true); }
                        resolve(false);
                        return;
                    }
                    im.el = img;
                    im.w = img.naturalWidth;
                    im.h = img.naturalHeight;
                    im.raw.edge = edge;
                    im.raw.full = edge === 0;
                    im.raw.error = false;
                    // 底图换了：旧缩略图必须作废，否则胶片条还是上一版显影
                    im.thumb = null;
                    im._thumbEl = null;
                    im._tqAt = 0;
                    if (this.invalidateStyleCaches) this.invalidateStyleCaches();
                    // 调色缓存按"源图版本 + 参数"记，换了像素必须作废；
                    // 参数还在，当前图立刻在新底图上重放，避免显影后调色像丢了。
                    if (this.invalidateGrade) this.invalidateGrade(im);
                    if (im === this.image && this.rebuildGrade) {
                        this.rebuildGrade(edge === 0 ? 'full' : 'low');
                    }
                    if (typeof this.queueThumb === 'function') this.queueThumb(im);
                    if (im === this.image) {
                        this.syncRawUI();
                        this.scheduleRender(true);
                    }
                    resolve(true);
                };
                img.onload = () => finish(true);
                img.onerror = () => finish(false);
                img.src = url;
            });
        },

        // 全尺寸显影：导出、松手后自动调用。并发同一个参数时只跑一次。
        async rawEnsureFull(im) {
            if (!im || !im.raw || im.raw.full) return true;
            if (im.raw.fullPending) return im.raw.fullPending;
            const t0 = Date.now();
            if (this._rawDom && this._rawDom.state && im === this.image) {
                this._rawDom.state.textContent = '显影中…';
            }
            const p = this._rawReload(im, 0).then((ok) => {
                if (im.raw.fullPending === p) im.raw.fullPending = null;
                if (im === this.image) {
                    this.syncRawUI();
                    if (ok) this.setStatus(`RAW 已按全尺寸显影（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
                    // 被更新的参数/视图请求取代时也会 resolve(false)，那不是失败，别误报。
                    else if (im.raw.error) this.setStatus('RAW 全尺寸显影失败，导出可能只有代理分辨率');
                }
                return ok;
            });
            im.raw.fullPending = p;
            return p;
        },

        // 导出/拼图前调用：参与输出的 RAW 图必须都是全尺寸，否则成品只有 1600px。
        // extraTemplates：导出时可能临时沿用「当前模板」（多选导出时的‘沿用这套边框’），
        // 拼图槽位引用的是那份模板，不在任何图片自己的 customSettings 里。
        async rawPrepareOutput(images, extraTemplates) {
            const list = [];
            const seen = new Set();
            const push = (im) => {
                if (im && im.raw && !im.raw.full && !seen.has(im)) { seen.add(im); list.push(im); }
            };
            // 拼图会把别的照片画进同一张成品，那些槽位图也得是全尺寸，否则成品里
            // 只有主图清晰、其他格子糊。槽位优先按 imageIndex 指回 this.images，
            // 兼容旧工程/外部引用用的 imagePath（与 engine.js 的解析顺序一致）。
            const addSlots = (tpl) => {
                const slots = tpl && tpl.puzzle && tpl.puzzle.slots;
                if (!slots) return;
                for (const k in slots) {
                    const sc = slots[k];
                    if (!sc) continue;
                    let slot = null;
                    if (sc.imageIndex != null) slot = this.images[sc.imageIndex];
                    if (!slot && sc.imagePath) {
                        slot = (this.images || []).find(x => x && x.name === sc.imagePath) || null;
                    }
                    push(slot);
                }
            };
            for (const im of images || []) {
                push(im);
                const own = this.getTpl ? this.getTpl(im) : null;
                addSlots(own || (im === this.image ? this.template : null));
            }
            for (const tpl of extraTemplates || []) addSlots(tpl);
            if (!list.length) return;
            if (list.length > 1) this.setStatus(`正在按全尺寸显影 ${list.length} 张 RAW…`);
            let failed = 0;
            for (const im of list) {
                const ok = await this.rawEnsureFull(im);
                if (ok === false && im.raw.error) failed++;
            }
            if (failed) this.setStatus(`有 ${failed} 张 RAW 全尺寸显影失败，导出可能只有代理分辨率`);
        },

        // 把「旋转后的显示坐标」中的归一化矩形，反推回「裁切后、旋转前」的归一化坐标。
        // 90°/270° 会交换宽高，所以不能只做平移。
        rawUnrotateRect(rect, turns) {
            const r = {
                x: Math.min(1, Math.max(0, Number(rect.x) || 0)),
                y: Math.min(1, Math.max(0, Number(rect.y) || 0)),
                w: Math.min(1, Math.max(0.001, Number(rect.w) || 0)),
                h: Math.min(1, Math.max(0.001, Number(rect.h) || 0))
            };
            const t = ((Math.round(Number(turns) || 0) % 4) + 4) % 4;
            if (t === 1) return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
            if (t === 2) return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
            if (t === 3) return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
            return r;
        },

        // 把裁切弹层里的框记成显影参数。st.src 可能已经带裁切/旋转，
        // 所以按「当前视图 + 弹层里再转的次数」反推回原图坐标，再换底图。
        async rawRecordCrop(im, st, box) {
            if (!im || !im.raw || !st || !box) return false;
            const W = Number(st.W) || 0;
            const H = Number(st.H) || 0;
            if (!W || !H) return false;
            const norm = { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H };
            const useOrig = !!st.useOrig;
            const base = useOrig
                ? ((im.orig && im.orig.raw) || { crop: null, rotate: 0 })
                : { crop: im.raw.crop || null, rotate: im.rotate || 0 };
            const turns = ((Math.round((Number(base.rotate) || 0) + (Number(st.turns) || 0)) % 4) + 4) % 4;
            const local = this.rawUnrotateRect(norm, turns);
            const crop = base.crop || null;
            let out = crop ? {
                x: crop.x + local.x * crop.w,
                y: crop.y + local.y * crop.h,
                w: local.w * crop.w,
                h: local.h * crop.h
            } : local;
            out = {
                x: Math.min(0.999, Math.max(0, out.x)),
                y: Math.min(0.999, Math.max(0, out.y)),
                w: Math.min(1, Math.max(0.001, out.w)),
                h: Math.min(1, Math.max(0.001, out.h))
            };
            // 先夹左上角，再把宽高压回画面内，保证 x+w / y+h 不会超过 1。
            out.w = Math.min(1 - out.x, out.w);
            out.h = Math.min(1 - out.y, out.h);
            // 整张图 + 不旋转 = 没裁切，存 null 让 URL 更短、缓存键更干净。
            im.raw.crop = (out.x < 0.0005 && out.y < 0.0005 && out.w > 0.999 && out.h > 0.999)
                ? null : out;
            im.rotate = turns;
            this._rawInvalidate(im);
            this.syncRawUI();
            const ok = await this._rawReload(im, PROXY_EDGE);
            if (ok && im === this.image) this._rawQueueFull(400);
            return ok;
        },

        // 撤销 / 还原原图：把参数和视图恢复到快照，再重新显影。
        async rawApplyUndo(im, state) {
            if (!im || !im.raw || !state) return false;
            im.raw.params = Object.assign({}, DEFAULTS, state.params || {});
            if (state.crop) {
                const crop = {
                    x: Math.min(0.999, Math.max(0, Number(state.crop.x) || 0)),
                    y: Math.min(0.999, Math.max(0, Number(state.crop.y) || 0)),
                    w: Math.min(1, Math.max(0.001, Number(state.crop.w) || 1)),
                    h: Math.min(1, Math.max(0.001, Number(state.crop.h) || 1))
                };
                crop.w = Math.min(1 - crop.x, crop.w);
                crop.h = Math.min(1 - crop.y, crop.h);
                im.raw.crop = crop;
            } else {
                im.raw.crop = null;
            }
            im.rotate = ((Number(state.rotate) || 0) % 4 + 4) % 4;
            this._rawInvalidate(im);
            this.syncRawUI();
            const ok = await this._rawReload(im, PROXY_EDGE);
            if (ok && im === this.image) this._rawQueueFull(400);
            return ok;
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
                if (im.raw.error) d.state.textContent = '显影失败';
                else if (im.raw.fullPending) d.state.textContent = '显影中…';
                else if (im.raw.full) d.state.textContent = `${im.w}×${im.h}`;
                else d.state.textContent = `${Math.max(im.w, im.h)}px 代理`;
            }
        }
    });
})();
