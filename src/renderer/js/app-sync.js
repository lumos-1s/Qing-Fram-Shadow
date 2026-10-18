// 同步模块：边框同步 —— 两条入口共用同一核心（从 app.js / app-templates.js 拆出）
//   · 右键菜单「同步边框」/ Ctrl 单张场景：syncBorderTo —— 单张，不弹覆盖确认
//   · 「同步到选中」按钮 / Ctrl+D 批量：syncToSelected / applyBorderToSelected —— 覆盖已有边框时先确认
//
// 同步语义（唯一权威定义；改行为必须改这里并同步更新上方入口与状态文案）：
//   · 带过去（源图 → 目标图）：全部边框与参数 + logoElements（多图统一元素布局用）；
//   · 保留目标图自己的：贴纸(stickers)、自由文字(textLines)、拼图(puzzle) ——
//     边框之外的各图独立内容不参与同步，也不会被清掉；
//   · 相机数据三级规则：目标图自有 EXIF → 用它（清掉历史同步写入的手动值）；无 EXIF 但
//     手动填过 → 保留目标图自己的；都无 → 沿用源图的有效相机数据；
//   · 写入一律走 setTpl 单一存取口（Map 与 customSettings 恒为同一对象，见 app-state.js）。
window.App = Object.assign(window.App || {}, {
    // 核心：把当前编辑中的模板复制到 idxs 指定的一批目标图。返回成功张数；用户取消返回 -1。
    // opts.confirm=true 时，若目标里已有边框（会被覆盖）则先弹一次确认 —— 防误同步覆盖手工成果。
    _syncTplToTargets(idxs, opts) {
        if (!this.image || !this.template) return 0;
        // 去重、过滤非法索引；当前编辑图就是"源"，从目标里剔除
        const list = Array.from(new Set(
            (idxs || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length)
        )).filter(i => i !== this.currentIdx);
        if (!list.length) return 0;
        const applied = this.cloneTemplate();
        if (!applied) return 0;
        delete applied.puzzle;
        const overwrite = list.filter(i => !!this.getTpl(this.images[i]));
        if (opts && opts.confirm && overwrite.length && !window.confirm(
            `将把当前边框同步到 ${list.length} 张照片，其中 ${overwrite.length} 张已有边框会被覆盖。\n\n继续?`)) {
            this.setStatus('已取消同步');
            return -1;
        }
        let count = 0;
        for (const i of list) {
            const im = this.images[i];
            if (!im) continue;
            const tgtSnap = JSON.parse(JSON.stringify(applied));
            const prev = this.getTpl(im);
            // 贴纸/自由文字/拼图：源图的不带过去（沿用旧口径），目标图自己的保留 ——
            // 这三类随各图独立记忆，同步只动边框本身
            if (tgtSnap.decorConfig) { delete tgtSnap.decorConfig.stickers; delete tgtSnap.decorConfig.textLines; }
            if (prev) {
                if (prev.puzzle) tgtSnap.puzzle = JSON.parse(JSON.stringify(prev.puzzle));
                const pk = prev.decorConfig, tk = tgtSnap.decorConfig;
                if (pk && (pk.stickers || pk.textLines)) {
                    tgtSnap.decorConfig = tk || {};
                    if (pk.stickers) tgtSnap.decorConfig.stickers = JSON.parse(JSON.stringify(pk.stickers));
                    if (pk.textLines) tgtSnap.decorConfig.textLines = JSON.parse(JSON.stringify(pk.textLines));
                }
            }
            // 相机数据：同步只动边框。目标图自己能识别 EXIF → 用自己的（清除历史同步/兜底写入的手动参数）；
            // 没有 EXIF 但手动填过 → 保留该图自己的手动参数；都无 → 沿用当前图的有效相机数据
            const prevManual = (prev && prev.manualExif && typeof prev.manualExif === 'object') ? prev.manualExif : null;
            const ownExif = (im.exif && typeof im.exif === 'object') ? im.exif : {};
            const hasOwn = ['make', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => String(ownExif[k] || '').trim() !== '');
            if (hasOwn) {
                delete tgtSnap.manualExif;
            } else if (prevManual) {
                delete tgtSnap.manualExif;
                if (Object.keys(prevManual).length) tgtSnap.manualExif = JSON.parse(JSON.stringify(prevManual));
            } else {
                const srcManual = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
                const srcAuto = (this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
                const base = {
                    brand: String(srcManual.brand || '').trim() || String(srcAuto.make || '').trim(),
                    model: String(srcManual.model || '').trim() || String(srcAuto.model || '').trim(),
                    focal: String(srcManual.focal || '').trim() || String(srcAuto.focal || '').trim(),
                    aperture: String(srcManual.aperture || '').trim() || String(srcAuto.aperture || '').trim(),
                    iso: String(srcManual.iso || '').trim() || String(srcAuto.iso || '').trim(),
                    shutter: String(srcManual.shutter || '').trim() || String(srcAuto.shutter || '').trim()
                };
                const hasCam = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => base[k] !== '');
                delete tgtSnap.manualExif;
                if (hasCam) tgtSnap.manualExif = base;
            }
            this.setTpl(im, tgtSnap);
            this.queueThumb(im);
            count++;
        }
        if (count && typeof this.scheduleDraft === 'function') this.scheduleDraft();
        return count;
    },

    // 单张同步：右键菜单「同步边框」（落在单张缩略图上）。指向明确，不弹覆盖确认
    syncBorderTo(i) {
        const tgt = this.images[i];
        if (!tgt || !this.image) return;
        const n = this._syncTplToTargets([i], { confirm: false });
        if (n > 0) this.setStatus('已将当前边框同步到「' + tgt.name + '」');
    },

    // 批量同步：「同步到选中」按钮。目标 = 全部选中 − 当前编辑图
    // （Ctrl+A 全选时含第 1 张；旧写法 selectedIdx.slice(1) 会固定漏掉下标最小的那张）
    syncToSelected() {
        if (this.selectedIdx.length <= 1) { this.setStatus('请先在胶片条中多选需要同步的照片(Ctrl/Shift+点击)'); return; }
        const n = this._syncTplToTargets(this.selectedIdx, { confirm: true });
        if (n < 0) return; // 用户在覆盖确认里取消
        this.setStatus(n
            ? `已将当前边框同步到 ${n} 张照片（含 Logo；贴纸/文字/拼图保留各图自有）`
            : '没有需要同步的选中照片');
    }
});
