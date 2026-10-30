// 草稿自动保存:把当前会话(照片路径/模板/每图模板)写入 localStorage,崩溃后启动可恢复
window.App = Object.assign(window.App || {}, {
    _draftKey: 'qfs_draft_v1',
    _draftTimer: null,
    _draftDirty: false,
    _draftRev: 0,
    _draftSaving: false,

    initDraft() {
        if (typeof localStorage === 'undefined') return;
        this.scheduleDraft();
        window.addEventListener('pagehide', () => this.saveDraftNow());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveDraftNow(); });
        // 30 秒兜底只在有变更时写:旧写法无条件写,闲置时也反复同步落盘(leveldb flush),
        // 大图会话放久后每次写都是一次整库落盘,是"放着没动回来就卡"的贡献者之一
        setInterval(() => { if (this._draftDirty) this.saveDraftNow(); }, 30000);
        this.checkDraftRestore();
    },

    // 启动时仅提示"可恢复上次会话",不自动恢复(避免误以为出现默认图片)
    checkDraftRestore() {
        let draft = null;
        try {
            const raw = localStorage.getItem(this._draftKey);
            if (raw) draft = JSON.parse(raw);
        } catch (e) { draft = null; }
        const btn = document.getElementById('btnRestoreDraft');
        const hasRecoverable = !!(draft && Array.isArray(draft.images) && draft.images.length &&
            draft.images.some(m => m && m.path));
        if (btn) {
            const showBtn = hasRecoverable && !(this.images && this.images.length);
            btn.style.display = showBtn ? 'inline-block' : 'none';
            if (showBtn) btn.onclick = () => this.restoreDraft();
        }
    },

    scheduleDraft() {
        this._draftDirty = true;
        this._draftRev = (this._draftRev || 0) + 1;
        if (this._draftTimer) return;
        this._draftTimer = setTimeout(() => { this._draftTimer = null; this.saveDraftNow(); }, 1500);
    },

    // 剥离草稿树上超长的 data: 内嵌串(模板可携带元素图/自定义图标),返回剥离个数
    _stripDraftData(node) {
        if (!node || typeof node !== 'object') return 0;
        let n = 0;
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (typeof v === 'string') {
                if (v.length > 65536 && v.startsWith('data:')) { node[k] = ''; n++; }
            } else if (v && typeof v === 'object') {
                n += this._stripDraftData(v);
            }
        }
        return n;
    },

    saveDraftNow() {
        try {
            if (!this.images || !this.images.length) return;
            // 内置示例照片没有磁盘路径,不能写进草稿:否则下次启动恢复时会被跳过,
            // 但它仍占着 currentIdx,真实照片的当前张就会错位。只存可再次加载的照片。
            const savable = [];
            let cur = 0;
            this.images.forEach((im, i) => {
                if (!im.path) return;
                if (i === this.currentIdx) cur = savable.length;
                savable.push(im);
            });
            if (!savable.length) return;
            const curIm = savable[cur] || savable[0];
            if (curIm !== savable[cur]) cur = 0;
            // 当前图可保存时,this.template 才是最新编辑状态(可能还没写回每图模板);
            // 当前图是内置示例时,退回第一张真实照片自己的模板,避免把示例模板当默认值。
            const srcTpl = (this.image && this.image.path) ? this.template : (this.getTpl(curIm) || this.template);
            const tpl = srcTpl ? JSON.parse(JSON.stringify(srcTpl)) : null;
            const imageTemplates = [];
            for (const im of savable) {
                const saved = this.getTpl(im);
                if (saved) imageTemplates.push({ path: im.path, tpl: JSON.parse(JSON.stringify(saved)) });
            }
            const draft = {
                v: 1,
                savedAt: Date.now(),
                // 调色只存 7 个数字，重启后在新解码的底图上重放即可 —— 与裁切不同，
                // 它不需要重新编码，所以是真正无损可持久的
                images: savable.map(im => ({
                    name: im.name, path: im.path, w: im.w, h: im.h,
                    grade: (im.grade && !this.isNeutralGrade(im.grade)) ? im.grade : undefined
                })),
                currentIdx: cur,
                template: tpl,
                imageTemplates
            };
            this._persistDraft(draft, this._draftRev || 0);
        } catch (e) { /* 忽略草稿写入错误 */ }
    },

    // 大 data: 图片交给主进程落盘,草稿只存 qfasset: 引用;主进程不可用时退回旧策略
    // (剥掉大串),至少保住路径/模板结构,不再因为 64KB/8MB 阈值整份放弃。
    async _persistDraft(draft, rev) {
        if (this._draftSaving) { this._draftDirty = true; return; }
        this._draftSaving = true;
        let raw = null;
        try {
            if (window.qingframe && typeof window.qingframe.externalizeDraft === 'function') {
                try {
                    const r = await window.qingframe.externalizeDraft(draft);
                    if (r && r.ok && r.json) raw = r.json;
                    if (r && r.stats && r.stats.dropped && this.diagLog) {
                        this.diagLog(`草稿附件有 ${r.stats.dropped} 个超过上限，已跳过`);
                    }
                } catch (e) { /* 主进程失败时走下面的回退 */ }
            }
            if (!raw) {
                const stripped = JSON.parse(JSON.stringify(draft));
                this._stripDraftData(stripped);
                raw = JSON.stringify(stripped);
            }
            if (raw.length > 8 * 1024 * 1024) {
                if (this.diagLog) this.diagLog(`草稿体积 ${(raw.length / 1048576).toFixed(1)}MB 超过上限，跳过本次保存`);
                this._draftDirty = false;
                return;
            }
            localStorage.setItem(this._draftKey, raw);
            // 保存期间又有编辑(rev 变了)时不能清 dirty,让下一轮继续写。
            if ((this._draftRev || 0) === rev) this._draftDirty = false;
        } catch (e) {
            // 配额不足时不要每 1.5 秒重试同一份超限草稿;放弃本轮,等用户下次编辑再试。
            this._draftDirty = false;
            if (this.diagLog) this.diagLog('草稿写入失败: ' + (e && e.message || e));
        } finally {
            this._draftSaving = false;
            if (this._draftDirty) this.scheduleDraft();
        }
    },

    clearDraft() {
        try { localStorage.removeItem(this._draftKey); } catch (e) { /* 忽略 */ }
        try {
            if (window.qingframe && typeof window.qingframe.clearDraftAssets === 'function') {
                window.qingframe.clearDraftAssets().catch(() => {});
            }
        } catch (e) { /* 忽略 */ }
    },

    async restoreDraft() {
        let draft = null;
        try {
            const raw = localStorage.getItem(this._draftKey);
            if (raw) draft = JSON.parse(raw);
        } catch (e) { return; }
        if (this._restoringDraft) return; // 连点保护:恢复是异步的,重复进入会并发重建 images
        if (!draft || !Array.isArray(draft.images) || !draft.images.length) return;
        if (this.images && this.images.length) return; // 已有手动会话则不覆盖
        this._restoringDraft = true;
        const restoreBtn = document.getElementById('btnRestoreDraft');
        const restoreLabel = restoreBtn ? restoreBtn.textContent : '';
        if (restoreBtn) { restoreBtn.disabled = true; restoreBtn.textContent = '恢复中…'; }
        // 进度条:1 步读附件 + N 张照片。大图会话每张都要 EXIF + 解码 + 可能的方向重绘,
        // 全程静默的话按钮点了像坏了,所以按张数给反馈。
        const metas = (draft.images || []).filter(m => m && m.path);
        const total = metas.length + 1;
        // 让出一个宏任务,让进度条有机会重绘(解码/方向重绘是同步的,不让出会跳帧)。
        // 只在窗口可见时让出:隐藏窗口下 rAF / timer 会被节流到约 1 次/秒,
        // 每张都等会把恢复拖慢几十倍(实测 3 张从 0.2s 变成 3s)。
        const yieldPaint = () => new Promise(r => {
            if (document.visibilityState && document.visibilityState !== 'visible') { r(); return; }
            setTimeout(r, 0);
        });
        try {
            this.showImportProgress(total, '正在恢复');
            this.setImportProgress(0, total, '读取草稿');
            // 草稿里的 qfasset: 引用还原成 data:,老版本草稿没有引用时原样返回
            if (window.qingframe && typeof window.qingframe.hydrateDraft === 'function') {
                try {
                    const hr = await window.qingframe.hydrateDraft(draft);
                    if (hr && hr.ok && hr.draft) draft = hr.draft;
                } catch (e) { /* 附件缺失时继续用剩余数据恢复 */ }
            }
            this.setImportProgress(1, total, null);
            await yieldPaint();
            const tplByPath = new Map();
            (draft.imageTemplates || []).forEach(entry => { if (entry && entry.path) tplByPath.set(entry.path, entry.tpl); });
            const restored = [];
            for (let i = 0; i < metas.length; i++) {
                const meta = metas[i];
                const im = await this.imageFromMeta(meta, tplByPath.get(meta.path));
                if (im) restored.push(im);
                this.setImportProgress(i + 2, total, meta.name || String(meta.path).split(/[\\/]/).pop());
                // 让出一帧:解码/方向重绘是同步的,不插空档进度条不会重绘
                await yieldPaint();
            }
            if (!restored.length) { this.finishImportProgress('没有可恢复的照片'); return; }
            this.images = restored;
            this.selectedIdx = [];
            this.batchSel = [];
            const ci = Math.min(Math.max(0, draft.currentIdx || 0), restored.length - 1);
            this.currentIdx = ci;
            this.image = restored[ci];
            const draftTpl = this.getTpl(this.image);
            this.template = draftTpl || (draft.template ? JSON.parse(JSON.stringify(draft.template)) : this.defaultTemplate());
            this.normalizeTemplate();
            this.invalidateStyleCaches();
            this.buildThumbnails();
            this.afterImageSelect();
            this.refreshUI();
            this.scheduleRender(true);
            const btn = document.getElementById('btnRestoreDraft');
            if (btn) btn.style.display = 'none';
            this.scheduleDraft();
            this.finishImportProgress('恢复完成');
            this.setStatus('已恢复上次会话草稿（' + restored.length + ' 张照片）');
        } catch (e) {
            this.finishImportProgress('恢复未完成');
            /* 恢复失败不阻塞启动 */
        } finally {
            this._restoringDraft = false;
            const btn = document.getElementById('btnRestoreDraft');
            if (btn) { btn.disabled = false; btn.textContent = restoreLabel || '继续上次会话'; }
        }
    },

    // 按草稿元数据重新构建一张照片对象(含每图模板还原)
    async imageFromMeta(meta, savedTpl) {
        try {
            // 先 readExif:主进程会在这里把路径登记进 qflocal 白名单。
            // 顺序反了的话 <img> 会先撞 403,草稿恢复静默少图。
            let exif = {};
            if (window.qingframe && window.qingframe.readExif) {
                try { exif = (await window.qingframe.readExif(meta.path)) || {}; } catch (e) { exif = {}; }
            }
            const img = new Image();
            const src = this.photoUrl(meta.path);
            await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
            if (!img.naturalWidth) return null;
            if (img.naturalWidth * img.naturalHeight > 200 * 1000 * 1000) {
                img.src = '';
                if (this.diagLog) this.diagLog('草稿照片像素超过 2 亿，已跳过: ' + (meta.name || meta.path));
                return null;
            }
            const oriented = await this.applyOrientation(img, exif.orientation);
            const useEl = oriented ? oriented.el : img;
            const im = {
                el: useEl,
                name: meta.name || String(meta.path).split(/[\\/]/).pop(),
                path: meta.path,
                w: oriented ? oriented.w : img.naturalWidth,
                h: oriented ? oriented.h : img.naturalHeight,
                exif,
                customSettings: null,
                grade: meta.grade || null
            };
            // 有调色参数就得让它立刻生效：invalidateGrade 会清缓存并按参数重烘焙
            if (im.grade && this.invalidateGrade) this.invalidateGrade(im);
            if (savedTpl) this.setTpl(im, savedTpl);
            this.queueThumb(im);
            return im;
        } catch (e) { return null; }
    },
});