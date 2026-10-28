// 元素模块：命中检测 / 坐标换算 / 选择框 / 元素增删与对齐 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    screenToCanvas(e) {
        const canvas = this.dom.canvas;
        const rect = canvas.getBoundingClientRect();
        // 与 puzzlePx 一致:用 DOM 渲染尺寸(已含 CSS 缩放/平移)的比例换算到画布像素,避免二次除以 zoom
        const cx = (rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0) * canvas.width;
        const cy = (rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0) * canvas.height;
        return { x: cx, y: cy, cw: canvas.width, ch: canvas.height };
    },

    hasEl(list, el) { return list.some(x => x.kind === el.kind && x.obj === el.obj); },

    // 命中检测:logo/贴纸/自由文字
    pickElement(pt) {
        const hitLogo = this.hitTestLogos(pt);
        const hitStk = this.hitTestStickers(pt);
        const hitTxt = this.hitTestTexts(pt);
        const cands = [hitLogo, hitStk, hitTxt].filter(Boolean);
        if (!cands.length) return null;
        cands.sort((a, b) => (b.z || 0) - (a.z || 0));
        return cands[0];
    },

    hitTestLogos(pt) {
        const els = (this.template && this.template.logoElements) || [];
        // rel 比例(rx/ry)已统一为「显示画布 canvas.width/height」的分数,与引擎
        // drawLogoElements 同一口径;此处传 logoBaseForOverlay()(基准口径)只供锚点/
        // 像素分支使用,rel 分支会自行按当前 canvas 解析,与基准/显示无关。
        const base = this.logoBaseForOverlay();
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            const size = el.size || 60;
            const pos = this.logoPos(el, base.w, base.h, size);
            if (Math.abs(pt.x - pos.cx) <= size / 2 && Math.abs(pt.y - pos.cy) <= size / 2) {
                return { kind: 'logo', obj: el, x0: pos.cx, y0: pos.cy, z: el.z || 0 };
            }
        }
        return null;
    },

    hitTestStickers(pt) {
        const stickers = (this.template && this.template.decorConfig && this.template.decorConfig.stickers) || [];
        for (let i = stickers.length - 1; i >= 0; i--) {
            const el = stickers[i];
            const tex = this.textureEl(el.src);
            if (!tex) continue;
            const sw = tex.naturalWidth * (el.scale || 1), sh = tex.naturalHeight * (el.scale || 1);
            if (Math.abs(pt.x - el.x) <= sw / 2 && Math.abs(pt.y - el.y) <= sh / 2) {
                return { kind: 'sticker', obj: el, x0: el.x, y0: el.y, z: (el.z || 0) + 5 };
            }
        }
        return null;
    },

    // 文字坐标是「画布逻辑像素」，而命中点来自 screenToCanvas（含 DPR 的画布像素）。
    // 两者差一个 scale，DPR≠1 时不换算就会「点在这里、拖去那里」。
    textSpaceScale() {
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1)) return 1;
        const lw = (cv._logW > 1) ? cv._logW : cv.width;
        return cv.width / lw;
    },

    // 引擎的「EXIF 参数条」占位行：exifAutoText 开启时它不绘制（由 buildExifLines 现算现画），
    // 因此也不该出现在元素列表/命中里，否则用户会选中一行看不见的字。
    _isHiddenExifLine(el, decor) {
        if (!el || !el.text) return false;
        const d = decor || (this.template && this.template.decorConfig) || {};
        if ((d.exifAutoText || 0) !== 1) return false;
        const lines = d.textLines || [];
        const idx = lines.findIndex(l => l.text && (l.align === 'bottom' || l.align === 'exif'));
        return idx >= 0 && lines[idx] === el;
    },

    hitTestTexts(pt) {
        const decor = (this.template && this.template.decorConfig) || {};
        const lines = decor.textLines || [];
        const cv = this.dom && this.dom.canvas;
        if (!cv || !(cv.width > 1) || !lines.length) return null;
        const cw = (cv._logW > 1) ? cv._logW : cv.width;
        const ch = (cv._logH > 1) ? cv._logH : cv.height;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        const metrics = window.textLineMetrics;
        if (typeof metrics !== 'function') return null;
        for (let i = lines.length - 1; i >= 0; i--) {
            const el = lines[i];
            if (!el.text || this._isHiddenExifLine(el, decor)) continue;
            // 外框已经含方向与角度：竖排/侧排/旋转都按同一套几何判定
            const m = metrics(el, cw, ch, false, 0, 0);
            if (px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h) {
                return { kind: 'text', obj: el, x0: m.cx, y0: m.cy, z: (el.z || 0) + 3 };
            }
        }
        return null;
    },

    // 把「锚定在底边/顶边」的文字就地解锁成自由文字：坐标取当前几何框的中心，
    // 所以画面一格都不跳。之后拖拽/输入才真的动得了它。
    // 文字在「逻辑画布」里的几何（绘制口径）。算不出来时返回 null。
    textMetricsOf(el) {
        const cv = this.dom && this.dom.canvas;
        const cw = (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0);
        const ch = (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0);
        if (!(cw > 1) || !(ch > 1) || typeof window.textLineMetrics !== 'function') return null;
        return window.textLineMetrics(el, cw, ch, false, 0, 0);
    },

    // 逻辑画布尺寸（绘制口径）。文字的一切坐标都按这个口径存。
    _logCanvas() {
        const cv = this.dom && this.dom.canvas;
        return {
            w: (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0),
            h: (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0),
        };
    },

    // ── 文字工具（像 PS 那样：新建一段文字，落在画布中央，随即可拖/转/双击改字）──
    async addFreeText() {
        const { w, h } = this._logCanvas();
        if (!(w > 1) || !(h > 1)) { this.setStatus('先导入一张照片，再添加文字'); return; }
        const typed = await this.promptText('输入文字内容（确定后落在画布中央）', '');
        if (typed == null) return;                 // 取消
        const text = String(typed).trim();
        if (!text) { this.setStatus('内容为空，未添加'); return; }

        const tpl = this.template || (this.template = this.defaultTemplate());
        const decor = tpl.decorConfig || (tpl.decorConfig = {});
        if (!decor.textLines) decor.textLines = [];
        const line = {
            text,
            align: 'free',
            x: Math.round(w / 2),
            y: Math.round(h / 2),
            fontFamily: 'Microsoft YaHei',
            fontSize: Math.max(12, Math.round(Math.min(w, h) * 0.06)),
            fontWeight: 400,
            letterSpacing: 0,
            colorHex: '#ffffff',
            opacity: 100,
            rotation: 0,
            enableShadow: 0,
        };
        this.pushUndo();
        decor.textLines.push(line);
        this.selectedEls = [{ kind: 'text', obj: line }];
        this.refreshElList();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已添加文字「' + text.slice(0, 12) + '」：拖动移动，拖上方圆点旋转，双击改内容');
    },

    // 双击画布上的文字 → 改内容（PS 的文字工具就是这条路）
    async editTextContent(el) {
        if (!el) return;
        const v = await this.promptText('编辑文字内容', el.text || '');
        if (v == null) return;
        const t = String(v).trim();
        if (!t) { this.setStatus('内容不能为空'); return; }
        this.pushUndo();
        el.text = t;
        this.refreshElList();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('文字已更新');
    },

    // ── 鼠标旋转 ──
    // 把手画在选中框上方（drawSelectionBox 里算好坐标存在 _rotHandle），
    // 命中检测直接读它 —— 两处各算一遍角度迟早对不上。
    hitRotateHandle(pt) {
        const hd = this._rotHandle;
        if (!hd) return false;
        return Math.hypot(pt.x - hd.x, pt.y - hd.y) <= hd.r + 6;
    },

    beginRotate(pt) {
        const sel = this.selectedEls && this.selectedEls[0];
        if (!sel || !sel.obj) return null;
        const m = this.textMetricsOf(sel.obj);
        if (!m) return null;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        this._rotEl = {
            ref: sel.obj, kind: sel.kind,
            cx: m.cx, cy: m.cy,
            base: Number(sel.obj.rotation) || 0,
            a0: Math.atan2(py - m.cy, px - m.cx),
            moved: false,
        };
        return this._rotEl;
    },

    // shiftKey 时按 15° 吸附，和 PS 一致
    applyRotate(pt, shift) {
        const r = this._rotEl;
        if (!r) return;
        const k = this.textSpaceScale();
        const px = pt.x / k, py = pt.y / k;
        const a = Math.atan2(py - r.cy, px - r.cx);
        let deg = r.base + (a - r.a0) * 180 / Math.PI;
        deg = ((deg % 360) + 360) % 360;
        if (shift) deg = (Math.round(deg / 15) * 15) % 360;
        r.ref.rotation = Math.round(deg * 10) / 10;
        r.moved = true;
        this.scheduleRender();
    },

    promoteTextToFree(el) {
        if (!el || el.align === 'free') return false;
        const m = this.textMetricsOf(el);
        if (!m) return false;
        el.align = 'free';
        el.x = Math.round(m.cx);
        el.y = Math.round(m.cy);
        delete el.rel;   // rel 是 logo 的口径（canvas.width 分数），文字不用
        return true;
    },

    // 元素在画布上的中心点(像素)。三种坐标形式并存,按优先级解析:
    //   ① el.rel + 相对比例 rx/ry —— 以「显示画布 canvas.width/height」的比例存储,
    //                               换照片尺寸时按新画布还原不会错位,预览与导出同一分数
    //   ② el.x 为数字            —— 绝对像素坐标(旧模板的格式;新写入时与 ① 同时保存以兼容旧版)
    //   ③ el.x 为字符串          —— 锚点定位('right'/'bottom' + offsetX/offsetY),天然随画布自适应
    // rel 分支直接按当前 canvas 解析(不依赖调用方传基准还是显示尺寸),与引擎绘制同一口径;
    // 锚点/像素分支仍用传入的 cw/ch(调用方传基准口径,与引擎锚点一致)。
    logoPos(el, cw, ch, size) {
        if (!el) return { cx: cw / 2, cy: ch / 2 };
        if (el.rel && typeof el.rx === 'number' && typeof el.ry === 'number') {
            const cv = this.dom && this.dom.canvas;
            // 画布未知时(例如尚未渲染)退回后续分支,避免算出错误偏移
            if (cv && cv.width > 1 && cv.height > 1) {
                return { cx: el.rx * cv.width, cy: el.ry * cv.height };
            }
        }
        if (typeof el.x === 'number' && typeof el.y === 'number') {
            return { cx: el.x, cy: el.y };
        }
        const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
        const ox = el.offsetX || 20, oy = el.offsetY || 20;
        // 半高按元素真实纵横比算(Logo 的 size 是宽度,高度 = size * ratio);
        // 原先上下都用 size/2,等于把非正方形 Logo 当正方形,导致上下留白与左右不一致。
        const ratio = (typeof el.ratio === 'number' && el.ratio > 0) ? el.ratio : 1;
        const hw = size / 2, hh = (size * ratio) / 2;
        const tx = hAlign === 'left' ? ox + hw : hAlign === 'center' ? cw / 2 : cw - ox - hw;
        const ty = vAlign === 'top' ? oy + hh : vAlign === 'center' ? ch / 2 : ch - oy - hh;
        return { cx: tx, cy: ty };
    },

    // 当前照片的「基准画布」尺寸(不含显示缩放与 DPR),rel 比例的换算基准。
    // 注意 _logW/_logH 由引擎渲染时写入,切换照片后到下一次渲染完成前仍是「上一张图」的值。
    // 因此校验 canvas.width ≈ _logW × devicePixelRatio:两者对不上说明 _log 是上一张图的残留,
    // 此时返回 null,调用方退回像素坐标(绝不拿错误基准去算比例)。
    logoBaseSize() {
        const cv = this.dom && this.dom.canvas;
        const im = this.image;
        if (cv && cv._logW > 1 && cv._logH > 1 && im) {
            // 守卫要用「实际生效的 dpr」,而不是猜一个。原实现固定用 window.devicePixelRatio,
            // 在两种合法画布上都会误判:
            //
            //   ① 导出通道:app-export.js 设 uiDprOverride=1(按逻辑像素渲染,保证导出尺寸等于所选档位)
            //      引擎 engine.js 走 setupCanvas → width = _logW * 1,而这里按 dpr=2 算 expect=_logW*2 → 失配
            //   ② 相框通道:engine-styles.js 完全不乘 dpr(那三处都写 _logW = canvas.width),
            //      无论预览还是导出 width 都恒等于 _logW → 同样与 expect=_logW*2 失配
            //
            // 失配的代价不是"少个提示",而是 logoPos 跳过 rel 比例分支、退回锚点分支
            // (app-elements.js logoPos 第 74 行),把 logo 画到右下角默认偏移位 ——
            // 表现为「预览里 logo 在中间,导出的图里 logo 跑到了角上」。
            //
            // 正确做法:枚举引擎可能用到的 dpr(1 与 devicePixelRatio),任一匹配即认为 _logW 可信。
            // dpr=1 始终要试:相框通道与导出通道都落在这一档。
            //
            // 注:守卫原本想拦「渲染未完成时 _logW 还是上一张图」的残留,但那需要 _logW 与当前图
            // 尺寸比对才能判断,单看 width/logW 的比值做不到。实测该残留不会造成位置偏移
            // (rel 比例天然与画布大小无关),所以此处不做超出枚举的额外推断。
            const devDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const candidates = devDpr === 1 ? [1] : [1, devDpr];
            for (const k of candidates) {
                const expect = cv._logW * k;
                if (Math.abs(cv.width - expect) <= Math.max(2, expect * 0.02)) {
                    return { w: cv._logW, h: cv._logH };
                }
            }
        }
        return null;
    },

    // 供叠加层/命中/瞄准环传给 logoPos 的 cw/ch。rel 分支现按当前 canvas 自行解析,
    // 此值只影响锚点/像素分支:取基准口径,与引擎锚点(cw 为逻辑画布)一致。
    logoBaseForOverlay() {
        const cv = this.dom && this.dom.canvas;
        const b = this.logoBaseSize();
        if (b) return b;
        return { w: (cv && cv.width) || 1, h: (cv && cv.height) || 1 };
    },

    // 相对比例格式迁移:旧版 rx/ry 以「基准画布 _logW/_logH」为分母,而导出(uiDprOverride=1)
    // 时画布变回 _logW,同一数值画完会被放大 canvas.width/_logW 倍,形成
    // 「预览居中、导出跑到角上/贴边」的偏差。新版统一以「显示画布 canvas.width/height」为分母,
    // 预览与导出天然一致。此处把旧格式(rel 为真值但非 'canvas')在渲染前一次性换算:
    //   换算系数 = 基准画布/显示画布,换算前后在同一画布上的绘制像素完全不变,只改数值口径。
    // 仅在比值≠1 时换算并标记;ratio-1 环境(DPR1/相框通道/导出)旧值本就等于显示画布分数,
    // 保持原值、不固化,留待 ratio≠1 环境一次性转换,避免以错误口径保存到模板文件。
    migrateRelCanvasFrac() {
        const t = this.template;
        if (!t || !t.logoElements || !t.logoElements.length) return;
        const cv = this.dom && this.dom.canvas;
        if (!cv || cv.width <= 1 || cv.height <= 1) return;
        const b = this.logoBaseSize();
        if (!b || b.w <= 1 || b.h <= 1) return;
        const fx = b.w / cv.width, fy = b.h / cv.height;
        if (!isFinite(fx) || !isFinite(fy) || fx <= 0 || fy <= 0) return;
        if (Math.abs(fx - 1) <= 1e-9 && Math.abs(fy - 1) <= 1e-9) return;
        for (const el of t.logoElements) {
            if (el && el.rel && el.rel !== 'canvas' && typeof el.rx === 'number' && typeof el.ry === 'number') {
                el.rx *= fx;
                el.ry *= fy;
                el.rel = 'canvas';
            }
        }
    },

    // 把像素中心写回元素:优先用相对比例存储(可跨照片尺寸),锚点模式则保留锚点只反算 offset。
    setLogoPixelPos(el, cx, cy) {
        if (!el) return;
        const base = this.logoBaseSize();
        const cv = this.dom && this.dom.canvas;
        if (typeof el.x === 'string' || typeof el.y === 'string') {
            // 锚点模式:保持锚点不变 → 它本来就能随画布自适应,无需转成比例
            if (!base) return;
            const dim = this._logoDrawSize(el);
            const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
            const halfW = dim.w / 2, halfH = dim.h / 2;
            if (hAlign === 'left') el.offsetX = Math.max(0, Math.round(cx - halfW));
            else if (hAlign === 'center') el.offsetX = 0;
            else el.offsetX = Math.max(0, Math.round(base.w - cx - halfW));
            if (vAlign === 'top') el.offsetY = Math.max(0, Math.round(cy - halfH));
            else if (vAlign === 'center') el.offsetY = 0;
            else el.offsetY = Math.max(0, Math.round(base.h - cy - halfH));
            return;
        }
        // 像素值照旧写入(旧版程序打开同一模板时仍能定位),限制在画布内;
        // 相对比例以「显示画布 canvas.width/height」为分母(rx∈[0,1]):
        // 预览(canvas 可能为 _logW×dpr)与导出(canvas=_logW)按同一分数还原,
        // 不再出现「预览居中、导出跑角/贴边」的偏差。
        const clampedX = cv && cv.width > 0 ? Math.min(cv.width, Math.max(0, cx)) : cx;
        const clampedY = cv && cv.height > 0 ? Math.min(cv.height, Math.max(0, cy)) : cy;
        el.x = Math.round(clampedX);
        el.y = Math.round(clampedY);
        if (!cv || cv.width <= 0 || cv.height <= 0) return;
        el.rel = 'canvas';
        el.rx = Math.max(0, Math.min(1, cx / cv.width));
        el.ry = Math.max(0, Math.min(1, cy / cv.height));
    },

    nudgeElement(el, mode, dir) {
        const e = el.obj;
        if (el.kind === 'logo') {
            if (typeof e.x !== 'number') { const p = this.logoPos(e, this.dom.canvas.width, this.dom.canvas.height, e.size || 60); this.setLogoPixelPos(e, p.cx, p.cy); }
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else e.size = clampNum((e.size || 60) + dir * 25, 8, 10000);
        } else if (el.kind === 'sticker') {
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else e.scale = clampNum((e.scale || 1) * (dir > 0 ? 1.1 : 0.9), 0.02, 3);
        } else if (el.kind === 'text') {
            // 取 1 位小数再存：3.2 + 5 这类累加会变成 8.199999999999989，
            // 显示层虽然会圆，但值会写进模板/导出，不该带这种尾巴。
            if (mode === 'rot') e.rotation = Math.round((((e.rotation || 0) + dir * 5) % 360 + 360) % 360 * 10) / 10;
            else { e.fontSize = clampNum((e.fontSize || 18) + dir * 2, 6, 300); if (e.autoSize) e.autoSize = 0; }
        }
        this.syncSliderFromEl(el);
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    // ── Compositor 借鉴 #1:方向键微移元素 + 精确数值输入 ──
    // 方向键微移:1px/次,Shift=10px;logo 走 setLogoPixelPos(同步 rx/ry,换照片尺寸不错位)
    nudgeSelectedPosition(dx, dy) {
        if (!this.selectedEls || !this.selectedEls.length) return;
        const cw = this.dom.canvas.width || 0, ch = this.dom.canvas.height || 0;
        this.selectedEls.forEach(sel => {
            const e = sel.obj;
            if (sel.kind === 'logo') {
                if (typeof e.x !== 'number' || typeof e.y !== 'number') {
                    const p = this.logoPos(e, cw, ch, e.size || 60);
                    this.setLogoPixelPos(e, p.cx, p.cy);
                }
                this.setLogoPixelPos(e, (e.x || 0) + dx, (e.y || 0) + dy);
            } else if (sel.kind === 'sticker') {
                e.x = Math.max(20, Math.min(cw - 20, (e.x || 0) + dx));
                e.y = Math.max(20, Math.min(ch - 20, (e.y || 0) + dy));
            } else if (sel.kind === 'text') {
                this.promoteTextToFree(e);
                const lw = (this.dom.canvas._logW > 1) ? this.dom.canvas._logW : cw;
                const lh = (this.dom.canvas._logH > 1) ? this.dom.canvas._logH : ch;
                e.x = Math.max(0, Math.min(lw, (e.x || 0) + dx));
                e.y = Math.max(0, Math.min(lh, (e.y || 0) + dy));
            }
        });
        this.syncElInputs();
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    _elCenterX(sel) {
        const e = sel.obj;
        if (sel.kind === 'logo') {
            if (typeof e.x === 'number') return Math.round(e.x);
            const p = this.logoPos(e, this.dom.canvas.width || 0, this.dom.canvas.height || 0, e.size || 60);
            return Math.round(p.cx);
        }
        // 锚定文字没有 x/y（x=0 只是占位），面板要显示它「现在实际在哪」，
        // 否则选了文字却看到 0,0，会以为坏了。
        if (sel.kind === 'text' && e.align !== 'free') {
            const m = this.textMetricsOf(e);
            if (m) return Math.round(m.cx);
        }
        return Math.round(e.x || 0);
    },
    _elCenterY(sel) {
        const e = sel.obj;
        if (sel.kind === 'logo') {
            if (typeof e.y === 'number') return Math.round(e.y);
            const p = this.logoPos(e, this.dom.canvas.width || 0, this.dom.canvas.height || 0, e.size || 60);
            return Math.round(p.cy);
        }
        if (sel.kind === 'text' && e.align !== 'free') {
            const m = this.textMetricsOf(e);
            if (m) return Math.round(m.cy);
        }
        return Math.round(e.y || 0);
    },
    // 回显位置输入框:多选时禁用(绝对坐标只对单元素有意义)
    syncElInputs() {
        const $ = this.$;
        const inpX = $('inpElX'), inpY = $('inpElY');
        if (!inpX && !inpY) return;
        const sel = this.selectedEls && this.selectedEls[0];
        const multi = (this.selectedEls || []).length > 1;
        if (!sel || multi) {
            if (inpX) { if (!inpX.disabled) inpX.disabled = true; if (inpX.value !== '') inpX.value = ''; }
            if (inpY) { if (!inpY.disabled) inpY.disabled = true; if (inpY.value !== '') inpY.value = ''; }
            return;
        }
        if (inpX) { if (inpX.disabled) inpX.disabled = false; const v = String(this._elCenterX(sel)); if (inpX.value !== v) inpX.value = v; }
        if (inpY) { if (inpY.disabled) inpY.disabled = false; const v2 = String(this._elCenterY(sel)); if (inpY.value !== v2) inpY.value = v2; }
    },
    // 精确写入元素中心像素坐标(logo 走 setLogoPixelPos 保持 rx/ry)
    setElementCenter(sel, x, y) {
        const e = sel.obj;
        const cw = this.dom.canvas.width || 0, ch = this.dom.canvas.height || 0;
        if (sel.kind === 'logo') this.setLogoPixelPos(e, x, y);
        else if (sel.kind === 'sticker') { e.x = Math.max(20, Math.min(cw - 20, x)); e.y = Math.max(20, Math.min(ch - 20, y)); }
        else if (sel.kind === 'text') {
            // 锚定文字没有 x/y 可言：先在当前位置解锁成自由文字（画面不跳），再写坐标
            this.promoteTextToFree(e);
            const lw = (this.dom.canvas._logW > 1) ? this.dom.canvas._logW : cw;
            const lh = (this.dom.canvas._logH > 1) ? this.dom.canvas._logH : ch;
            e.x = Math.max(0, Math.min(lw, x));
            e.y = Math.max(0, Math.min(lh, y));
        }
    },

    rebindSelectedEls() { /* template引用稳定,无需重绑 */ },

    moveElement(drag, x, y) {
        const e = drag.ref;
        const cv = this.dom.canvas;
        const cw = cv.width || 0, ch = cv.height || 0;
        if (drag.kind === 'text') {
            // 文字坐标是逻辑口径，而拖拽位移是画布像素（含 DPR）——先换算再吸附/写回，
            // 否则 DPR>1 的屏幕上文字会以 1.x 倍速跟手。
            const k = this.textSpaceScale();
            const lw = (cv._logW > 1) ? cv._logW : cw;
            const lh = (cv._logH > 1) ? cv._logH : ch;
            const snap = this.snapToGuides(drag.x + (x - drag.x) / k, drag.y + (y - drag.y) / k, lw, lh, e, 'text');
            e.x = Math.max(0, Math.min(lw, snap.x));
            e.y = Math.max(0, Math.min(lh, snap.y));
            this._logoSnapV = snap.v; this._logoSnapH = snap.h;
            this._logoSnapEdgeV = snap.vEdge; this._logoSnapEdgeH = snap.hEdge;
            this._logoSnapPhotoV = snap.photoV; this._logoSnapPhotoH = snap.photoH;
            this.onSettingChanged();
            return;
        }
        const snap = this.snapToGuides(x, y, cw, ch, e, drag.kind);
        if (drag.kind === 'logo') {
            // 用相对比例写回,换照片尺寸时不会跑到画布外
            this.setLogoPixelPos(e, snap.x, snap.y);
        } else if (drag.kind === 'sticker') {
            e.x = Math.max(20, Math.min(cw - 20, snap.x)); e.y = Math.max(20, Math.min(ch - 20, snap.y));
        } else if (drag.kind === 'text') {
            e.x = Math.max(30, Math.min(cw - 30, snap.x)); e.y = Math.max(20, Math.min(ch - 20, snap.y));
        }
        this._logoSnapV = snap.v; this._logoSnapH = snap.h;
        this._logoSnapEdgeV = snap.vEdge; this._logoSnapEdgeH = snap.hEdge;
        this._logoSnapPhotoV = snap.photoV; this._logoSnapPhotoH = snap.photoH;
        this.onSettingChanged();
    },

    // 参考线 + 四边吸附:吸附元素中心并记录命中的位置(供高亮)
    //  - 参考线:1/3、1/2、2/3 六条,吸附中心
    //  - 边缘  :贴左/右/上/下,吸附到「元素完整可见 + 最小边距」的位置
    //    水印最常见用法就是贴四角(右下角品牌、左下角日期),原实现只有三分线,贴角全靠手感,
    //    而且容易贴得太靠外——大 logo 会有一半落在画布外。
    // 位移量按元素实际绘制尺寸推导(而非固定比例),因此大 logo 会自动留出更大的贴边距离。
    //  - 照片区域:有边距(留白/卡片)时,照片是画布内的一块居中区域,额外吸附照片四边/中心,
    //    让元素能贴"照片边缘"而不是画布边缘。照片矩形按 baseMargin 边距估算。
    // 该方法对 logo / 贴纸 / 自由文字统一生效(Compositor 借鉴:元素吸附+参考线)。
    photoRectEstimate() {
        const cv = this.dom && this.dom.canvas;
        if (!cv || cv.width <= 1 || cv.height <= 1) return null;
        const m = (this.template && this.template.baseMargin) || {};
        const gm = m.globalMargin || 1;
        const padT = (m.refTop || 0) * gm, padB = (m.refBottom || 0) * gm;
        const padL = (m.refLeft || 0) * gm, padR = (m.refRight || 0) * gm;
        if (padT + padB + padL + padR <= 1 && Math.abs(gm - 1) <= 0.01) return null;
        const areaW = Math.max(10, cv.width - padL - padR);
        const areaH = Math.max(10, cv.height - padT - padB);
        const sc = m.imgScale || 1;
        const dw = areaW * sc, dh = areaH * sc;
        const px = m.imgOffsetX || 0, py = m.imgOffsetY || 0;
        return { x: cv.width / 2 - dw / 2 + px, y: cv.height / 2 - dh / 2 + py, w: dw, h: dh };
    },

    _logoDrawSize(el, kind) {
        if (kind === 'text' && el && typeof window.textLineMetrics === 'function') {
            const cv = this.dom && this.dom.canvas;
            const cw = (cv && cv._logW > 1) ? cv._logW : (cv ? cv.width : 0);
            const ch = (cv && cv._logH > 1) ? cv._logH : (cv ? cv.height : 0);
            if (cw > 1 && ch > 1) {
                const m = window.textLineMetrics(el, cw, ch, false, 0, 0);
                return { w: m.lw, h: m.lh };
            }
        }
        let size = Math.max(2, (el && el.size) || 60);
        if (kind === 'sticker') size = Math.max(6, Math.round(((el && el.scale) || 1) * 60));
        let ratio = (el && el.ratio) || 0;
        if (!ratio && el && el.dataUrl) {
            const im = window.getElementBitmap ? window.getElementBitmap(el.dataUrl) : null;
            if (im && im.naturalWidth) ratio = im.naturalHeight / im.naturalWidth;
        }
        if (!ratio) ratio = 0.4;   // 图片尚未就绪时的兜底纵横比
        return { w: size, h: size * ratio };
    },

    snapToGuides(x, y, cw, ch, el, kind) {
        const vLines = [cw / 3, cw / 2, cw * 2 / 3];
        const hLines = [ch / 3, ch / 2, ch * 2 / 3];
        const tol = 8;
        let sv = -1, sh = -1, dv = tol, dh = tol;
        for (let i = 0; i < vLines.length; i++) {
            const d = Math.abs(x - vLines[i]);
            if (d < dv) { dv = d; sv = i; }
        }
        for (let i = 0; i < hLines.length; i++) {
            const d = Math.abs(y - hLines[i]);
            if (d < dh) { dh = d; sh = i; }
        }
        let nx = sv >= 0 ? vLines[sv] : x;
        let ny = sh >= 0 ? hLines[sh] : y;

        const dim = this._logoDrawSize(el, kind);
        const dx = dim.w / 2, dy = dim.h / 2;
        const kx = Math.max(10, Math.min(cw * 0.05, dx));
        const ky = Math.max(10, Math.min(ch * 0.05, dy));
        const glx = Math.min(dx + kx, cw / 2);
        const gly = Math.min(dy + ky, ch / 2);

        // 分别记录「该方向是否真的发生了边缘约束」,不用"哪个更近"判断——
        // 例如元素在右上角时,左右两个候选的 x 距离可能相同。
        let vEdge = null, hEdge = null;
        let bestX = tol, bestY = tol;
        for (const [d, tag] of [[x - glx, 'left'], [cw - glx - x, 'right'], [Math.abs(x - cw / 2), 'hcenter']]) {
            if (d < bestX) { bestX = d; vEdge = tag; }
        }
        for (const [d, tag] of [[y - gly, 'top'], [ch - gly - y, 'bottom'], [Math.abs(y - ch / 2), 'vcenter']]) {
            if (d < bestY) { bestY = d; hEdge = tag; }
        }
        if (vEdge === 'left') nx = glx; else if (vEdge === 'right') nx = cw - glx;
        else if (vEdge === 'hcenter') nx = cw / 2;
        if (hEdge === 'top') ny = gly; else if (hEdge === 'bottom') ny = ch - gly;
        else if (hEdge === 'vcenter') ny = ch / 2;

        // 照片区域四边 + 中心吸附:仅在有边距(照片<画布)时生效
        let photoV = null, photoH = null;
        const pr = this.photoRectEstimate();
        if (pr) {
            const pTol = 10;
            let pbX = pTol, pTag = null;
            for (const [d, tag] of [[pr.x + dx, 'pleft'], [pr.x + pr.w - dx, 'pright'], [pr.x + pr.w / 2, 'phcenter']]) {
                const dd = Math.abs(x - d);
                if (dd < pbX) { pbX = dd; pTag = tag; }
            }
            if (pTag === 'pleft') { nx = pr.x + dx; photoV = 'pleft'; }
            else if (pTag === 'pright') { nx = pr.x + pr.w - dx; photoV = 'pright'; }
            else if (pTag === 'phcenter') { nx = pr.x + pr.w / 2; photoV = 'phcenter'; }
            let pbY = pTol, pTag2 = null;
            for (const [d, tag] of [[pr.y + dy, 'ptop'], [pr.y + pr.h - dy, 'pbottom'], [pr.y + pr.h / 2, 'pvcenter']]) {
                const dd = Math.abs(y - d);
                if (dd < pbY) { pbY = dd; pTag2 = tag; }
            }
            if (pTag2 === 'ptop') { ny = pr.y + dy; photoH = 'ptop'; }
            else if (pTag2 === 'pbottom') { ny = pr.y + pr.h - dy; photoH = 'pbottom'; }
            else if (pTag2 === 'pvcenter') { ny = pr.y + pr.h / 2; photoH = 'pvcenter'; }
        }

        return {
            x: nx, y: ny,
            v: sv >= 0 ? sv : null,
            h: sh >= 0 ? sh : null,
            vEdge, hEdge, photoV, photoH,
        };
    },

    textureEl(src) {
        if (!src) return null;
        if (this.logoImgCache[src]) return this.logoImgCache[src];
        if (this.textures) {
            const t = this.textures.find(x => x.name === src);
            if (t) { const im = new Image(); im.src = t.dataUrl; this.logoImgCache[src] = im; return im; }
        }
        const im = new Image(); im.src = src; this.logoImgCache[src] = im; return im;
    },

    syncSliderFromEl(el) {
        if (!el || !el.kind) return;
        const e = el.obj;
        const $ = this.$;
        const rot = $('slElementRotation'), op = $('slActiveIconOpacity'), sz = $('slElementSize');
        // 先归一化到 [0,360) 再取 1 位小数：直接取模会把 3.2 变成 3.200000000000017，
        // 那个长串会从 46px 的 .pval 里溢出来（用户截图里就是它）。
        const rotDeg = Math.round((((Number(e.rotation) || 0) % 360) + 360) % 360 * 10) / 10;
        if (rot) rot.value = rotDeg;
        if (op) op.value = Math.round(e.opacity != null ? e.opacity : 100);
        const sizeVal = el.kind === 'logo' ? Math.round(e.size || 60) : el.kind === 'sticker' ? Math.round((e.scale || 1) * 60) : 60;
        // 缩放滑块用平方映射覆盖 16~10000:低值端(常用的小 Logo)分度仍然细,高值端也能拖到
        if (sz) sz.value = Math.round(1000 * Math.sqrt(clampNum((sizeVal - 16) / (10000 - 16), 0, 1)));
        this.updateLabel('lblElementRotation', rotDeg + '°');
        this.updateLabel('lblActiveIconOpacity', Math.round(e.opacity != null ? e.opacity : 100) + '%');
        this.updateLabel('lblElementSize', sizeVal);
        const inpR = $('inpElRotation'), inpO = $('inpElOpacity'), inpS = $('inpElSize');
        if (inpR) inpR.value = rotDeg;
        if (inpO) inpO.value = Math.round(e.opacity != null ? e.opacity : 100);
        if (inpS) inpS.value = sizeVal;
        this.syncTextRows(el);
        this.syncElInputs();
    },

    // 把 #RRGGBB / rrggbb / 颜色名 归一成 <input type=color> 能吃的 #rrggbb
    _hex6(c) {
        const v = String(c == null ? '' : c).trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) return '#' + v.replace('#', '').toLowerCase();
        if (/^#?[0-9a-f]{3}$/i.test(v)) {
            const h = v.replace('#', '');
            return ('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
        }
        return '#ffffff';
    },

    // 文字专属的行只在选中文字时露出，其余时候整行收起。
    // 同时把「缩放」行换成「字号」——文字用 8~400 的线性字号滑条，
    // 比复用 logo 那条 16~10000 的平方映射好用得多（后者对 40px 的字几乎不可调）。
    syncTextRows(sel) {
        const $ = this.$;
        const isText = !!(sel && sel.kind === 'text' && sel.obj);
        const textRows = ['rowElTextContent', 'rowElTextFont', 'rowElTextSize', 'rowElTextColor',
                          'rowElTextDir', 'rowElTextSpacing'];
        textRows.forEach(id => {
            const r = $(id);
            if (r) r.style.display = isText ? '' : 'none';
        });
        const rowScale = $('rowElSize');
        if (rowScale) rowScale.style.display = isText ? 'none' : '';
        if (!isText) return;

        const e = sel.obj;
        // 内容：正在输入时不覆盖，否则每帧渲染都会把光标位置顶掉
        const tf = $('tfElText');
        if (tf && document.activeElement !== tf) tf.value = e.text || '';

        // 字体：预设里可能写成 '"Microsoft YaHei", sans-serif'，取第一个族名去匹配
        const cbF = $('cbElTextFont');
        if (cbF) {
            const fam = String(e.fontFamily || 'Microsoft YaHei').split(',')[0].replace(/["']/g, '').trim();
            if ([].some.call(cbF.options, o => o.value === fam)) cbF.value = fam;
            else if (cbF.options.length) cbF.value = cbF.options[0].value;
        }

        const fs = Math.round(Number(e.fontSize) || 18);
        const slS = $('slElTextSize'), inS = $('inpElTextSize');
        if (slS) slS.value = Math.max(8, Math.min(400, fs));
        if (inS) inS.value = fs;
        this.updateLabel('lblElTextSize', fs + 'px');

        const cp = $('cpElTextColor');
        if (cp) cp.value = this._hex6(e.colorHex);

        const cb = $('cbElTextDir');
        if (cb) cb.value = (typeof window.textLineDir === 'function') ? window.textLineDir(e) : 'h';
        const sl = $('slElTextSpacing');
        const ls = Math.round(Number(e.letterSpacing) || 0);
        if (sl) sl.value = Math.max(0, Math.min(40, ls));
        this.updateLabel('lblElTextSpacing', ls + 'px');
    },

    drawSelectionBox() {
        this._rotHandle = null;   // 只有「单选一个元素」时才会重新写它
        try {
            const canvas = this.dom.canvas;
            if (!canvas || !this.selectedEls || !this.selectedEls.length) return;
            const ctx = canvas.getContext('2d');
            for (const sel of this.selectedEls) {
                const e = sel.obj;
                if (!e) continue;
                // 文字用真实度量框（含方向/旋转）：原来按 logo 的 size 画 60px 方块，
                // 对文字既不是它的位置也不是它的大小。
                if (sel.kind === 'text' && typeof window.textLineMetrics === 'function') {
                    const cw = (canvas._logW > 1) ? canvas._logW : canvas.width;
                    const chh = (canvas._logH > 1) ? canvas._logH : canvas.height;
                    const k = this.textSpaceScale();
                    const m = window.textLineMetrics(e, cw, chh, false, 0, 0);
                    const bw = Math.max(14, m.lw * k), bh = Math.max(14, m.lh * k);
                    ctx.save();
                    ctx.translate(m.cx * k, m.cy * k);
                    if (m.rot) ctx.rotate(m.rot * Math.PI / 180);
                    ctx.strokeStyle = '#00e5a0';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([6, 4]);
                    ctx.strokeRect(-bw / 2 - 3, -bh / 2 - 3, bw + 6, bh + 6);
                    ctx.setLineDash([]);
                    // 四个角的小方块：提示「可拖」，与其它元素一致
                    ctx.fillStyle = '#00e5a0';
                    const h = 5;
                    [[-bw/2-3, -bh/2-3], [bw/2+3-h, -bh/2-3], [-bw/2-3, bh/2+3-h], [bw/2+3-h, bh/2+3-h]].forEach(([x, y]) => {
                        ctx.fillRect(x, y, h, h);
                    });
                    // 旋转把手：框顶外侧一个圆点。位置在这里算一次并存下来，
                    // 命中检测(mousedown)直接用 —— 两处各算一遍角度迟早对不上。
                    if (this.selectedEls.length === 1) {
                        // 注意：这段已经在 translate/rotate 之后的**局部**坐标系里，
                        // 所以线要画在 (0,-bh/2)→(0,-dist)，不能再按绝对坐标画一次
                        // 把手尺寸按 DPI 缩放：画布是物理像素，写死 6 在高分屏上只有 3 CSS px，
                        // 小到点不中，也看不见。
                        const kr = 7 * k;
                        const dist = bh / 2 + 14 * k;
                        const th = m.rot * Math.PI / 180;
                        ctx.strokeStyle = 'rgba(0,229,160,0.9)';
                        ctx.lineWidth = 1.5 * k;
                        ctx.beginPath(); ctx.moveTo(0, -bh / 2); ctx.lineTo(0, -dist); ctx.stroke();
                        ctx.beginPath(); ctx.arc(0, -dist, kr, 0, Math.PI * 2);
                        ctx.fillStyle = '#00e5a0'; ctx.fill();
                        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * k; ctx.stroke();
                        this._rotHandle = {
                            x: m.cx * k + dist * Math.sin(th),
                            y: m.cy * k - dist * Math.cos(th),
                            r: kr,
                        };
                    }
                    ctx.restore();
                    continue;
                }
                let cx = e.x, cy = e.y, size = e.size || 60;
                if (typeof cx !== 'number' || typeof cy !== 'number') {
                    const p = this.logoPos(e, canvas.width, canvas.height, size);
                    cx = p.cx; cy = p.cy;
                }
                ctx.save();
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.strokeRect(cx - size / 2 - 6, cy - size / 2 - 6, size + 12, size + 12);
                ctx.setLineDash([]);
                ctx.fillStyle = '#00e5a0';
                const h = 5;
                [[cx-size/2-6, cy-size/2-6],[cx+size/2+6-h, cy-size/2-6],
                 [cx-size/2-6, cy+size/2+6-h],[cx+size/2+6-h, cy+size/2+6-h]].forEach(([x,y])=>{
                    ctx.fillRect(x, y, h, h);
                });
                ctx.restore();
            }
        } catch(err) { console.warn('drawSelectionBox', err); }
    },

    // 拖 logo 时叠加参考线:三分/中心线、四边吸附高亮、安全区提示
    drawLogoGuides() {
        try {
            if (!this._dragEl) return;
            const canvas = this.dom.canvas;
            if (!canvas || !canvas.width) return;
            const ctx = canvas.getContext('2d');
            const cw = canvas.width, ch = canvas.height;
            const vLines = [cw / 3, cw / 2, cw * 2 / 3];
            const hLines = [ch / 3, ch / 2, ch * 2 / 3];
            ctx.save();
            const drawLine = (x1, y1, x2, y2, active) => {
                // 深色衬底 + 亮线两层,保证深/浅背景都清晰
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = active ? 5 : 3;
                ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = active ? '#00e5a0' : 'rgba(255,255,255,0.8)';
                ctx.lineWidth = active ? 2.5 : 1.5;
                if (active) {
                    ctx.shadowColor = '#00e5a0';
                    ctx.shadowBlur = 8;
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            };
            vLines.forEach((x, i) => drawLine(x, 0, x, ch, i === this._logoSnapV));
            hLines.forEach((y, i) => drawLine(0, y, cw, y, i === this._logoSnapH));

            // 边缘吸附:高亮贴住的那条画布边,让"已贴边"有明确反馈
            const ev = this._logoSnapEdgeV, eh = this._logoSnapEdgeH;
            if (ev === 'left') drawLine(1, 0, 1, ch, true);
            else if (ev === 'right') drawLine(cw - 1, 0, cw - 1, ch, true);
            if (eh === 'top') drawLine(0, 1, cw, 1, true);
            else if (eh === 'bottom') drawLine(0, ch - 1, cw, ch - 1, true);

            // 安全区:提示"贴到这里以内不会被裁"。(居中吸附时不画,避免与中心线视觉混淆)
            const dim = this._logoDrawSize(this._dragEl.ref, this._dragEl.kind);
            const kx = Math.max(10, Math.min(cw * 0.05, dim.w / 2));
            const ky = Math.max(10, Math.min(ch * 0.05, dim.h / 2));
            ctx.setLineDash([7, 6]);
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(kx, ky, Math.max(1, cw - kx * 2), Math.max(1, ch - ky * 2));
            ctx.setLineDash([]);

            // 照片区域参考线(金色):照片四边 + 中心,命中的那条高亮
            const pr = this.photoRectEstimate();
            if (pr) {
                const pv = this._logoSnapPhotoV, ph = this._logoSnapPhotoH;
                const drawP = (x1, y1, x2, y2, active) => {
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                    ctx.lineWidth = active ? 5 : 2.5;
                    ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                    ctx.strokeStyle = active ? '#ffb454' : 'rgba(255,180,84,0.45)';
                    ctx.lineWidth = active ? 2.5 : 1;
                    ctx.stroke();
                };
                drawP(pr.x, pr.y, pr.x, pr.y + pr.h, pv === 'pleft');
                drawP(pr.x + pr.w, pr.y, pr.x + pr.w, pr.y + pr.h, pv === 'pright');
                drawP(pr.x, pr.y, pr.x + pr.w, pr.y, ph === 'ptop');
                drawP(pr.x, pr.y + pr.h, pr.x + pr.w, pr.y + pr.h, ph === 'pbottom');
                if (pv === 'phcenter') drawP(pr.x + pr.w / 2, 0, pr.x + pr.w / 2, ch, true);
                if (ph === 'pvcenter') drawP(0, pr.y + pr.h / 2, cw, pr.y + pr.h / 2, true);
            }

            // 命中反馈:在元素中心画瞄准环
            if (this._logoSnapV != null || this._logoSnapH != null || ev || eh || this._logoSnapPhotoV || this._logoSnapPhotoH) {
                const el = this._dragEl.ref;
                const size = el.size || 60;
                // 与 hitTestLogos 同理:瞄准环要画在 logo 实际绘制处(rel 用 _logW 口径),
                // 画布口径会偏 2 倍(dpr=2 时),环与 logo 对不上。
                const gb = this.logoBaseForOverlay();
                const cx0 = this.logoPos(el, gb.w, gb.h, size).cx, cy0 = this.logoPos(el, gb.w, gb.h, size).cy;
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = 4;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.shadowColor = '#00e5a0';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(cx0, cy0, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#00e5a0';
                ctx.fill();
            }
            ctx.restore();
        } catch(err) { console.warn('drawLogoGuides', err); }
    },

    armLogoPlacement(logo) {
        // 直接加到画布中央,然后用户可拖动
        this.addLogoElement(logo);
    },

    async addLogoElement(logo, px, py) {
        if (!logo) return;
        this.onSettingCommit();
        if (!this.template) return;
        // 预加载图标到缓存,确保渲染时图片已就绪(避免首帧因 Image 未加载完而跳过绘制)
        const bmp = this.logoImgCache[logo.dataUrl] || new Image();
        this.logoImgCache[logo.dataUrl] = bmp;
        if (!bmp.complete || !bmp.naturalWidth) {
            await new Promise(res => { bmp.onload = res; bmp.onerror = res; bmp.src = logo.dataUrl; });
        }
        if (!this.template.logoElements) this.template.logoElements = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        // 默认按画布宽度取比例(原为写死的 500px):固定值在 800px 画布上占 62%,在 3600px 上只占 14%,
        // 用户每次都得手动调。改为约 12% 画布宽并夹在 80~2000,大小观感在不同分辨率下保持一致。
        const size = clampNum(Math.round(cw * 0.12), 80, 2000);
        const el = {
            name: logo.name, dataUrl: logo.dataUrl, img: null,
            x: px != null ? px : Math.round(cw / 2), y: py != null ? py : Math.round(ch / 2), size, opacity: 100, rotation: 0, z: 10, free: 1,
            ratio: bmp.naturalHeight / bmp.naturalWidth || 1,
        };
        // 补记相对比例:新加的 Logo 默认在画布中央,换照片尺寸时应仍在中央,而不是按像素算偏
        this.setLogoPixelPos(el, el.x, el.y);
        this.template.logoElements.push(el);
        this.selectedEls = [{ kind: 'logo', obj: el }];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus(`已添加 Logo「${logo.name}」`);
    },

    focusElement(el, factor) {
        if (!el || !this.image) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const rect = stage.getBoundingClientRect();
        const z0 = this.zoom || 0.1;
        const z1 = Math.min(3, Math.max(0.1, z0 * (factor || 2.5)));
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        const fx = (el.x / canvas.width) * lw, fy = (el.y / canvas.height) * lh;
        this.panX = Math.round(rect.width / 2 - fx * z1);
        this.panY = Math.round(rect.height / 2 - fy * z1);
        this.setZoom(z1);
    },

    // 文字转图片:把输入文字渲染成透明 PNG,作为可拖拽/缩放/旋转的元素加到画布(复用 Logo 管线)
    async textToImage() {
        const $ = this.$;
        const inp = $('tfTextToImage');
        const text = inp ? String(inp.value).trim() : '';
        if (!text) { this.setStatus('先输入要转图片的文字'); return; }
        const fontSel = $('cbT2iFont'), colorInp = $('cpT2iColor'), effSel = $('cbT2iEffect');
        const fontFamily = fontSel && fontSel.value ? fontSel.value : '"Microsoft YaHei","PingFang SC",sans-serif';
        const color = colorInp && colorInp.value ? colorInp.value : '#000000';
        const effect = effSel ? effSel.value : 'none';
        const c = document.createElement('canvas');
        const pad = 56, font = '700 120px ' + fontFamily;
        let ctx = c.getContext('2d');
        ctx.font = font;
        const w = Math.max(10, Math.ceil(ctx.measureText(text).width));
        c.width = w + pad * 2;
        c.height = 232;
        ctx = c.getContext('2d');
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const tx = pad, ty = c.height / 2;
        const gradTop = '#ffffff', gradBottom = color;
        if (effect === 'stroke') {
            ctx.lineWidth = 10; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ffffff';
            ctx.strokeText(text, tx, ty);
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        } else if (effect === 'shadow') {
            ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 8; ctx.shadowBlur = 18;
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        } else if (effect === 'gradient') {
            const g = ctx.createLinearGradient(0, ty - 70, 0, ty + 70);
            g.addColorStop(0, gradTop); g.addColorStop(1, gradBottom);
            ctx.fillStyle = g; ctx.fillText(text, tx, ty);
        } else if (effect === 'outline') {
            ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.strokeStyle = color;
            ctx.strokeText(text, tx, ty);
        } else {
            ctx.fillStyle = color; ctx.fillText(text, tx, ty);
        }
        const dataUrl = c.toDataURL('image/png');
        const logo = { name: text, dataUrl, custom: true };
        this.logos.push(logo);
        this.saveCustomIcon(logo);
        await this.addLogoElement(logo);
        this.renderLogoPools();
        if (inp) inp.value = '';
        this.setStatus('已把文字「' + text + '」转成图片元素:已存入自定义图标池,可直接拖拽/缩放/旋转');
    },

    async addCustomIcon() {
        const res = await window.qingframe.openStickerImage();
        if (res && res.error) { this.setStatus(res.error); return; }
        if (!res || !res.data) return;
        // 按扩展名判断 MIME:主进程只回传文件名与 base64。此前一律标成 image/jpeg,
        // 会把带透明通道的 PNG 图标当作 JPEG 解码,导致透明底变黑、边缘出现杂色块。
        const ext = String(res.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        const mime = { png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[ext ? ext[1] : ''] || 'image/jpeg';
        const dataUrl = 'data:' + mime + ';base64,' + res.data;
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = dataUrl; });
        if (!im.naturalWidth) { this.setStatus('图片加载失败'); return; }
        const defaultName = String(res.name || '自定义').replace(/\.[a-z0-9]+$/i, '');
        const typed = await this.promptText('给这个 Logo 起个名字(留空则用文件名)', defaultName);
        if (typed === null) { this.setStatus('已取消添加'); return; }
        const logo = { name: (typed || '').trim() || defaultName, dataUrl, custom: true };
        this.logos.push(logo);
        this.saveCustomIcon(logo);
        this.addLogoElement(logo);
        this.renderLogoPools();
    },

    refreshElList() {
        const $ = this.$;
        const list = $('elList'), status = $('elStatus');
        if (!list) return;
        const t = this.template;
        const items = [];
        (t && t.logoElements || []).forEach((el, i) => items.push({ kind: 'logo', i, label: el.name || 'Logo', src: el.dataUrl, obj: el }));
        (t && t.decorConfig && t.decorConfig.stickers || []).forEach((el, i) => items.push({ kind: 'sticker', i, label: '贴纸', src: el.src, obj: el }));
        (t && t.decorConfig && t.decorConfig.textLines || []).forEach((el, i) => {
            // 不再只收 align==='free'：87 个预设的文字全是锚定行，只收 free 等于
            // 「元素管理」里一个字都看不到，用户只能改字号。这里全列出来，
            // 拖动/输入坐标时才就地解锁（promoteTextToFree），画面不跳。
            if (!el.text || this._isHiddenExifLine(el, t.decorConfig)) return;
            items.push({ kind: 'text', i, label: String(el.text).substring(0, 8), src: null, obj: el });
        });
        list.innerHTML = '';
        if (!items.length) {
            status.textContent = '未选中元素';
            const e = document.createElement('div');
            e.className = 'el-row';
            e.textContent = '画布上暂无文字/贴纸/Logo';
            list.appendChild(e);
            return;
        }
        const tagMap = { logo: 'Logo', sticker: '贴纸', text: '文字' };
        items.forEach(it => {
            const r = document.createElement('div');
            r.className = 'el-row';
            if (it.kind === 'logo' || it.kind === 'sticker') {
                const img = document.createElement('img');
                img.src = it.src;
                r.appendChild(img);
            }
            const span = document.createElement('span');
            span.textContent = it.label;
            r.appendChild(span);
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = tagMap[it.kind];
            r.appendChild(tag);
            const sel = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
            if (sel) r.classList.add('active');
            // 列表多选:普通点击=单选;Ctrl/Cmd 点击=加选/取消;Shift 点击=范围选取。
            // 底层 selectedEls / applyToSelectedEls / 批量滑块早就支持多选,此前列表点击会
            // 直接覆盖选中集,导致"给多个 Logo 统一调透明度"只能在画布上逐个 Shift 点选。
            r.addEventListener('click', (ev) => {
                const cur = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
                if (ev.shiftKey && this._elListAnchor) {
                    const i0 = items.findIndex(x => x.obj === this._elListAnchor.obj && x.kind === this._elListAnchor.kind);
                    const i1 = items.indexOf(it);
                    if (i0 >= 0 && i1 >= 0) {
                        const [a, b] = i0 <= i1 ? [i0, i1] : [i1, i0];
                        const range = items.slice(a, b + 1).map(x => ({ kind: x.kind, obj: x.obj }));
                        // 叠加去重,保留已有选中项
                        const merged = this.selectedEls.slice();
                        range.forEach(r2 => {
                            if (!merged.some(m => m.kind === r2.kind && m.obj === r2.obj)) merged.push(r2);
                        });
                        this.selectedEls = merged;
                    }
                } else if (ev.ctrlKey || ev.metaKey) {
                    if (cur) this.selectedEls = this.selectedEls.filter(x => !(x.kind === it.kind && x.obj === it.obj));
                    else this.selectedEls.push({ kind: it.kind, obj: it.obj });
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                } else {
                    this.selectedEls = [{ kind: it.kind, obj: it.obj }];
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                }
                this.refreshElList();
                this.scheduleRender(true);
            });
            list.appendChild(r);
        });
        const first = this.selectedEls.length ? this.selectedEls[0] : null;
        const n = this.selectedEls.length;
        status.textContent = !first ? `共 ${items.length} 个元素,点击选择(可 Ctrl/Shift 多选)`
            : (n > 1 ? `已选中 ${n} 个元素` : `${tagMap[first.kind]}「${this.elLabel(first.obj)}」已选中`);
        if (first) this.syncSliderFromEl({ kind: first.kind, obj: first.obj });
        else this.syncTextRows(null);   // 取消选中时把「方向/字距」两行也收起来
        this.syncElInputs();
    },

    elLabel(el) {
        if (!el) return '';
        return el.name || el.text || '元素';
    },

    applyToSelectedEls(fn) {
        this.selectedEls.forEach(s => fn(s.obj, s.kind));
    },

    batchElOps() {
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    copyElement() {
        const first = this.selectedEls[0];
        if (!first) { this.setStatus('请先选中元素'); return; }
        this._elClip = { kind: first.kind, el: JSON.parse(JSON.stringify(first.obj)) };
        this.setStatus('已复制选中元素');
    },

    pasteElement() {
        if (!this._elClip) { this.setStatus('剪贴板为空'); return; }
        this.onSettingCommit();
        const t = this.template;
        const make = () => {
            const copy = JSON.parse(JSON.stringify(this._elClip.el));
            if (copy.x != null) copy.x += 24;
            if (copy.y != null) copy.y += 24;
            if (copy.offsetX != null) copy.offsetX += 24;
            if (copy.offsetY != null) copy.offsetY += 24;
            return copy;
        };
        let placed = null;
        if (this._elClip.kind === 'logo') {
            if (!t.logoElements) t.logoElements = [];
            const n = make(); t.logoElements.push(n); placed = { kind: 'logo', obj: n };
        } else if (this._elClip.kind === 'sticker') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.stickers) decor.stickers = [];
            const n = make(); decor.stickers.push(n); placed = { kind: 'sticker', obj: n };
        } else if (this._elClip.kind === 'text') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.textLines) decor.textLines = [];
            const n = make(); decor.textLines.push(n); placed = { kind: 'text', obj: n };
        }
        if (placed) this.selectedEls = [placed];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },

    deleteElement() {
        const sel = this.selectedEls;
        if (!sel.length) { this.setStatus('请先选中元素'); return; }
        this.onSettingCommit();
        const t = this.template;
        sel.forEach(s => {
            if (s.kind === 'logo') { const i = (t.logoElements || []).indexOf(s.obj); if (i >= 0) t.logoElements.splice(i, 1); }
            else if (s.kind === 'sticker') { const a = (t.decorConfig && t.decorConfig.stickers) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
            else if (s.kind === 'text') { const a = (t.decorConfig && t.decorConfig.textLines) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
        });
        this.selectedEls = [];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },

    clearElements() {
        if (!this.template) return;
        this.onSettingCommit();
        this.template.logoElements = [];
        if (this.template.decorConfig) { this.template.decorConfig.stickers = []; this.template.decorConfig.textLines = []; }
        this.selectedEls = [];
        delete this.template._draftText;
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已清空全部元素');
    },

    moveZOrder(delta) {
        if (!this.selectedEls.length) { this.setStatus('请先选中元素'); return; }
        this.onSettingCommit();
        const kinds = ['logo', 'sticker', 'text'];
        kinds.forEach(kind => {
            const els = (kind === 'logo') ? (this.template.logoElements || [])
                : (kind === 'sticker') ? (this.template.decorConfig && this.template.decorConfig.stickers || [])
                    : (this.template.decorConfig && this.template.decorConfig.textLines || []);
            this.selectedEls.forEach(s => {
                const i = els.indexOf(s.obj);
                if (i < 0) return;
                els[i].z = (els[i].z || 0) + delta;
                // 通过 z 排序实现层级:直接赋序
                els[i].z = clampNum(els[i].z, -100, 100);
            });
            // 依据 z 排序后按新序重排数组(等效 Java 中 moveZOrder 1/-1/2/-2)
            els.sort((a, b) => (a.z || 0) - (b.z || 0));
        });
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },



    // 元素对齐 / 均分 / 统一尺寸。基准取「所有选中元素的包围盒」(贴近常见编辑器行为)。
    // 兼容两种坐标:绝对像素(el.x 为数字)与锚点+偏移(el.x 为 'right'/'bottom' 等)。
    // 后者在写回时按目标点反算 offset,避免被强行转成像素坐标而失去"随画布自适应"的特性。
    alignSelectedEls(mode) {
        const sel = (this.selectedEls || []).filter(s => s && s.obj);
        if (sel.length < 2) { this.setStatus('请至少选中两个元素再对齐'); return; }
        const cv = this.dom.canvas;
        const cwM = Math.max(1, cv.width), chM = Math.max(1, cv.height);
        const lw = cv._logW || cwM, lh = cv._logH || chM;

        this.onSettingCommit();
        const boxes = sel.map(s => {
            const o = s.obj;
            const dim = this._elBoxSize(s);
            const cur = (typeof o.x === 'number' && typeof o.y === 'number')
                ? { cx: o.x, cy: o.y }
                : this.logoPos(o, lw, lh, dim.w);
            return { s, dim, cur, box: { x0: cur.cx - dim.w / 2, y0: cur.cy - dim.h / 2, x1: cur.cx + dim.w / 2, y1: cur.cy + dim.h / 2 } };
        });

        const L = Math.min(...boxes.map(b => b.box.x0));
        const R = Math.max(...boxes.map(b => b.box.x1));
        const T = Math.min(...boxes.map(b => b.box.y0));
        const B = Math.max(...boxes.map(b => b.box.y1));
        const HC = (L + R) / 2, VC = (T + B) / 2;

        if (mode === 'sameSize') {
            const avg = Math.round(boxes.reduce((sum, b) => sum + b.dim.w, 0) / boxes.length);
            boxes.forEach(b => { this._applyElSize(b.s.kind, b.s.obj, Math.max(2, avg)); });
        } else if (mode === 'distH' || mode === 'distV') {
            const horiz = mode === 'distH';
            const sorted = boxes.slice().sort((a, b) => (horiz ? a.cur.cx - b.cur.cx : a.cur.cy - b.cur.cy));
            const first = sorted[0], last = sorted[sorted.length - 1];
            const span = horiz ? (last.cur.cx - first.cur.cx) : (last.cur.cy - first.cur.cy);
            const step = span / (sorted.length - 1);
            sorted.forEach((b, i) => {
                const cx = horiz ? first.cur.cx + step * i : b.cur.cx;
                const cy = horiz ? b.cur.cy : first.cur.cy + step * i;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        } else {
            boxes.forEach(b => {
                let cx = b.cur.cx, cy = b.cur.cy;
                if (mode === 'left') cx = L + b.dim.w / 2;
                else if (mode === 'right') cx = R - b.dim.w / 2;
                else if (mode === 'hcenter') cx = HC;
                else if (mode === 'top') cy = T + b.dim.h / 2;
                else if (mode === 'bottom') cy = B - b.dim.h / 2;
                else if (mode === 'vcenter') cy = VC;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        }
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        const names = { left: '左对齐', hcenter: '水平居中', right: '右对齐', top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐', distH: '水平均分', distV: '垂直均分', sameSize: '统一尺寸' };
        this.setStatus('已' + (names[mode] || mode));
    },

    // 元素在画布上的近似外接尺寸(对齐用)。Logo 为宽×宽×纵横比;贴纸按原图×scale;文字按字号方块。
    _elBoxSize(s) {
        const o = s.obj || {};
        if (s.kind === 'logo') return this._logoDrawSize(o);
        if (s.kind === 'sticker') {
            const im = window.getElementBitmap ? window.getElementBitmap(o.src) : null;
            const sc = o.scale || 1;
            const w = (im && im.naturalWidth ? im.naturalWidth : 100) * sc;
            const h = (im && im.naturalHeight ? im.naturalHeight : 100) * sc;
            return { w, h };
        }
        const f = (o.fontSize || 18) * 1.2;
        return { w: f * Math.max(1, String(o.text || '').length) * 0.6, h: f };
    },

    _applyElSize(kind, o, size) {
        if (kind === 'logo') o.size = clampNum(size, 8, 10000);
        else if (kind === 'sticker') o.scale = clampNum(size / 100, 0.02, 3);
        else if (kind === 'text') o.fontSize = clampNum(size, 6, 300);
    },

    _applyElPos(o, cx, cy, cwM, chM, lw, lh, dim) {
        if (typeof o.x === 'string' || typeof o.y === 'string') {
            // 锚点定位:保持锚点不变,按目标点反算偏移量,这样它仍能随画布尺寸自适应
            const hAlign = o.x || 'right', vAlign = o.y || 'bottom';
            const half = dim.w / 2, halfY = dim.h / 2;
            if (hAlign === 'left') o.offsetX = Math.round(cx - half);
            else if (hAlign === 'center') o.offsetX = 0;
            else o.offsetX = Math.round(lw - cx - half);
            if (vAlign === 'top') o.offsetY = Math.round(cy - halfY);
            else if (vAlign === 'center') o.offsetY = 0;
            else o.offsetY = Math.round(lh - cy - halfY);
            if (o.offsetX < 0) o.offsetX = 0;
            if (o.offsetY < 0) o.offsetY = 0;
            return;
        }
        // 绝对坐标:按测量画布→显示画布的缩放换算(与拖拽一致),并同步相对比例
        this.setLogoPixelPos(o, cx * (cwM / lw), cy * (chM / lh));
    },
});
