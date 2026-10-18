// 草稿自动保存:把当前会话(照片路径/模板/每图模板)写入 localStorage,崩溃后启动可恢复
window.App = Object.assign(window.App || {}, {
    _draftKey: 'qfs_draft_v1',
    _draftTimer: null,
    _draftDirty: false,

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
            const tpl = this.template ? JSON.parse(JSON.stringify(this.template)) : null;
            const imageTemplates = [];
            for (const im of this.images) {
                if (!im.path) continue;
                const saved = this.imageTemplates.get(im);
                if (saved) imageTemplates.push({ path: im.path, tpl: JSON.parse(JSON.stringify(saved)) });
            }
            const draft = {
                v: 1,
                savedAt: Date.now(),
                images: this.images.map(im => ({ name: im.name, path: im.path || '', w: im.w, h: im.h })),
                currentIdx: this.currentIdx,
                template: tpl,
                imageTemplates
            };
            let raw = JSON.stringify(draft);
            // 体积护栏:超 2MB 先剥掉大 data: 串再写;剥完仍超 8MB 就放弃本次写入(留诊断日志),
            // 不让一步超大 localStorage.setItem 卡住主线程
            const TRIM_AT = 2 * 1024 * 1024, SKIP_AT = 8 * 1024 * 1024;
            if (raw.length > TRIM_AT) {
                if (this._stripDraftData(draft)) raw = JSON.stringify(draft);
                if (raw.length > SKIP_AT) {
                    if (this.diagLog) this.diagLog(`草稿体积 ${(raw.length / 1048576).toFixed(1)}MB 超过上限，跳过本次保存`);
                    return;
                }
            }
            try { localStorage.setItem(this._draftKey, raw); this._draftDirty = false; }
            catch (e) { /* 超配额时静默 */ }
        } catch (e) { /* 忽略草稿写入错误 */ }
    },

    clearDraft() {
        try { localStorage.removeItem(this._draftKey); } catch (e) { /* 忽略 */ }
    },

    async restoreDraft() {
        let draft = null;
        try {
            const raw = localStorage.getItem(this._draftKey);
            if (raw) draft = JSON.parse(raw);
        } catch (e) { return; }
        if (!draft || !Array.isArray(draft.images) || !draft.images.length) return;
        if (this.images && this.images.length) return; // 已有手动会话则不覆盖
        try {
            const tplByPath = new Map();
            (draft.imageTemplates || []).forEach(entry => { if (entry && entry.path) tplByPath.set(entry.path, entry.tpl); });
            const restored = [];
            for (const meta of draft.images) {
                if (!meta.path) continue;
                const im = await this.imageFromMeta(meta, tplByPath.get(meta.path));
                if (im) restored.push(im);
            }
            if (!restored.length) return;
            this.images = restored;
            this.selectedIdx = [];
            this.batchSel = [];
            const ci = Math.min(Math.max(0, this.currentIdx || 0), restored.length - 1);
            this.currentIdx = ci;
            this.image = restored[ci];
            this.template = this.image.customSettings || (draft.template ? JSON.parse(JSON.stringify(draft.template)) : this.defaultTemplate());
            this.normalizeTemplate();
            this.invalidateStyleCaches();
            this.buildThumbnails();
            this.afterImageSelect();
            this.refreshUI();
            this.scheduleRender(true);
            const btn = document.getElementById('btnRestoreDraft');
            if (btn) btn.style.display = 'none';
            this.scheduleDraft();
            this.setStatus('已恢复上次会话草稿（' + restored.length + ' 张照片）');
        } catch (e) { /* 恢复失败不阻塞启动 */ }
    },

    // 按草稿元数据重新构建一张照片对象(含每图模板还原)
    async imageFromMeta(meta, savedTpl) {
        try {
            const img = new Image();
            const src = this.photoUrl(meta.path);
            await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
            if (!img.naturalWidth) return null;
            let exif = {};
            if (window.qingframe && window.qingframe.readExif) {
                try { exif = (await window.qingframe.readExif(meta.path)) || {}; } catch (e) { exif = {}; }
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
                customSettings: null
            };
            if (savedTpl) {
                im.customSettings = JSON.parse(JSON.stringify(savedTpl));
                this.imageTemplates.set(im, JSON.parse(JSON.stringify(savedTpl)));
            }
            this.queueThumb(im);
            return im;
        } catch (e) { return null; }
    },
});