// 导出模块：图片导出 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    // 等下一帧渲染一次(导出通道专用)。渲染异常必须把 Promise 拒掉:
    // 旧写法 `render(); res();` 在渲染抛错时 res 永不执行 → 导出流程悬死,
    // uiDprOverride/displayMax 等临时档位也永远不还原(画面缩放平移被钉死)。
    _awaitFrameRender(puzzle) {
        return new Promise((res, rej) => requestAnimationFrame(() => {
            try {
                if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                else window.__render(this, false);
                res();
            } catch (e) { rej(e); }
        }));
    },

    // 导出保留拍摄信息(EXIF)的开关 → 主进程移植参数;返回 {} 或 { originalPath, keepGps }。
    // 不满足条件(没勾 / 没有磁盘路径 / 非 JPG)一律 {}(.qfs 载入的照片没有路径,天然不参与)
    _exportExifFor(im) {
        const d = this.dom || {};
        if (!(d.chkKeepExif && d.chkKeepExif.checked)) return {};
        if (!im || !im.path) return {};
        if (!(d.selFormat && d.selFormat.value === 'jpeg')) return {};   // PNG/WebP 暂无 eXIf 容器写入
        return { originalPath: im.path, keepGps: !!(d.chkKeepGps && d.chkKeepGps.checked) };
    },

    /* ── 导出总入口:工具栏主按钮 / Ctrl+E / 右键菜单共用 ──
       只有切图页签要换通道(九宫格是一张图切成 n² 块,不是单图导出)。
       拼图页签仍走主导出管线:exportImage 自己会渲染拼图成品,格式/质量/尺寸都跟随导出设置
       (默认 JPG),不再被锁死在拼图面板按钮的固定档位上。 */
    doExport() {
        const active = this.dom.tabs && this.dom.tabs.querySelector('.tab.active');
        const tab = active ? active.dataset.tab : '';
        if (tab === 'grid') return this.exportGridCrop();
        return this.exportImage();
    },

    /* ── 复制:把当前画布(所见即所得)写进系统剪贴板 ── */
    // 直接用预览画布,不重渲染:不碰 displayMax / 模板深拷贝 / 元素缩放,零状态副作用。
    // 画布分辨率 = 逻辑尺寸 × devicePixelRatio,常规窗口下长边约 1000~2000px,
    // 足够微信、小红书(两家都会压到 1080 宽);要更大尺寸请走「导出」。
    async copyImage() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const api = window.qingframe;
        if (!api || !api.copyImage) { this.setStatus('当前环境不支持复制到剪贴板'); return; }
        const btn = this.dom && this.dom.btnCopy;
        if (btn && btn.disabled) return;
        try {
            if (btn) btn.disabled = true;
            // 排队中的预览帧会改写同一块画布,先让它落定,否则可能复制到中间态
            if (this._renderRaf || this._renderDirty) await this.flushRender();
            const src = this.dom.canvas;
            if (!src || !src.width || !src.height) { this.setStatus('画布还没准备好,请稍后再试'); return; }
            // 垫白底:带圆角/留白的模板直接复制会得到透明 PNG,粘到不支持 alpha 的应用里会变黑
            const out = document.createElement('canvas');
            out.width = src.width; out.height = src.height;
            const ctx = out.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, out.width, out.height);
            ctx.drawImage(src, 0, 0);
            const r = await api.copyImage(out.toDataURL('image/png'));
            if (r && r.ok) this.setStatus(`已复制 ${r.width}×${r.height},可直接粘贴到微信 / 小红书`);
            else this.setStatus('复制失败:' + ((r && r.message) || '剪贴板不可用'));
        } catch (e) {
            this.setStatus('复制失败:' + ((e && e.message) || '未知错误'));
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    /* ── 导出:先选保存位置,再渲染导出画面,最后写盘 ── */
    async exportImage() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        // 每次导出重新求通道比例(画布/显示尺寸可能在两次导出之间变过)
        delete this._exportPathDpr;
        const fmt = this.dom.selFormat.value;
        const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt] || 'image/jpeg';
        const lossy = fmt === 'jpeg' || fmt === 'webp';
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const quality = lossy ? Math.min(1, Math.max(0.6, (parseInt(this.dom.slExportQuality.value, 10) || 92) / 100)) : 1;
        const sizeOpt = parseInt(this.dom.selExportSize.value, 10) || 0;
        const needsBg = fmt === 'jpeg';
        const targets = this.selectedIdx.length > 1 ? this.selectedIdx : [this.currentIdx];
        const jobs = [];
        targets.forEach(idx => {
            const im = this.images[idx];
            if (!im) return;
            const tpl = this.exportTemplateFor(im, idx, this.currentIdx, this.template);
            const puzzle = !!(tpl && tpl.puzzle && tpl.puzzle.enabled);
            // blank:未设过边框(默认空模板),多图导出时会被静默当成“原图直出”,与预览预期不符
            jobs.push({ im, puzzle, blank: !this.hasBorderSettings(tpl), useBase: false });
        });
        if (!jobs.length) { this.setStatus('请先导入照片'); return; }

        // 空模板陷阱:当前正编辑的边框有意义,而其它照片还没有边框 → 给一次选择:沿用当前设计 / 按原图直出
        let useBaseCount = 0;
        const blanks = jobs.filter(j => j.blank);
        if (jobs.length > 1 && blanks.length && this.hasBorderSettings(this.template)) {
            const names = blanks.slice(0, 3).map(j => (j.im.name || '照片').replace(/\.[^.]+$/, '')).join('、');
            const more = blanks.length > 3 ? `…等 ${blanks.length} 张` : `共 ${blanks.length} 张`;
            const ok = window.confirm(`${names}${more}还没有设置边框,默认会按原图导出。\n\n是否改为沿用当前边框设计导出这些照片?`);
            if (ok) blanks.forEach(j => { j.blank = false; j.useBase = true; useBaseCount++; });
        }

        // ① 先在画布外准备好文件名(不触发任何渲染),单文件时作为默认名
        const files = jobs.map(j => {
            const baseName = (j.im.name || 'photo').replace(/\.[^.]+$/, '');
            // 拼图是多图合成,没有单一拍摄信息来源 → 不带;其余按开关带原图路径
            return Object.assign(
                { data: null, bytes: null, stem: `${baseName}${j.puzzle ? '_拼图' : '_边框'}`, ext },
                j.puzzle ? {} : this._exportExifFor(j.im)
            );
        });
        this.dedupeExportNames(files);

        // ② 先弹出保存位置:多文件选目录,单文件选文件
        let loc;
        try {
            loc = await window.qingframe.pickExportLocation({ count: jobs.length, hintName: files[0].filename });
        } catch (e) { loc = null; }
        if (!loc || loc.canceled) { this.setStatus('已取消导出'); return; }

        // ③ 再逐张渲染导出画面(展示画布同步变大),期间无渲染的确认框
        const originalIdx = this.currentIdx;
        const baseTemplate = this.template;
        const prevMax = this.displayMax;
        const uiMaxSave = this.dom.canvas.width;
        const scaleElPix = (tpl, k) => {
            if (k === 1) return false;
            let any = false;
            (tpl.logoElements || []).forEach(el => {
                // 只缩放「尺寸」。位置不再按 k 放大:
                //  - rel 元素的位置是相对比例(rx/ry),与画布大小无关,放大比例会把它推出画布;
                //  - 锚点元素兼容旧模板的 offsetX/offsetY,按 k 放大以保持视觉边距。
                if (el.size) el.size *= k;
                if (typeof el.x !== 'number' && (el.offsetX || el.offsetY)) {
                    if (el.offsetX) el.offsetX *= k;
                    if (el.offsetY) el.offsetY *= k;
                }
                any = true;
            });
            (tpl.decorConfig && tpl.decorConfig.stickers || []).forEach(s => {
                s.x = (s.x || 0) * k; s.y = (s.y || 0) * k; s.scale = (s.scale || 1) * k;
                any = true;
            });
            (tpl.decorConfig && tpl.decorConfig.textLines || []).forEach(l => {
                if (l.align === 'free') { l.x = (l.x || 0) * k; l.y = (l.y || 0) * k; l.fontSize = (l.fontSize || 18) * k; any = true; }
            });
            return any;
        };
        // 试渲染只服务于「元素随导出尺寸等比缩放」;拼图仍走原口径。整批都没有 logo/贴纸/
        // 自由文字时,一次 UI 尺寸试渲染都不做 —— 3D 卡片这类重样式在 1800px 上就要 ~0.8s。
        // 只要有一张需要,就沿用原口径(每张都试),_exportPathDpr 的取值顺序与之前一致。
        const needProbe = jobs.some(j => {
            if (j.puzzle) return true;
            const tpl = j.useBase ? baseTemplate
                : this.exportTemplateFor(j.im, this.images.indexOf(j.im), originalIdx, baseTemplate);
            return this._hasScalableElements(tpl);
        });
        const btnCancel = document.getElementById('btnExportCancel');
        try {
            // 导出按逻辑像素渲染(不乘 devicePixelRatio),保证导出分辨率与该选项/“原图尺寸”一致
            this.uiDprOverride = 1;
            this._exportAbort = false;
            if (btnCancel) btnCancel.style.display = '';
            this.setStatus(`正在导出 ${jobs.length} 张…`);
            let okCount = 0, failCount = 0, aborted = false;
            for (let n = 0; n < jobs.length; n++) {
                if (this._exportAbort) { aborted = true; break; }
                const { im, puzzle } = jobs[n];
                this.image = im;
                this.invalidateStyleCaches();
                this.currentIdx = this.images.indexOf(im);
                // 每张图用各自预设:已自定义/记忆过的用其自身;当前主图用正在编辑的模板;其余未设置的用各自默认边框(不跟随第一张)
                const srcTpl = jobs[n].useBase ? baseTemplate : this.exportTemplateFor(im, this.images.indexOf(im), originalIdx, baseTemplate);
                // 导出专用深拷贝:后续 scaleElPix 的缩放不会污染正在编辑的活模板与已存的 customSettings 快照
                this.template = JSON.parse(JSON.stringify(srcTpl));
                this.normalizeTemplate();
                // 元素缩放基准:需要缩放元素时,先按 UI 默认尺寸试渲染一次,拿到"基准画布宽度"
                this.displayMax = undefined;
                delete this.exportScale;
                // 让调度器里已排队的预览帧先跑完:导出期间 uiDprOverride=1,预览帧与导出帧
                // 渲染到同一块 canvas,谁后跑谁定稿。不等它就导出会拿到"预览还没让位"的中间态。
                // 没有排队帧时不再主动多渲一帧:导出紧跟的全尺寸渲染会定稿,UI 尺寸试渲染只在
                // needProbe(元素缩放)时才有意义。
                if (this._renderRaf || this._renderDirty) await this.flushRender();
                try {
                    let beforeW = 0;
                    if (needProbe) {
                        await this._awaitFrameRender(puzzle);
                        beforeW = Math.max(1, this.dom.canvas.width || 1);
                    }
                    const targetPx = sizeOpt > 0 ? sizeOpt : Math.max(1, im.w || 1, im.h || 1);
                    this.displayMax = targetPx;
                    // 选了大尺寸选项时交出目标长边,由引擎上采样到该值(小图也能导出到所选尺寸)
                    // 拼图版式坐标固定在 1000 单位,不给 exportScale 就停在 1000~3000px;
                    // “原图尺寸”对多图拼图没有单一来源,沿用拼图页签通道的 4000px。
                    if (sizeOpt > 0) this.exportScale = sizeOpt;
                    else if (puzzle) this.exportScale = 4000;
                    await new Promise(res => requestAnimationFrame(() => {
                        if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                        else window.__render(this, false);
                        res();
                    }));
                    const afterW = Math.max(1, this.dom.canvas.width || 1);
                    // 元素尺寸/锚点偏移的换算基准:试渲染宽度 × 本通道的 dpr 比例。
                    // 为什么必须补这个比例 —— 元素几何是以「设备像素」存的(engine.js drawLogoElements
                    // 在 ctx.restore() 之后按 canvas.width 口径绘制),而预览与导出的画布宽度差一个 dpr:
                    //   · 预览:engine setupCanvas 走 scale = uiScale * devicePixelRatio → canvas.width = _logW × dpr
                    //   · 导出:uiDprOverride=1 → canvas.width = _logW × 1
                    // 同一个 size 在两种画布上占图片的比例因此差 dpr 倍,不补就会让导出的 logo
                    // 正好大 dpr 倍(贴边的锚点 Logo 还会离边更远)。
                    // beforeW 是在导出通道里测的(dpr 恒 1),自己看不见这个差异,所以要单独求通道比例:
                    // 用第 1 张(用户正在看的那张)的真实画布宽度 uiMaxSave 与其试渲染宽度 beforeW 之比。
                    // 该比例同一会话内恒定(图层/卡片通道 = devicePixelRatio,相框通道 = 1),
                    // 之后每张沿用 —— 这样 beforeW 仍是**逐张**测的,保留了原作者"每张各自以默认预览
                    // 尺寸为基准"的口径(批量导出时各图长宽比不同,不能用第 1 张的宽度顶替)。
                    // DPR=1 或相框通道时 pathDpr = 1,行为与改动前完全一致。
                    if (needProbe) {
                        if (!(this._exportPathDpr > 0)) {
                            this._exportPathDpr = (uiMaxSave > 0) ? (uiMaxSave / beforeW) : 1;
                        }
                        const k = this.exportSizeScale(afterW, beforeW, this._exportPathDpr);
                        // 元素坐标为基准画布像素:导出画布变大时等比放大,避免缩到角落
                        // (this.template 是导出专用拷贝,副本随本循环丢弃,无需再按 1/k 还原)
                        if (!puzzle && k !== 1 && scaleElPix(this.template, k)) {
                            await this._awaitFrameRender();
                        }
                    }
                    this.displayMax = uiMaxSave;
                    let src = this.dom.canvas;
                    if (needsBg) {
                        const bg = document.createElement('canvas');
                        bg.width = src.width; bg.height = src.height;
                        const bgx = bg.getContext('2d');
                        bgx.fillStyle = '#ffffff';
                        bgx.fillRect(0, 0, bg.width, bg.height);
                        bgx.drawImage(src, 0, 0);
                        src = bg;
                    }
                    const enc = await this._encodeExportCanvas(src, mime, quality);
                    if (enc.bytes) { files[n].bytes = enc.bytes; files[n].data = null; }
                    else { files[n].data = enc.data || null; files[n].bytes = null; }
                } catch (e) {
                    files[n].data = null;
                    files[n].bytes = null;
                }
                // 目录模式多张时逐张写盘并及时释放内存,避免全部编码结果同时驻留
                if ((files[n].bytes || files[n].data) && loc.mode === 'dir' && jobs.length > 1) {
                    const wr = await window.qingframe.writeExportFiles({ location: loc, files: [files[n]] }) || {};
                    if (wr.ok) okCount++; else failCount++;
                    files[n].data = null;
                    files[n].bytes = null;
                } else if (!files[n].bytes && !files[n].data) {
                    failCount++;
                }
                this.showExportProgress(n, jobs.length, im.name);
            }
            // 剩余文件(单文件模式 / 目录模式仅一张)统一写出;已取消导出则丢弃未写盘的结果
            const pending = files.filter(f => !!(f.bytes || f.data));
            if (pending.length && !aborted) {
                const r = await window.qingframe.writeExportFiles({ location: loc, files: pending }) || {};
                okCount += r.ok || 0; failCount += r.fail || 0;
            }
            const m = aborted
                ? `已取消导出：完成 ${okCount}${failCount ? `，失败 ${failCount}` : ''}`
                : `导出完成：成功 ${okCount}${failCount ? `，失败 ${failCount}` : ''}${useBaseCount ? `（${useBaseCount} 张沿用当前设计）` : ''}`;
            this.setStatus(m);
            this.revealExport(loc, okCount, aborted);
        } finally {
            if (btnCancel) btnCancel.style.display = 'none';
            delete this.uiDprOverride;
            delete this.exportScale;
            this.currentIdx = originalIdx;
            this.image = this.images[this.currentIdx];
            this.invalidateStyleCaches();
            this.template = this.getTpl(this.image) || baseTemplate;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }

        if (this.image) this.scheduleRender(true);
        this.resetProgress();
        this.updateStatusBar();
    },

    // ── 九宫格切图:当前画布(含边框/水印/元素,所见即所得)按 n×n 切成 n² 张 ──
    gridSize() { return parseInt((document.getElementById('selGridSize') && document.getElementById('selGridSize').value) || '3', 10) || 3; },

    // 切图渲染长边:3000/4000/6000/原图(封顶 12000 防爆内存)
    gridRenderMax() {
        const el = document.getElementById('selGridRender');
        const v = (el && el.value) || '3000';
        if (v === 'original') {
            const im = this.image;
            const len = im && im.el ? Math.max(im.el.naturalWidth || 0, im.el.naturalHeight || 0) : 3000;
            return Math.max(3000, Math.min(len, 12000));
        }
        return Math.max(1000, Math.min(parseInt(v, 10) || 3000, 12000));
    },

    // 块间留白 px(每块四周白边,拼贴无缝)
    gridPad() { return parseInt((document.getElementById('slGridPad') && document.getElementById('slGridPad').value) || '0', 10) || 0; },

    // 分文件夹导出开关
    gridSubdir() { const cb = document.getElementById('cbGridSubdir'); return !!(cb && cb.checked); },

    // 渲染一帧切图用画布(长边由 gridRenderMax 决定;JPG 垫白底防透明区转黑)
    async _renderGridFrame() {
        const prevMax = this.displayMax, prevDpr = this.uiDprOverride;
        this.displayMax = this.gridRenderMax();
        this.uiDprOverride = 1;
        try {
            await this._awaitFrameRender();
            let src = this.dom.canvas;
            if (this.dom.selFormat.value === 'jpeg') {
                const bg = document.createElement('canvas');
                bg.width = src.width; bg.height = src.height;
                const bx = bg.getContext('2d');
                bx.fillStyle = '#ffffff'; bx.fillRect(0, 0, bg.width, bg.height);
                bx.drawImage(src, 0, 0);
                src = bg;
            }
            return src;
        } finally {
            if (prevMax === undefined) delete this.displayMax; else this.displayMax = prevMax;
            if (prevDpr === undefined) delete this.uiDprOverride; else this.uiDprOverride = prevDpr;
        }
    },

    // 把 src 切成 n×n,返回每块 canvas(行优先 1..n²;最后一行/列取剩余尺寸防漏缝;
    // pad>0 时每块四周加 pad px 白边,拼贴无缝)
    _sliceGrid(src, n, pad) {
        const cw = src.width, ch = src.height;
        const p = pad || 0;
        const out = [];
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                const x = Math.round(c * cw / n), y = Math.round(r * ch / n);
                const w = Math.round((c + 1) * cw / n) - x, h = Math.round((r + 1) * ch / n) - y;
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
                out.push(cv);
            }
        }
        return out;
    },

    _gridExt() { return (this.dom.selFormat.value === 'jpeg') ? 'jpg' : this.dom.selFormat.value; },

    // 按当前导出格式/质量把缓存切块转成可写盘文件
    // im:这些切块源自哪张照片(九宫格是同源裁切,EXIF 仍跟随它的主照片)
    _gridFiles(baseName, subdir, im) {
        const fmt = this.dom.selFormat.value;
        const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt] || 'image/jpeg';
        const quality = (fmt === 'jpeg' || fmt === 'webp') ? Math.min(1, Math.max(0.6, (parseInt(this.dom.slExportQuality.value, 10) || 92) / 100)) : 1;
        const ex = this._exportExifFor(im);
        return this._gridBlocks.map((cv, i) => Object.assign({
            data: cv.toDataURL(mime, quality).split(',')[1],
            filename: baseName + '_九宫格_' + (i + 1) + '.' + this._gridExt(),
            stem: baseName + '_九宫格_' + (i + 1),
            ext: this._gridExt(),
            subdir: subdir || ''
        }, ex));
    },

    // 预览:渲染一帧 → 切块 → 弹缩略图 modal(缓存供导出复用)
    async renderGridPreview() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        if (this._gridBusy) return;
        this._gridBusy = true;
        const n = this.gridSize();
        this.setStatus('正在渲染九宫格…');
        try {
            const src = await this._renderGridFrame();
            const blocks = this._sliceGrid(src, n, this.gridPad());
            const box = document.getElementById('gridPreviewGrid');
            if (!box) { return; }
            box.className = 'grid-preview-grid n' + n;
            box.innerHTML = '';
            const ext = this._gridExt();
            const baseName = (this.image.name || 'photo').replace(/\.[^.]+$/, '');
            blocks.forEach((cv, i) => {
                const cell = document.createElement('div');
                cell.className = 'grid-preview-cell';
                cell._cv = cv; cell._idx = i + 1;
                const img = document.createElement('img');
                img.src = cv.toDataURL('image/jpeg', 0.8);
                const cap = document.createElement('div');
                cap.className = 'grid-preview-cap';
                cap.textContent = '#' + (i + 1) + ' · ' + cv.width + '×' + cv.height + ' · 点击放大';
                cell.appendChild(img); cell.appendChild(cap);
                box.appendChild(cell);
            });
            const hint = document.getElementById('gridPreviewHint');
            if (hint) hint.textContent = '共 ' + blocks.length + ' 格 · 每格约 ' + blocks[0].width + '×' + blocks[0].height + 'px · 导出文件名 ' + baseName + '_九宫格_1..' + blocks.length + '.' + ext;
            this._gridBlocks = blocks;
            document.getElementById('gridPreviewModal').style.display = 'flex';
            this.setStatus('已生成九宫格预览,确认后导出');
        } catch (e) {
            console.warn('九宫格预览失败:', e);
            this.setStatus('九宫格预览失败');
        } finally { this._gridBusy = false; }
        this.resetProgress(); this.updateStatusBar();
    },

    hideGridPreview() {
        const m = document.getElementById('gridPreviewModal'); if (m) m.style.display = 'none';
        this._gridBlocks = null;
        if (this.image) this.scheduleRender(true);
        this.resetProgress(); this.updateStatusBar();
    },

    // 导出:单张(预览已生成则直接导出);胶片条 Ctrl/Shift 多选则批量每张切 n² 张
    async exportGridCrop() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        if (this._gridBusy) return;
        this._gridBusy = true;
        const targets = (this.selectedIdx && this.selectedIdx.length > 1) ? this.selectedIdx.slice() : [this.currentIdx];
        const n = this.gridSize();
        let offWrite = null;
        try {
            if (targets.length > 1) {
                this.setStatus('正在批量切图 0/' + targets.length + '…');
                const allFiles = [];
                const originalIdx = this.currentIdx;
                const baseTemplate = this.template;
                for (let k = 0; k < targets.length; k++) {
                    const idx = targets[k];
                    const im = this.images[idx];
                    if (!im) continue;
                    this.currentIdx = idx; this.image = im;
                    this.invalidateStyleCaches && this.invalidateStyleCaches();
                    const srcTpl = this.exportTemplateFor(im, idx, originalIdx, baseTemplate);
                    this.template = srcTpl ? JSON.parse(JSON.stringify(srcTpl)) : baseTemplate;
                    this.normalizeTemplate && this.normalizeTemplate();
                    this.showExportProgress(k, targets.length, im.name);
                    const src = await this._renderGridFrame();
                    const blocks = this._sliceGrid(src, n, this.gridPad());
                    this._gridBlocks = blocks;
                    const baseName = (im.name || ('photo' + (idx + 1))).replace(/\.[^.]+$/, '');
                    allFiles.push.apply(allFiles, this._gridFiles(baseName, this.gridSubdir() ? baseName : '', im));
                    this.setStatus('正在批量切图 ' + (k + 1) + '/' + targets.length + '…');
                }
                this.currentIdx = originalIdx; this.image = this.images[originalIdx];
                this.invalidateStyleCaches && this.invalidateStyleCaches();
                this.template = baseTemplate;
                this._gridBlocks = null;
                if (!allFiles.length) { this.setStatus('请先导入照片'); return; }
                const loc = await window.qingframe.pickExportLocation({ count: allFiles.length, hintName: '九宫格批量' });
                if (!loc || loc.canceled) { this.setStatus('已取消切图'); return; }
                {
                    const bar0 = document.getElementById('progressBar');
                    if (bar0) bar0.style.width = '2%';
                    this.progressWrap(true);
                    const label0 = document.getElementById('exportProgressText');
                    if (label0) { label0.style.display = ''; label0.textContent = '写盘 0/' + allFiles.length + ' · 九宫格'; }
                }
                offWrite = window.qingframe.onExportProgress((d) => {
                    const bar = document.getElementById('progressBar');
                    if (bar) bar.style.width = Math.round((d.done / d.total) * 100) + '%';
                    const label = document.getElementById('exportProgressText');
                    if (label) { label.style.display = ''; label.textContent = '写盘 ' + d.done + '/' + d.total + ' · 九宫格'; }
                    // 收到最后一张就摘监听。原先是在 invoke 的 .then 里摘,
                    // 而 send 与 invoke 的回复没有严格的先后保证 —— 实测进度条有时停在 8/9、89%。
                    if (d.done >= d.total && offWrite) { offWrite(); offWrite = null; }
                });
                const wr = await window.qingframe.writeExportFiles({ location: loc, files: allFiles }) || {};
                const total = allFiles.length;
                this.setStatus(wr.ok ? '批量九宫格完成:' + targets.filter(i => this.images[i]).length + '张×' + n * n + '=' + total + '张,成功 ' + wr.ok + (wr.fail ? ',失败 ' + wr.fail : '') + ' · 每块约 ' + Math.round(this.gridRenderMax() / n) + 'px' : '切图导出失败');
                return;
            }
            // 单张:预览已生成则用缓存,否则现渲染
            let blocks = this._gridBlocks;
            if (!blocks) {
                this.setStatus('正在渲染九宫格…');
                this.showExportProgress(0, 1, this.image.name);
                const src = await this._renderGridFrame();
                blocks = this._sliceGrid(src, n, this.gridPad());
                this._gridBlocks = blocks;
            }

            const baseName = (this.image.name || 'photo').replace(/\.[^.]+$/, '');
            const files = this._gridFiles(baseName, this.gridSubdir() ? baseName : '', this.image);
            const loc = await window.qingframe.pickExportLocation({ count: files.length, hintName: baseName + '_九宫格' });
            if (!loc || loc.canceled) { this.setStatus('已取消切图'); this.scheduleRender(true); return; }
            {
                const bar0 = document.getElementById('progressBar');
                if (bar0) bar0.style.width = '2%';
                this.progressWrap(true);
                const label0 = document.getElementById('exportProgressText');
                if (label0) { label0.style.display = ''; label0.textContent = '写盘 0/' + files.length + ' · 九宫格'; }
            }
            offWrite = window.qingframe.onExportProgress((d) => {
                const bar = document.getElementById('progressBar');
                if (bar) bar.style.width = Math.round((d.done / d.total) * 100) + '%';
                const label = document.getElementById('exportProgressText');
                if (label) { label.style.display = ''; label.textContent = '写盘 ' + d.done + '/' + d.total + ' · 九宫格'; }
                if (d.done >= d.total && offWrite) { offWrite(); offWrite = null; }
            });
            const wr = await window.qingframe.writeExportFiles({ location: loc, files }) || {};
            this.setStatus(wr.ok ? '九宫格切图完成:成功 ' + wr.ok + ' 张' + (wr.fail ? ',失败 ' + wr.fail : '') + ' · 每块约 ' + Math.round(this.gridRenderMax() / n) + 'px' : '切图导出失败');
            this.hideGridPreview();
        } catch (e) {
            console.warn('九宫格导出失败:', e, (e && e.stack || ''));
            this.setStatus('切图导出失败:' + (e && e.message || ''));
        } finally {
            this._gridBusy = false;
            // 收尾必须放在 finally:批量/单张各有 4 处提前 return(空结果、取消目录…),
            // 放在 try 之后会被全部绕过 —— 导出成功后状态栏仍留着「写盘 n/N」和取消按钮。
            if (offWrite) { offWrite(); offWrite = null; }
            this.resetProgress(); this.updateStatusBar();
            if (this.scheduleRender) this.scheduleRender(true);
        }
    },

    // 切图设置记忆:规格/渲染长边/留白/分文件夹 存 localStorage
    loadGridPrefs() {
        try {
            const raw = localStorage.getItem('qfs-grid-prefs');
            if (!raw) return;
            const p = JSON.parse(raw);
            const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
            const chk = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.checked = !!v; };
            set('selGridSize', p.size); set('selGridRender', p.render); set('slGridPad', p.pad); chk('cbGridSubdir', p.subdir);
            const lbl = document.getElementById('lblGridPad');
            if (lbl) lbl.textContent = (document.getElementById('slGridPad') && document.getElementById('slGridPad').value) || '0';
        } catch (e) { console.warn('loadGridPrefs:', e); }
    },

    saveGridPrefs() {
        try {
            const g = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
            const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : undefined; };
            localStorage.setItem('qfs-grid-prefs', JSON.stringify({ size: g('selGridSize'), render: g('selGridRender'), pad: g('slGridPad'), subdir: chk('cbGridSubdir') }));
        } catch (e) { console.warn('saveGridPrefs:', e); }
    },

    // ── 自动更新 UI:渲染层横幅处理(主进程 electron-updater 事件经 preload 推送) ──
    initUpdater() {
        const api = window.qingframe;
        if (!api || !api.onUpdaterEvent) return;
        this._updater = { state: 'idle' };
        this._updaterOff = api.onUpdaterEvent((ev) => this._onUpdaterEvent(ev));
        // 打包版主进程已延迟静默检查;这里再兜底一次,确保横幅就绪(仅 idle 时触发,防重复)
        setTimeout(() => {
            if (this._updater && this._updater.state === 'idle' && api.checkForUpdates) this.checkUpdates(true);
        }, 5000);
        // 更新内容详情按钮
        const nb = this.$ && this.$('btnUpdateNotes');
        if (nb) nb.addEventListener('click', () => this.showUpdateNotes());
        const nc = document.getElementById('updateNotesClose'), nk = document.getElementById('updateNotesOk');
        if (nc) nc.addEventListener('click', () => this.hideUpdateNotes());
        if (nk) nk.addEventListener('click', () => this.hideUpdateNotes());
        const nm = document.getElementById('updateNotesModal');
        if (nm) nm.addEventListener('click', (e) => { if (e.target === nm) this.hideUpdateNotes(); });
    },
    showUpdateNotes() {
        const m = document.getElementById('updateNotesModal'), b = document.getElementById('updateNotesBody');
        if (!m || !b) return;
        const info = this._updateInfo;
        let note = (info && (info.releaseNotes || info.releaseNotesString)) || '';
        if (Array.isArray(note)) {
            const last = note[note.length - 1];
            note = last && (last.note || last.body || '');
        }
        const html = this.mdToHtml(String(note || '').trim());
        b.innerHTML = html || '<div class="rn-line">暂无更新说明</div>';
        m.style.display = 'flex';
    },
    hideUpdateNotes() {
        const m = document.getElementById('updateNotesModal');
        if (m) m.style.display = 'none';
    },
    _onUpdaterEvent(ev) {
        if (!this._updater) this._updater = {};
        this._updater.state = ev.type;
        const $ = this.$;
        const b = $('updateBanner'), t = $('updateBannerText');
        if (!b || !t) return;
        const bar = $('updateProgressBar'), barWrap = $('updateProgressWrap'), act = $('btnUpdateAction');
        if (ev.type === 'available') {
            this._updateInfo = { version: ev.version, releaseNotes: ev.releaseNotes };
            t.textContent = '发现新版本 v' + (ev.version || '') + '，点击更新';
            if (barWrap) barWrap.style.display = 'none';
            if (act) { act.textContent = '立即更新'; act.disabled = false; }
            const nb = document.getElementById('btnUpdateNotes');
            if (nb) nb.style.display = '';
            b.style.display = 'flex';
        } else if (ev.type === 'not-available') {
            if (this._checking) { this.setStatus('已是最新版本'); this._checking = false; }
        } else if (ev.type === 'progress') {
            const p = Math.max(0, Math.min(100, Math.round((ev.percent || 0) * 10) / 10));
            if (barWrap) barWrap.style.display = '';
            if (bar) bar.style.width = p + '%';
            t.textContent = '正在下载更新 ' + p + '%';
            if (act) { act.textContent = '下载中…'; act.disabled = true; }
            b.style.display = 'flex';
        } else if (ev.type === 'downloaded') {
            t.textContent = '更新已下载完成，重启即可生效';
            if (barWrap) barWrap.style.display = 'none';
            if (act) { act.textContent = '立即重启'; act.disabled = false; }
            b.style.display = 'flex';
        } else if (ev.type === 'error') {
            t.textContent = '检查更新失败：' + (ev.message || '网络异常');
            if (barWrap) barWrap.style.display = 'none';
            if (act) { act.textContent = '重试'; act.disabled = false; }
            b.style.display = 'flex';
        } else {
            const nb = document.getElementById('btnUpdateNotes');
            if (nb) nb.style.display = 'none';
        }
    },
    async checkUpdates(silent) {
        const api = window.qingframe;
        if (!api || !api.checkForUpdates) { this.setStatus('当前为开发模式，不检查更新'); return; }
        this._checking = true;
        const r = await api.checkForUpdates().catch(() => ({ ok: false, message: '检查失败' }));
        this._checking = false;
        if (!silent && r && !r.ok) this.setStatus('检查更新失败：' + ((r && r.message) || '网络异常'));
    },
    updateAction() {
        const st = this._updater && this._updater.state;
        const api = window.qingframe;
        if (!api) return;
        if (st === 'downloaded') { if (api.quitAndInstall) api.quitAndInstall(); return; }
        // available / error / idle → 开始下载(或重试);主进程 downloadUpdate 会推送 progress 事件
        if (api.startUpdateDownload) api.startUpdateDownload();
        else this.checkUpdates(true);
    },
    hideUpdateBanner() {
        const b = document.getElementById('updateBanner');
        if (b) b.style.display = 'none';
    },

    // ── 诊断日志:环形缓冲记录操作/异常,一键导出(同 yt-dlp --verbose 思路) ──
    initDiag() {
        this._diagBuf = [];
        this.diagLog = (m) => {
            if (!this._diagBuf) this._diagBuf = [];
            this._diagBuf.push(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + String(m));
            if (this._diagBuf.length > 200) this._diagBuf = this._diagBuf.slice(-200);
        };
        window.addEventListener('error', (e) => { this.diagLog && this.diagLog('[异常] ' + (e && e.message)); });
        window.addEventListener('unhandledrejection', (e) => { this.diagLog && this.diagLog('[Promise异常] ' + ((e && e.reason && e.reason.message) || e.reason)); });
        const bd = document.getElementById('btnExportDiag');
        if (bd) bd.addEventListener('click', () => this.exportDiagnostics());
        const bc = document.getElementById('btnCopyDiag');
        if (bc) bc.addEventListener('click', () => this.copyDiagnostics());
        const bo = document.getElementById('btnOpenDataDir');
        if (bo) bo.addEventListener('click', () => this.openDataDir());
    },
    async buildDiagnosticsText() {
        const api = window.qingframe;
        if (!api || !api.getAppInfo) return '';
        let info = {};
        try { info = (await api.getAppInfo()) || {}; } catch (e) { this.diagLog('[异常] 读取应用信息失败: ' + e.message); }
        const packageType = !info.packaged ? '开发模式' : (info.portable ? '便携版' : '安装版');
        const lines = [];
        lines.push('清框影 诊断日志');
        lines.push('导出时间: ' + new Date().toLocaleString('zh-CN', { hour12: false }));
        lines.push('版本: ' + (info.version || '未知'));
        lines.push('Electron: ' + (info.electron || '') + ' · Chrome: ' + (info.chrome || '') + ' · Node: ' + (info.node || ''));
        lines.push('平台: ' + (info.platform || '') + ' ' + (info.arch || '') + ' (' + packageType + ')');
        lines.push('userData: ' + (info.userData || ''));
        lines.push('appPath: ' + (info.appPath || ''));
        lines.push('');
        lines.push('── 操作日志(最近 ' + ((this._diagBuf || []).length) + ' 条) ──');
        (this._diagBuf || []).forEach(l => lines.push(l));
        return lines.join('\n');
    },
    async exportDiagnostics() {
        const api = window.qingframe;
        if (!api || !api.getAppInfo) { this.setStatus('开发模式下不可导出诊断日志'); return; }
        this.diagLog('导出诊断日志');
        const text = await this.buildDiagnosticsText();
        // 不用 catch 吞错:把 invoke 的真实失败原因透传出来(常见:主进程没重启,handler 未注册)
        let r;
        try { r = await api.saveDiagnosticsFile(text); }
        catch (e) { r = { ok: false, message: (e && e.message) || '保存失败' }; }
        if (r && r.ok) this.setStatus('诊断日志已保存: ' + (r.path || ''));
        else if (r && r.canceled) this.setStatus('已取消导出诊断日志');
        else this.setStatus('诊断日志导出失败: ' + ((r && r.message) || '未知原因'));
    },
    async copyDiagnostics() {
        const api = window.qingframe;
        if (!api || !api.getAppInfo) { this.setStatus('开发模式下不可复制诊断信息'); return; }
        this.diagLog('复制诊断信息');
        const text = await this.buildDiagnosticsText();
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            this.setStatus('诊断信息已复制到剪贴板');
        } catch (e) {
            this.setStatus('复制失败: ' + ((e && e.message) || '剪贴板不可用'));
        }
    },
    async openDataDir() {
        const api = window.qingframe;
        if (!api || !api.openDataDir) { this.setStatus('当前无法打开数据目录'); return; }
        const r = await api.openDataDir().catch(() => ({ ok: false }));
        if (!r || !r.ok) this.setStatus('打开数据目录失败: ' + ((r && r.message) || '未知原因'));
    },

    // 导出时元素尺寸/锚点偏移要乘的倍数。抽成纯函数便于单测(见 tools/test-engine-invariants.js ⑥):
    //   beforeW  = 该图在导出通道(uiDprOverride=1)下按默认显示尺寸试渲染的画布宽度
    //   pathDpr  = 预览画布宽度 / 同模板试渲染宽度 —— 同一会话内恒定的通道比例(图层/卡片 = dpr,相框 = 1)
    // 返回 1 表示"预览与导出口径一致,不必再渲一次"。
    exportSizeScale(afterW, beforeW, pathDpr) {
        const p = (typeof pathDpr === 'number' && pathDpr > 0) ? pathDpr : 1;
        return afterW / Math.max(1, beforeW * p);
    },

    // 导出试渲染是否必要:口径与上面的 scaleElPix 完全一致。
    // 没有这些元素时 beforeW/k/pathDpr 都不参与任何绘制,整批导出可跳过 UI 尺寸试渲染。
    _hasScalableElements(tpl) {
        if (!tpl) return false;
        if ((tpl.logoElements || []).length) return true;
        if (((tpl.decorConfig && tpl.decorConfig.stickers) || []).length) return true;
        return (((tpl.decorConfig && tpl.decorConfig.textLines) || [])
            .some(l => l && l.align === 'free'));
    },

    // 画布编码:JPEG 走异步 toBlob + 字节直传(实测与 toDataURL 逐字节相同,
    // 见 OPTIMIZATIONS.md 第六节),省掉 base64 的 +33% 体积与一趟编解码,也不长时间占住渲染线程。
    // PNG 的 toBlob 在 Chromium 里反而更慢,保持原来的同步路径。
    async _encodeExportCanvas(cv, mime, quality) {
        if (mime === 'image/jpeg' && typeof cv.toBlob === 'function') {
            try {
                const blob = await new Promise(res => cv.toBlob(res, mime, quality));
                if (blob && blob.size > 0) return { bytes: new Uint8Array(await blob.arrayBuffer()) };
            } catch (e) { /* 回退到同步编码 */ }
        }
        return { data: cv.toDataURL(mime, quality).split(',')[1] };
    },

    // 导出文件名:按图片原有名称命名;同一名称重复时,首张保留原名,后续追加 _1、_2…
    dedupeExportNames(files) {
        const counts = new Map();
        for (const f of files) counts.set(f.stem, (counts.get(f.stem) || 0) + 1);
        const emitted = new Map();
        files.forEach(f => {
            const total = counts.get(f.stem);
            const idx = emitted.get(f.stem) || 0;
            emitted.set(f.stem, idx + 1);
            f.filename = (total === 1 || idx === 0) ? `${f.stem}.${f.ext}` : `${f.stem}_${idx}.${f.ext}`;
        });
        return files;
    },

    // 每张照片导出用哪个模板:有每图模板用其自身(单一存取口,Map 与 customSettings 恒同一对象);
    // 否则当前主图(ownerIdx,导出开始时的图)用 liveTemplate,其余用默认空模板
    exportTemplateFor(im, idx, ownerIdx, liveTemplate) {
        return this.getTpl(im) || (idx === ownerIdx ? liveTemplate : this.defaultTemplate());
    },

    // 导出进度:进度条 + 底部“第 n / N 张”标签
    showExportProgress(n, total, name) {
        const pct = Math.round(((n + 1) / total) * 100);
        const bar = document.getElementById('progressBar');
        if (bar) bar.style.width = pct + '%';
        this.progressWrap(true);
        const label = document.getElementById('exportProgressText');
        if (label) { label.style.display = ''; label.textContent = `导出中 ${n + 1}/${total} · ${pct}% · ${String(name || '').replace(/\.[^.]+$/, '')}`; }
    },
    // 进度条容器:空闲时整条隐藏。此前它常驻一条 120×6 的空轨道,像状态栏里多了个坏滑块。
    // 必须写显式 display 值:不能写 ''(清掉内联样式会回落到 CSS 的 display:none,进度条就永远不出来了)。
    // on 时递增序号,供 resetProgress 判断"这 800ms 里有没有新导出接管"。
    progressWrap(on) {
        const wrap = document.querySelector('.progress-wrap');
        if (!wrap) return;
        if (on) { this._progressSeq = (this._progressSeq || 0) + 1; wrap.style.display = 'block'; }
        else wrap.style.display = 'none';
    },
    // 导出完成后在资源管理器中定位产物:单文件选中该文件,目录模式打开目录
    revealExport(loc, okCount, aborted) {
        const api = window.qingframe;
        if (!api || !api.showItemInFolder) return;
        if (aborted || !okCount) return;
        const p = loc && (loc.mode === 'dir' ? loc.dir : loc.path);
        if (!p) return;
        api.showItemInFolder(p).then(r => {
            if (!(r && r.ok)) this.diagLog && this.diagLog('[提示] 打开导出位置失败: ' + ((r && r.message) || '路径不可用'));
        }).catch(() => {});
    },
    // 更新内容 markdown 轻渲染(先转义防注入,再处理标题/列表/加粗/代码)
    mdToHtml(text) {
        const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const lines = String(text || '').split(/\r?\n/);
        const out = [];
        let inList = false;
        const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
        for (const raw of lines) {
            const line = esc(raw);
            const h = line.match(/^(#{1,4})\s+(.*)/);
            if (h) { closeList(); out.push(`<div class="rn-h">${h[2]}</div>`); continue; }
            const li = line.match(/^[-*•]\s+(.*)/);
            if (li) {
                if (!inList) { out.push('<ul class="rn-list">'); inList = true; }
                out.push(`<li>${li[1]}</li>`); continue;
            }
            if (!line.trim()) { closeList(); continue; }
            closeList();
            out.push(`<div class="rn-line">${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')}</div>`);
        }
        closeList();
        return out.join('');
    },

    // 导出尺寸提示:所选档位超过相框能给出的最大尺寸时,提醒用户实际输出会小于所选值。
    //
    // 背景缺陷:engine-styles.js 的相框路径用 finalScale = Math.min(1, displayMax/长边) 封顶,
    // 根本不读 app.exportScale(而 NONE 路径读)。于是"选 4096/8192 + 用相框样式"拿不到所选尺寸 ——
    // 小图尤其明显(实测 1200px 照片选 4096 只出 1320px)。修它要动边框渲染主路径,
    // 而 AGENTS.md 规定「边框相关功能保持原样」,故不在渲染层动刀,改为把静默失望变成已知信息。
    //
    // 为什么只报"约 XXXX px"、不报精确值 —— 这里踩过一次坑,值得记下:
    // 我最初按 scaledSize 复刻了一份"照片长边 + 边框"当作上限,结果对 POLAROID_HAND 报错数。
    // 原因是 styleDims 里各样式取边框的方式根本不统一:多数样式用 scaledSize(...) 的返回值,
    // 但 POLAROID_HAND 这类是"比例驱动",直接写死 border = max(30, iw * 0.05),压根不读 photoFrameBorderSize。
    // 也就是说精确上限必须走 styleDims 那 63 个分支,而在 UI 层复刻一份必然随引擎演进而说错话 ——
    // 说错数字比不说更糟(用户会拿它当依据去定印刷尺寸)。
    //
    // 现在的做法:只陈述一定为真的事实,不猜具体数字。
    //   · 照片长边 L:相框的成品长边一定 ≥ L(加边框只会更大),所以能拿到 sizeOpt 当且仅当 sizeOpt ≥ L
    //   · 于是 sizeOpt > L ⟹ 一定拿不到 sizeOpt,这条推论与任何样式的边框算法无关,永不为错
    // 代价是对「刚好差一点够到」的档位会漏报(宁可漏报,不可报错)。
    updateExportSizeNote() {
        const note = this.dom.exportSizeNote;
        if (!note) return;
        const hide = () => {
            // 这是每次 input 都会走到的路径(经 onSettingChanged):已经是隐藏且无文字时别再写 DOM
            if (note.style.display === 'none' && !note.textContent) return;
            note.style.display = 'none';
            note.textContent = '';
        };
        const sizeOpt = parseInt(this.dom.selExportSize.value, 10) || 0;
        const tpl = this.template;
        // 原图直出(NONE)读 exportScale,行为与所选值一致,无需提示
        if (sizeOpt <= 0 || !tpl) return hide();
        if (String(tpl.photoFrameStyle || 'NONE').toUpperCase() === 'NONE') return hide();
        // 拼图走 app-puzzle.js 自己的导出通道(恒 4000px),与本表无关,别去打扰用户
        if (tpl.puzzle && tpl.puzzle.enabled) return hide();
        const el = this.image && this.image.el;
        if (!el) return hide();
        const photoLong = Math.max(el.naturalWidth || 0, el.naturalHeight || 0);
        // 照片长边都够不着所选档位 → 必然拿不到(sizeOpt > photoLong 是充分条件,与样式无关)
        if (sizeOpt <= photoLong) return hide();
        note.style.display = '';
        note.textContent = `相框按原始分辨率导出、不放大,实际长边不会达到 ${sizeOpt}px`;
        note.title = `所选 ${sizeOpt}px 大于照片原始长边 ${photoLong}px。相框成品长边只会在此基础上再加边框,` +
                     `因此无法上采样到 ${sizeOpt}px。照片足够大时该档位可正常输出。`;
    },

    resetProgress() {
        const bar = document.getElementById('progressBar');
        const seq = this._progressSeq || 0;
        // 条先缩回 0(.2s 过渡),再整条收起;800ms 内若有新导出接管(序号变了),则把手让开
        if (bar) setTimeout(() => {
            if ((this._progressSeq || 0) !== seq) return;
            bar.style.width = '0';
            this.progressWrap(false);
        }, 800);
        const btnCancel = document.getElementById('btnExportCancel');
        if (btnCancel) btnCancel.style.display = 'none';
        const label = document.getElementById('exportProgressText');
        if (label) label.style.display = 'none';
        delete this._exportAbort;
    }
});
