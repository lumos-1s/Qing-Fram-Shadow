// 调色预设：保存 / 复用 / 分享当前照片的全局调色。
//
// 设计取舍
// ─────────────────────────────────────────────────────────────
// 1) 只存全局参数（GRADE_FIELDS + 曲线 / 校准 / 细节 / 混色器 / 颜色分级 /
//    黑白 / 色彩平衡 / 渐变映射 / 镜头校正），不存蒙版。蒙版是跟着具体画面
//    画的选区，换一张照片套用只会得到"错位的局部调整"。
// 2) 存储走主进程 userData/grade-presets/*.json，和整帧样式模板分库；
//    预设通常几 KB，可以频繁保存、重命名、删除，也方便分享码传输。
// 3) 缩略图用当前照片实时烘焙（bakeGradePreview），只在「调色」页签可见时
//    按需渲染并缓存；没有照片时保持占位，不阻塞启动。
window.App = Object.assign(window.App || {}, {
    _gradePresets: [],
    _gradePresetRows: [],
    _gradePresetQuery: '',
    _gradePresetThumbCache: new Map(),
    _gradePresetThumbRendering: false,
    _gradePresetActiveTimer: 0,
    _gradePresetRevealTimer: 0,

    initGradePresets() {
        const $ = (id) => document.getElementById(id);
        const save = $('btnGradePresetSave');
        if (save) save.addEventListener('click', () => this.saveGradePresetFromCurrent());
        const imp = $('btnGradePresetImport');
        if (imp) imp.addEventListener('click', () => this.importGradePresetShareCode());
        const refresh = $('btnGradePresetRefresh');
        if (refresh) {
            refresh.addEventListener('click', (e) => {
                e.stopPropagation();
                this.refreshGradePresets();
            });
        }
        const search = $('tfGradePresetSearch');
        const clear = $('btnClearGradePresetSearch');
        if (search) {
            search.addEventListener('input', () => {
                this._gradePresetQuery = search.value;
                this._renderGradePresetList();
            });
            search.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape' || !search.value) return;
                search.value = '';
                this._gradePresetQuery = '';
                this._renderGradePresetList();
            });
        }
        if (clear) {
            clear.addEventListener('click', () => {
                if (search) search.value = '';
                this._gradePresetQuery = '';
                this._renderGradePresetList();
            });
        }
        // 用户手动改任何一个调色控件后，"使用中"标记会过时；停手后再比对一次。
        // 搜索框/列表本身不算编辑，跳过，避免输入搜索词时反复重算。
        const panel = $('panel-grade');
        if (panel) {
            const onEdit = (e) => {
                const t = e.target;
                if (t && t.closest && t.closest('#grpGradePresets')) return;
                this._scheduleGradePresetActive();
            };
            panel.addEventListener('input', onEdit);
            panel.addEventListener('change', onEdit);
        }
    },

    /* ══ 读取与列表 ══ */

    async refreshGradePresets() {
        const box = this.$('lvGradePresets');
        if (!box) return;
        const input = this.$('tfGradePresetSearch');
        if (input) this._gradePresetQuery = input.value;
        const api = window.qingframe;
        if (!api || typeof api.listGradePresets !== 'function') {
            this._gradePresets = [];
            this._gradePresetsLoaded = true;
            this._renderGradePresetList();
            return;
        }
        if (!this._gradePresets.length) {
            box.innerHTML = '<div class="tpl-empty tpl-loading"><div class="tpl-empty-title">正在读取我的调色…</div></div>';
        }
        let names = [];
        try { names = (await api.listGradePresets()) || []; } catch (_) { names = []; }
        const rows = await Promise.all(names.map(async (name) => {
            try {
                const data = await api.loadGradePreset(name);
                if (!data || !data.grade || typeof data.grade !== 'object') return null;
                return {
                    name,
                    disp: String(data.name || name),
                    grade: data.grade,
                    updatedAt: data.updatedAt || '',
                };
            } catch (_) { return null; }
        }));
        this._gradePresets = rows.filter(Boolean)
            .sort((a, b) => a.disp.localeCompare(b.disp, 'zh'));
        this._gradePresetsLoaded = true;
        this._renderGradePresetList();
    },

    _syncGradePresetSearchClear() {
        const input = this.$('tfGradePresetSearch');
        const clear = this.$('btnClearGradePresetSearch');
        if (input && clear) clear.hidden = !input.value;
    },

    _updateGradePresetCount(shown, total) {
        const el = this.$('gradePresetCount');
        if (!el) return;
        if (!total) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        const q = String(this._gradePresetQuery || '').trim();
        el.hidden = false;
        el.textContent = q ? (shown + '/' + total) : String(total);
        el.title = q ? `找到 ${shown} 个，共 ${total} 个调色预设` : `共 ${total} 个调色预设`;
    },

    _renderGradePresetList() {
        const box = this.$('lvGradePresets');
        if (!box) return;
        const q = String(this._gradePresetQuery || '').trim();
        const total = this._gradePresets.length;
        const rows = total
            ? this._gradePresets.filter((r) => !q || r.disp.indexOf(q) >= 0 || r.name.indexOf(q) >= 0)
            : [];
        box.innerHTML = '';
        this._gradePresetRows = [];
        this._updateGradePresetCount(rows.length, total);
        this._syncGradePresetSearchClear();

        if (!rows.length) {
            const wrap = document.createElement('div');
            wrap.className = 'tpl-empty';
            const icon = document.createElement('div');
            icon.className = 'tpl-empty-icon';
            icon.textContent = q ? '⌕' : '◐';
            const title = document.createElement('div');
            title.className = 'tpl-empty-title';
            title.textContent = q ? '没有匹配的调色' : '还没有保存过调色';
            const hint = document.createElement('div');
            hint.className = 'tpl-empty-hint';
            hint.textContent = q ? '换个名称试试' : '调好颜色后，点上方「保存当前」留一份';
            wrap.append(icon, title, hint);
            box.appendChild(wrap);
            return;
        }
        for (const r of rows) box.appendChild(this._buildGradePresetRow(r));
        this._renderGradePresetThumbs();
    },

    _buildGradePresetRow(r) {
        const row = document.createElement('div');
        row.className = 'tpl-row';
        row.dataset.gradePresetKey = r.name;
        row._preset = r;

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'tpl-main';
        main.title = '应用调色「' + r.disp + '」到当前照片';
        main.setAttribute('aria-label', '应用调色「' + r.disp + '」');
        const thumb = document.createElement('img');
        thumb.className = 'tpl-thumb';
        thumb.alt = '';
        thumb.draggable = false;
        // 透明占位，避免未渲染时出现破图图标。
        thumb.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        row._thumb = thumb;

        const info = document.createElement('span');
        info.className = 'tpl-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tpl-name';
        nameSpan.textContent = r.disp;
        nameSpan.title = r.disp;
        const meta = document.createElement('span');
        meta.className = 'tpl-meta';
        const activeTag = document.createElement('span');
        activeTag.className = 'tpl-active-tag';
        activeTag.textContent = '使用中';
        const hint = document.createElement('span');
        hint.className = 'tpl-hint';
        hint.textContent = '单击应用';
        meta.append(activeTag, hint);
        info.append(nameSpan, meta);
        main.append(thumb, info);
        main.addEventListener('click', () => this.applyGradePreset(r, [this.currentIdx]));

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tpl-more';
        more.textContent = '⋯';
        more.title = '管理「' + r.disp + '」';
        more.setAttribute('aria-label', '管理调色预设「' + r.disp + '」');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._openGradePresetMenu(r, more);
        });
        row.append(main, more);
        this._gradePresetRows.push(row);
        this._markGradePresetRowActive(row, r);
        return row;
    },

    _openGradePresetMenu(r, btn) {
        const rect = btn.getBoundingClientRect();
        const x = Math.max(8, rect.right - 190);
        this.openCtx(x, rect.bottom + 4, [
            ['应用到当前照片', () => this.applyGradePreset(r, [this.currentIdx])],
            ['应用到选中照片', () => {
                const idxs = this._gradePresetSelectedTargets();
                if (idxs.length <= 1) {
                    this.setStatus('先在胶片条多选要应用的照片（Ctrl / Shift + 单击）');
                    return;
                }
                this.applyGradePreset(r, idxs);
            }],
            ['应用到全部照片', () => this.applyGradePreset(r, (this.images || []).map((_, i) => i))],
            ['复制分享码', () => this.copyGradePresetShareCode(r)],
            ['重命名', () => this.renameGradePresetItem(r)],
            ['删除', () => this.deleteGradePresetItem(r)],
        ]);
    },

    _gradePresetSelectedTargets() {
        const raw = (this.selectedIdx && this.selectedIdx.length)
            ? this.selectedIdx
            : (this.batchSel || []);
        const max = (this.images || []).length;
        return Array.from(new Set((raw || []).filter((i) => Number.isInteger(i) && i >= 0 && i < max)));
    },

    /* ══ 应用 ══ */

    // targets 省略 = 当前照片；传索引数组 = 当前 / 选中 / 全部。
    applyGradePreset(preset, targets) {
        if (!preset || !preset.grade) return false;
        const im = this.image;
        if (!im || !this.images || !this.images.length) {
            this.setStatus('请先导入照片');
            return false;
        }
        const max = this.images.length;
        const list = Array.isArray(targets) && targets.length ? targets : [this.currentIdx];
        const idxs = Array.from(new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < max)));
        if (!idxs.length) return false;

        const base = this.normalizeGrade(preset.grade);
        base.masks = [];
        const touchesCurrent = idxs.indexOf(this.currentIdx) >= 0;
        if (touchesCurrent && this.pushUndo) this.pushUndo();
        if (touchesCurrent && this.setActiveMask) this.setActiveMask(null);

        let n = 0;
        for (const i of idxs) {
            const it = this.images[i];
            if (!it) continue;
            // 蒙版是"这张画面的局部选区"，换预设时保留；预设本身也不含蒙版。
            const masks = (it.grade && Array.isArray(it.grade.masks))
                ? JSON.parse(JSON.stringify(it.grade.masks)) : [];
            const next = this._cloneGrade(Object.assign({}, base, { masks }));
            it.grade = next;
            it._gradeCache = null;
            it._grade = {
                neutral: this.isNeutralGrade ? this.isNeutralGrade(next) : false,
                canvas: null, low: null, lowKey: '', fullKey: '',
            };
            n++;
        }
        if (!n) return false;

        if (touchesCurrent) {
            // 预设是「一整套参数」，不是拖动中的中间态：直接烘出全分辨率画布，
            // 否则 photoSrcOf 没有 canvas / low 可拿，会退回原图（滑块变了但画面没变）。
            if (this.rebuildGrade) this.rebuildGrade('full');
            this.syncGradeUI();
            if (this.renderFramedThumb) this.renderFramedThumb(im);
        }
        if (this.buildThumbnails) this.buildThumbnails();
        if (this.scheduleRender) this.scheduleRender(true);
        if (this.scheduleDraft) this.scheduleDraft();
        this._refreshGradePresetActive();
        this.setStatus(`已应用调色「${preset.disp}」到 ${n} 张照片`);
        return true;
    },

    _cloneGrade(p) {
        try { return JSON.parse(JSON.stringify(p)); }
        catch (_) { return this.normalizeGrade(p); }
    },

    _gradePresetMatches(r) {
        const im = this.image;
        if (!im || !im.grade || !r || !r.grade) return false;
        try {
            const cur = this.normalizeGrade(im.grade);
            const pre = this.normalizeGrade(r.grade);
            cur.masks = [];
            pre.masks = [];
            return JSON.stringify(cur) === JSON.stringify(pre);
        } catch (_) {
            return false;
        }
    },

    _markGradePresetRowActive(row, r) {
        if (!row) return;
        const active = this._gradePresetMatches(r);
        row.classList.toggle('active', active);
        row.setAttribute('aria-current', active ? 'true' : 'false');
        const tag = row.querySelector('.tpl-active-tag');
        if (tag) tag.hidden = !active;
        const hint = row.querySelector('.tpl-hint');
        if (hint) hint.hidden = active;
    },

    _refreshGradePresetActive() {
        if (!this._gradePresetRows || !this._gradePresetRows.length) return;
        for (const row of this._gradePresetRows) this._markGradePresetRowActive(row, row._preset);
    },

    _scheduleGradePresetActive() {
        clearTimeout(this._gradePresetActiveTimer);
        this._gradePresetActiveTimer = setTimeout(() => this._refreshGradePresetActive(), 250);
    },

    // 切图后缩略图/“使用中”都属于上一张照片，需要按新图重算。
    onGradePresetImageChange() {
        if (!this._gradePresetRows || !this._gradePresetRows.length) return;
        for (const row of this._gradePresetRows) {
            if (row._thumb) {
                row._thumb.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
            }
        }
        this._refreshGradePresetActive();
        if (this._gradePresetThumbCache) this._gradePresetThumbCache.clear();
        setTimeout(() => this._renderGradePresetThumbs(), 0);
    },

    /* ══ 缩略图 ══ */

    _gradePresetThumbKey(r) {
        const im = this.image;
        const el = im && im.el;
        if (!this._gradeThumbSrcIds) this._gradeThumbSrcIds = new WeakMap();
        let srcId = 0;
        if (el) {
            srcId = this._gradeThumbSrcIds.get(el) || 0;
            if (!srcId) {
                srcId = (this._gradeThumbSeq = (this._gradeThumbSeq || 0) + 1);
                this._gradeThumbSrcIds.set(el, srcId);
            }
        }
        let sig = '';
        try { sig = JSON.stringify(r.grade); } catch (_) { sig = r.name || ''; }
        return (r.name || '') + '#' + srcId + '#' + sig.length + '#' + sig;
    },

    async _renderGradePresetThumbs() {
        if (this._gradePresetThumbRendering) {
            // 列表在渲染途中被刷新（切换页签会连续触发两次 refresh）：
            // 旧行已经 disconnected，新行需要重新排队，否则它们会一直停在占位图。
            this._gradePresetThumbPending = true;
            return;
        }
        if (typeof this.bakeGradePreview !== 'function') return;
        const panel = this.$('panel-grade');
        // 面板不在前台就不烘焙：每个缩略图都是一次完整的调色管线（约几到几十毫秒）。
        if (panel && !panel.classList.contains('active')) return;
        if (!this._gradePresetRows || !this._gradePresetRows.length) return;
        this._gradePresetThumbRendering = true;
        try {
            for (const row of this._gradePresetRows) {
                const r = row._preset;
                const img = row._thumb;
                if (!r || !img || !img.isConnected) continue;
                const key = this._gradePresetThumbKey(r);
                const cached = this._gradePresetThumbCache.get(key);
                if (cached) {
                    if (img.src !== cached) img.src = cached;
                    continue;
                }
                let cv = null;
                try { cv = this.bakeGradePreview(r.grade, 128); } catch (_) { cv = null; }
                if (!cv) break; // 没有照片可作预览源，保持占位
                try {
                    const url = cv.toDataURL('image/jpeg', 0.72);
                    img.src = url;
                    if (this._gradePresetThumbCache.size > 240) this._gradePresetThumbCache.clear();
                    this._gradePresetThumbCache.set(key, url);
                } catch (_) { /* 保持占位 */ }
                // 预设多时让一帧给界面，别让列表一次卡住。
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            this._gradePresetThumbRendering = false;
            if (this._gradePresetThumbPending) {
                this._gradePresetThumbPending = false;
                setTimeout(() => this._renderGradePresetThumbs(), 0);
            }
        }
    },

    /* ══ 保存 / 重命名 / 删除 / 分享 ══ */

    async saveGradePresetFromCurrent(nameOverride) {
        const im = this.image;
        if (!im) { this.setStatus('请先导入照片'); return false; }
        const grade = this.normalizeGrade(im.grade || null);
        grade.masks = [];
        if (this.isNeutralGrade && this.isNeutralGrade(grade)) {
            this.setStatus('当前照片没有可保存的全局调色（蒙版不保存）');
            return false;
        }
        let name;
        if (nameOverride != null) {
            name = String(nameOverride);
        } else {
            const typed = await this.promptText('给这套调色起个名字（之后可在列表里重命名）', '我的调色');
            if (typed == null) return false;
            name = String(typed);
        }
        name = name.trim();
        if (!name) { this.setStatus('预设名称不能为空'); return false; }
        return this._saveGradePreset(name, grade, { reveal: true });
    },

    async _saveGradePreset(name, grade, opts) {
        const api = window.qingframe;
        if (!api || typeof api.saveGradePreset !== 'function') {
            this.setStatus('当前环境不支持保存调色预设');
            return false;
        }
        const safe = String(name || '').trim().replace(/[\\:*?"<>|/]/g, '_').replace(/[. ]+$/g, '');
        if (!safe) { this.setStatus('预设名称不合法'); return false; }
        let names = [];
        try { names = (await api.listGradePresets()) || []; } catch (_) { names = []; }
        if (names.indexOf(safe) >= 0) {
            if (!window.confirm(`已存在同名调色「${safe}」，要覆盖吗？`)) return false;
        }
        const now = new Date().toISOString();
        const data = {
            v: 1,
            kind: 'qfs-grade-preset',
            app: 'qingframe-web',
            name: safe,
            createdAt: now,
            updatedAt: now,
            grade: this._cloneGrade(grade),
        };
        if (names.indexOf(safe) >= 0) {
            try {
                const old = await api.loadGradePreset(safe);
                if (old && old.createdAt) data.createdAt = old.createdAt;
            } catch (_) { /* 覆盖时拿不到旧创建时间就按现在算 */ }
        }
        let res = null;
        try { res = await api.saveGradePreset(safe, data); } catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('保存调色失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        if (!opts || opts.reveal !== false) this._revealGradePreset(safe);
        this.setStatus(`已保存调色「${safe}」`);
        return true;
    },

    _revealGradePreset(key) {
        const box = this.$('lvGradePresets');
        if (!box || !key) return false;
        const row = [...box.querySelectorAll('.tpl-row')]
            .find((el) => el.dataset.gradePresetKey === key);
        if (!row) return false;
        try { row.scrollIntoView({ block: 'nearest' }); } catch (_) { /* 老环境无此 API */ }
        row.classList.add('tpl-flash');
        clearTimeout(this._gradePresetRevealTimer);
        this._gradePresetRevealTimer = setTimeout(() => row.classList.remove('tpl-flash'), 900);
        return true;
    },

    async renameGradePresetItem(r) {
        const typed = await this.promptText('重命名调色预设', r.disp);
        if (typed == null) return false;
        const safe = String(typed).trim().replace(/[\\:*?"<>|/]/g, '_').replace(/[. ]+$/g, '');
        if (!safe || safe === r.name) return false;
        const api = window.qingframe;
        if (!api || typeof api.renameGradePreset !== 'function') {
            this.setStatus('当前环境不支持重命名调色预设');
            return false;
        }
        let res = null;
        try { res = await api.renameGradePreset(r.name, safe); } catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('重命名失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        this._revealGradePreset(safe);
        this.setStatus(`已重命名为「${safe}」`);
        return true;
    },

    async deleteGradePresetItem(r) {
        if (!window.confirm(`确定删除调色「${r.disp}」？`)) return false;
        const api = window.qingframe;
        if (!api || typeof api.deleteGradePreset !== 'function') {
            this.setStatus('当前环境不支持删除调色预设');
            return false;
        }
        let res = null;
        try { res = await api.deleteGradePreset(r.name); } catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('删除失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        this.setStatus(`已删除「${r.disp}」`);
        return true;
    },

    async copyGradePresetShareCode(r) {
        if (!r || !r.grade) return false;
        const bundle = {
            v: 1,
            kind: 'qfs-grade-preset',
            app: 'qingframe-web',
            name: r.disp,
            exportedAt: new Date().toISOString(),
            grade: this._cloneGrade(Object.assign({}, this.normalizeGrade(r.grade), { masks: [] })),
        };
        let code;
        try {
            code = 'QFSGRADE1:' + this._jsonToB64(JSON.stringify(bundle));
        } catch (e) {
            this.setStatus('分享码生成失败：' + ((e && e.message) || e));
            return false;
        }
        try {
            await navigator.clipboard.writeText(code);
            this.setStatus(`调色分享码已复制（约 ${Math.round(code.length / 1024)} KB），粘贴发给对方即可`);
            return true;
        } catch (e) {
            this.setStatus('复制失败：' + ((e && e.message) || e));
            return false;
        }
    },

    async importGradePresetShareCode() {
        const text = await this.promptText('粘贴调色分享码（QFSGRADE1: 开头），确认后导入', '');
        if (text == null) return false;
        const code = String(text).replace(/\s+/g, '');
        if (!code) { this.setStatus('分享码为空'); return false; }
        // 主进程保存上限 4MB，base64 后约 5.4MB；先挡在渲染进程，避免解码超大文本卡住界面。
        if (code.length > 6 * 1024 * 1024) {
            this.setStatus('导入失败：分享码超过 6MB');
            return false;
        }
        if (code.indexOf('QFSGRADE1:') !== 0) {
            this.setStatus('导入失败：不是有效的调色分享码（应以 QFSGRADE1: 开头）');
            return false;
        }
        let data = null;
        try {
            data = JSON.parse(this._b64ToJson(code.slice('QFSGRADE1:'.length)));
        } catch (_) {
            this.setStatus('导入失败：分享码内容无法识别（可能复制不完整）');
            return false;
        }
        const grade = (data && data.kind === 'qfs-grade-preset' && data.grade)
            ? data.grade
            : (data && data.grade ? data.grade : null);
        if (!grade || typeof grade !== 'object') {
            this.setStatus('导入失败：分享码里没有调色参数');
            return false;
        }
        const normalized = this.normalizeGrade(grade);
        normalized.masks = [];
        if (this.isNeutralGrade && this.isNeutralGrade(normalized)) {
            this.setStatus('导入失败：分享码里没有可用的调色');
            return false;
        }
        const def = String((data && data.name) || '导入的调色').trim() || '导入的调色';
        const typed = await this.promptText('导入后保存为', def);
        if (typed == null) return false;
        const name = String(typed).trim();
        if (!name) { this.setStatus('预设名称不能为空'); return false; }
        return this._saveGradePreset(name, normalized, { reveal: true });
    },
});
