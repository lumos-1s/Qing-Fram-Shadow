// 调色预设「我的调色」：保存 / 复用 / 批量导入当前照片的全局调色。
//
// 设计取舍
// ─────────────────────────────────────────────────────────────
// 1) 只存全局参数（GRADE_FIELDS + 曲线 / 校准 / 细节 / 混色器 / 颜色分级 /
//    黑白 / 色彩平衡 / 渐变映射 / 镜头校正），不存蒙版。蒙版是跟着具体画面
//    画的选区，换一张照片套用只会得到"错位的局部调整"。
// 2) 存储走主进程 userData/grade-presets/*.xmp。预设就是 Lightroom / Camera
//    Raw 能直接读的 XMP（内容是 XML），所以目录里的文件可以直接分享给别人，
//    也可以从 LR 批量导入。旧版 .json 会在读取时自动迁移成 .xmp。
// 3) 「我的调色」放在左侧素材栏，和「边框」双模式切换；右侧只留调色滑块，
//    照片完整可见。悬停预览、单击应用，最接近 Lightroom 的操作方式。
// 4) 列表只显示预设名，不放缩略图：左侧栏窄，文字列表更快扫读，也省掉每张
//    预设都跑一遍调色管线的开销。悬停预览只烘一张低分辨率图，不写 undo。
window.App = Object.assign(window.App || {}, {
    _gradePresets: [],
    _gradePresetRows: [],
    _gradePresetQuery: '',
    _gradePresetActiveTimer: 0,
    _gradePresetRevealTimer: 0,
    _gradePresetLoadSeq: 0,
    _gradePresetLoaded: false,
    _gradeHoverTimer: 0,
    _gradeHover: null,
    _sideMode: 'border',

    initGradePresets() {
        const $ = (id) => document.getElementById(id);
        const save = $('btnGradePresetSave');
        if (save) save.addEventListener('click', () => this.saveGradePresetFromCurrent());
        const imp = $('btnGradePresetImport');
        if (imp) imp.addEventListener('click', () => this.importGradePresets());
        const refresh = $('btnGradePresetRefresh');
        if (refresh) {
            refresh.addEventListener('click', (e) => {
                e.stopPropagation();
                this.refreshGradePresets({ announce: true });
            });
        }
        const openDir = $('btnGradePresetOpenDir');
        if (openDir) {
            openDir.addEventListener('click', async () => {
                const api = window.qingframe;
                if (!api || typeof api.openGradePresetsDir !== 'function') {
                    this.setStatus('当前环境不支持打开预设文件夹');
                    return;
                }
                try {
                    const r = await api.openGradePresetsDir();
                    if (r && r.ok === false) this.setStatus('打开文件夹失败：' + (r.message || '未知错误'));
                } catch (e) {
                    this.setStatus('打开文件夹失败：' + ((e && e.message) || e));
                }
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

        // 左侧「边框 / 我的调色」双模式
        const tabs = [$('sideTabBorder'), $('sideTabGrade')];
        for (const tab of tabs) {
            if (!tab) continue;
            tab.addEventListener('click', () => this.setSideMode(tab.dataset.sideMode));
        }
        let savedMode = '';
        try { savedMode = localStorage.getItem('qfs_side_mode') || ''; } catch (_) { /* 隐私模式 */ }
        this.setSideMode(savedMode === 'grade' ? 'grade' : 'border', { activateTab: false });
        // 边框模式不预读调色库：真正切到「我的调色」时 setSideMode 才发起读取，
        // 不给启动首帧和不用预设的用户增加一次磁盘扫描。

        // 用户手动改任何一个调色控件后，"使用中"标记会过时；停手后再比对一次。
        const panel = $('panel-grade');
        if (panel) {
            const onEdit = () => {
                if (this._scheduleGradePresetActive) this._scheduleGradePresetActive();
            };
            panel.addEventListener('input', onEdit);
            panel.addEventListener('change', onEdit);
        }
        // 悬停预览时窗口失焦/切到后台，指针不会再触发 mouseleave，主动还原。
        window.addEventListener('blur', () => this._endGradePresetHover(true));
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this._endGradePresetHover(true);
        });
    },

    /* ══ 左侧双模式 ══ */

    setSideMode(mode, opts) {
        const m = mode === 'grade' ? 'grade' : 'border';
        if (this._sideMode !== m) this._endGradePresetHover(true);
        this._sideMode = m;
        const aside = this.$('sidebar');
        if (aside) {
            aside.classList.toggle('mode-grade', m === 'grade');
            aside.classList.toggle('mode-border', m !== 'grade');
        }
        const borderBody = this.$('sideBorderBody');
        const gradeBody = this.$('sideGradeBody');
        if (borderBody) borderBody.hidden = m !== 'border';
        if (gradeBody) gradeBody.hidden = m !== 'grade';
        for (const [id, key] of [['sideTabBorder', 'border'], ['sideTabGrade', 'grade']]) {
            const tab = this.$(id);
            if (!tab) continue;
            const on = key === m;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        try { localStorage.setItem('qfs_side_mode', m); } catch (_) { /* 隐私模式 */ }
        if (m === 'grade') {
            if (!this._gradePresetLoaded) this.refreshGradePresets();
            else this._renderGradePresetList();
            if (opts && opts.activateTab === false) return;
            // 从左侧点进「我的调色」时，右侧顺手切到调色页，滑块和预设同屏。
            if (this.switchTab) {
                const active = document.querySelector('#inspTabs .tab.active');
                if (!active || active.dataset.tab !== 'grade') this.switchTab('grade');
            }
        }
    },

    /* ══ 读取与列表 ══ */

    _gradePresetApi() {
        const api = window.qingframe;
        return (api && typeof api.listGradePresets === 'function') ? api : null;
    },

    async refreshGradePresets(opts) {
        const box = this.$('lvGradePresets');
        if (!box) return;
        const input = this.$('tfGradePresetSearch');
        if (input) this._gradePresetQuery = input.value;
        const api = this._gradePresetApi();
        if (!api) {
            this._gradePresets = [];
            this._gradePresetLoaded = true;
            this._renderGradePresetList();
            return;
        }
        const token = ++this._gradePresetLoadSeq;
        if (!this._gradePresets.length) {
            box.innerHTML = '<div class="tpl-empty tpl-loading"><div class="tpl-empty-title">正在读取我的调色…</div></div>';
        }
        let entries = [];
        try { entries = (await api.listGradePresets()) || []; } catch (_) { entries = []; }
        entries = entries.map((e) => (typeof e === 'string'
            ? { name: e, ext: 'json' }
            : { name: String((e && e.name) || ''), ext: (e && e.ext) === 'json' ? 'json' : 'xmp' }))
            .filter((e) => e.name);
        const rows = await Promise.all(entries.map(async (entry) => {
            try {
                const data = await api.loadGradePreset(entry.name, entry.ext);
                let grade = this._gradeFromLoad(entry, data);
                if (!grade) return null;
                // 旧版 .json 只有本应用能读；顺手迁移成 LR 也能打开的 .xmp。
                if (entry.ext === 'json') {
                    const xml = this._gradeToXmp(grade, entry.name);
                    if (xml) {
                        try {
                            const saved = await api.saveGradePreset(entry.name, xml);
                            if (saved && saved.ok !== false) {
                                await api.deleteGradePreset(entry.name, 'json');
                                entry.ext = 'xmp';
                            }
                        } catch (_) { /* 迁移失败就继续用旧文件 */ }
                    }
                }
                return { name: entry.name, ext: entry.ext, disp: entry.name, grade };
            } catch (_) { return null; }
        }));
        if (token !== this._gradePresetLoadSeq) return; // 更新的刷新已接管
        this._gradePresets = rows.filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        this._gradePresetLoaded = true;
        this._renderGradePresetList();
        if (opts && opts.announce) {
            const n = this._gradePresets.length;
            this.setStatus(n ? `已刷新，共 ${n} 个调色预设` : '还没有调色预设');
        }
    },

    _gradeFromLoad(entry, data) {
        if (!data) return null;
        let grade = null;
        if (data.kind === 'xmp' || typeof data.xml === 'string') {
            if (!window.AppXmp || typeof window.AppXmp.mapXmp !== 'function') return null;
            const mapped = window.AppXmp.mapXmp(data.xml);
            if (!mapped || !mapped.hasAdjust || !mapped.patch || typeof mapped.patch !== 'object') return null;
            grade = mapped.patch;
        } else {
            const raw = data.kind === 'json' ? data.data : data;
            grade = raw && raw.grade;
        }
        if (!grade || typeof grade !== 'object') return null;
        const g = this.normalizeGrade(grade);
        g.masks = [];
        return g;
    },

    _gradeToXmp(grade, name) {
        if (!window.AppXmp || typeof window.AppXmp.gradeToXmp !== 'function') {
            this.setStatus('XMP 模块未加载，无法写入预设文件');
            return '';
        }
        try {
            const g = this.normalizeGrade(grade);
            g.masks = [];
            return window.AppXmp.gradeToXmp(g, name);
        } catch (e) {
            this.setStatus('生成 XMP 失败：' + ((e && e.message) || e));
            return '';
        }
    },

    _parseXmpGrade(xml) {
        if (!xml || !window.AppXmp || typeof window.AppXmp.mapXmp !== 'function') return null;
        try {
            const mapped = window.AppXmp.mapXmp(xml);
            if (!mapped || !mapped.hasAdjust || !mapped.patch || typeof mapped.patch !== 'object') return null;
            const g = this.normalizeGrade(mapped.patch);
            g.masks = [];
            return g;
        } catch (_) {
            return null;
        }
    },

    _safePresetName(name) {
        return String(name == null ? '' : name).trim()
            .replace(/[\\:*?"<>|/]/g, '_')
            .replace(/[. ]+$/g, '')
            .slice(0, 120) || '未命名调色';
    },

    _uniquePresetName(base, taken) {
        let name = base;
        let n = 2;
        while (taken.has(name)) {
            name = base + ' (' + n + ')';
            n++;
        }
        return name;
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
            ? this._gradePresets.filter((r) => !q || r.name.indexOf(q) >= 0)
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
            title.textContent = q ? '没有匹配的调色' : '还没有调色预设';
            const hint = document.createElement('div');
            hint.className = 'tpl-empty-hint';
            hint.textContent = q
                ? '换个名称试试'
                : '调好颜色后，点上方「保存当前」留一份；也可以导入 LR 的 .xmp';
            wrap.append(icon, title, hint);
            box.appendChild(wrap);
            return;
        }
        for (const r of rows) box.appendChild(this._buildGradePresetRow(r));
    },

    _buildGradePresetRow(r) {
        const row = document.createElement('div');
        row.className = 'tpl-row grade-preset-row';
        row.dataset.gradePresetKey = r.name;
        row._preset = r;

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'tpl-main';
        main.title = '单击应用调色「' + r.disp + '」到当前照片；悬停预览';
        main.setAttribute('aria-label', '应用调色「' + r.disp + '」');

        // 纯文字列表：预设名 +（使用中）标记；点击/悬停反馈就够了，不放缩略图。
        const info = document.createElement('span');
        info.className = 'tpl-info grade-preset-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tpl-name';
        nameSpan.textContent = r.disp;
        nameSpan.title = r.disp;
        const activeTag = document.createElement('span');
        activeTag.className = 'tpl-active-tag';
        activeTag.textContent = '使用中';
        info.append(nameSpan, activeTag);
        main.append(info);
        main.addEventListener('click', () => this.applyGradePreset(r, [this.currentIdx]));

        row.addEventListener('mouseenter', () => this._scheduleGradePresetHover(r, row));
        row.addEventListener('mouseleave', () => this._cancelGradePresetHover(row));

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tpl-more';
        more.textContent = '⋯';
        more.title = '管理「' + r.disp + '」';
        more.setAttribute('aria-label', '管理调色预设「' + r.disp + '」');
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._endGradePresetHover(true);
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
            ['导出 XMP…', () => this.exportGradePresetToFile(r)],
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

    /* ══ 悬停预览（只换画面，不写参数 / 不产生撤销记录） ══ */

    _gradePresetSideVisible() {
        if (this._sideMode !== 'grade') return false;
        if (document.body.classList.contains('sidebar-collapsed')) return false;
        const body = this.$('sideGradeBody');
        return !body || !body.hidden;
    },

    _scheduleGradePresetHover(r, row) {
        if (!this.image || !this.image.el) return;
        if (this._gradePresetMatches(r)) return; // 已经是这套调色，无需预览
        clearTimeout(this._gradeHoverTimer);
        this._gradeHoverTimer = setTimeout(() => this._previewGradePreset(r, row), 70);
    },

    _cancelGradePresetHover(row) {
        clearTimeout(this._gradeHoverTimer);
        if (this._gradeHover && (!row || this._gradeHover.row === row)) {
            this._endGradePresetHover(true);
        }
    },

    _previewGradePreset(r, row) {
        if (!r || !r.grade || !this.image || !this.image.el || this._sideMode !== 'grade') return;
        if (!this._gradePresetSideVisible()) return;
        this._endGradePresetHover(true);
        const im = this.image;
        let cv = null;
        try {
            cv = this.bakeGradePreview(Object.assign({}, r.grade, { masks: [] }), 1400);
        } catch (_) { cv = null; }
        if (!cv) return;
        // 只替换 _grade 缓存：im.grade 不变，撤销栈不受影响。
        const prev = im._grade;
        const preview = { neutral: false, canvas: null, low: cv, lowKey: 'grade-hover', fullKey: '' };
        im._grade = preview;
        this._gradeHover = { im, prev, preview, row };
        if (row) row.classList.add('previewing');
        if (this.scheduleRender) this.scheduleRender(true);
    },

    _endGradePresetHover(restore) {
        clearTimeout(this._gradeHoverTimer);
        const h = this._gradeHover;
        if (!h) return;
        this._gradeHover = null;
        if (h.row) h.row.classList.remove('previewing');
        // 只有预览缓存还挂在原位置时才还原；中途被应用/切图覆盖时不能把新状态冲掉。
        if (restore && h.im && h.im._grade === h.preview) {
            h.im._grade = h.prev;
            if (this.scheduleRender) this.scheduleRender(true);
        }
    },

    /* ══ 应用 ══ */

    // targets 省略 = 当前照片；传索引数组 = 当前 / 选中 / 全部。
    applyGradePreset(preset, targets) {
        if (!preset || !preset.grade) return false;
        this._endGradePresetHover(true);
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
    },

    _refreshGradePresetActive() {
        if (!this._gradePresetRows || !this._gradePresetRows.length) return;
        for (const row of this._gradePresetRows) this._markGradePresetRowActive(row, row._preset);
    },

    _scheduleGradePresetActive() {
        clearTimeout(this._gradePresetActiveTimer);
        this._gradePresetActiveTimer = setTimeout(() => this._refreshGradePresetActive(), 250);
    },

    // 切图后「使用中」标记属于上一张照片，需要按新图重算。
    onGradePresetImageChange() {
        this._endGradePresetHover(true);
        this._refreshGradePresetActive();
    },

    /* ══ 保存 / 导入 / 重命名 / 删除 / 导出 ══ */

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
        name = this._safePresetName(name);
        if (!name) { this.setStatus('预设名称不能为空'); return false; }

        const api = this._gradePresetApi();
        if (!api) {
            this.setStatus('当前环境不支持保存调色预设');
            return false;
        }
        // 没有保存对话框的环境（开发/旧版桥）退回直接存库。
        if (typeof api.pickGradePresetSavePath !== 'function'
            || typeof api.saveGradePresetXmp !== 'function') {
            return this._saveGradePresetToLibrary(name, grade, { reveal: true });
        }

        let picked = null;
        try { picked = await api.pickGradePresetSavePath(name); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('保存调色失败：' + (picked.error || '无法打开保存位置'));
            return false;
        }
        const finalName = this._safePresetName(picked.name || name);
        // 覆盖确认由系统保存框负责（Windows/macOS 都会在文件已存在时询问），
        // 这里不再二次弹窗；选到库外时主进程会自动收录成唯一名称。
        const xml = this._gradeToXmp(grade, finalName);
        if (!xml) return false;
        let res = null;
        try { res = await api.saveGradePresetXmp(picked.path, xml); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('保存调色失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        const savedName = res.libraryName || finalName;
        this._revealGradePreset(savedName);
        const extra = (res.libraryPath && res.libraryPath !== picked.path)
            ? '，已收录到「我的调色」' : '';
        this.setStatus(`已保存调色「${savedName}」（XMP）${extra}`);
        return true;
    },

    // 直接写入预设库（只有旧桥/测试环境才会走到）。
    async _saveGradePresetToLibrary(name, grade, opts) {
        const api = this._gradePresetApi();
        if (!api || typeof api.saveGradePreset !== 'function') {
            this.setStatus('当前环境不支持保存调色预设');
            return false;
        }
        let names = [];
        try { names = (await api.listGradePresets()) || []; } catch (_) { names = []; }
        const exists = names.some((e) => (typeof e === 'string' ? e : e.name) === name);
        if (exists && !window.confirm(`已存在同名调色「${name}」，要覆盖吗？`)) return false;
        const xml = this._gradeToXmp(grade, name);
        if (!xml) return false;
        let res = null;
        try { res = await api.saveGradePreset(name, xml); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('保存调色失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        if (!opts || opts.reveal !== false) this._revealGradePreset(name);
        this.setStatus(`已保存调色「${name}」（XMP）`);
        return true;
    },

    async importGradePresets() {
        const api = this._gradePresetApi();
        if (!api || typeof api.pickGradeXmpFiles !== 'function' || typeof api.saveGradePreset !== 'function') {
            this.setStatus('当前环境不支持导入调色预设');
            return false;
        }
        // 标准 LR 预设的参数曲线要用实测表才准；没加载好也继续，走公式兜底。
        if (window.QfsAcr && QfsAcr.ensure) { try { await QfsAcr.ensure(); } catch (_) {} }
        let picked = null;
        try { picked = await api.pickGradeXmpFiles(); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('导入失败：' + (picked.error || '无法读取预设文件'));
            return false;
        }
        const files = Array.isArray(picked.files) ? picked.files : [];
        if (!files.length) {
            this.setStatus('没有选择可导入的 .xmp 文件');
            return false;
        }
        this.setStatus(`正在导入 ${files.length} 个调色预设…`);
        let entries = [];
        try { entries = (await api.listGradePresets()) || []; } catch (_) { entries = []; }
        const taken = new Set(entries.map((e) => (typeof e === 'string' ? e : e.name)));
        let ok = 0;
        let dup = 0;
        let bad = 0;
        const badNames = [];
        const imported = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i] || {};
            const grade = this._parseXmpGrade(f.xml);
            if (!grade) {
                bad++;
                if (f.name) badNames.push(String(f.name));
                continue;
            }
            const base = this._safePresetName(f.name || '导入的调色');
            let target = base;
            if (taken.has(base)) {
                // 同名且内容完全一致：真重复，跳过；同名不同内容：加 (2) 保留两份。
                const same = await this._libraryGradeEquals(base, grade);
                if (same) { dup++; continue; }
                target = this._uniquePresetName(base, taken);
            }
            const xml = this._gradeToXmp(grade, target);
            if (!xml) { bad++; if (f.name) badNames.push(String(f.name)); continue; }
            let res = null;
            try { res = await api.saveGradePreset(target, xml); }
            catch (e) { res = { ok: false, error: String(e) }; }
            if (res && res.ok !== false) {
                ok++;
                imported.push(target);
                taken.add(target);
            } else {
                bad++;
                if (f.name) badNames.push(String(f.name));
            }
            if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await this.refreshGradePresets();
        if (imported.length) this._revealGradePreset(imported[0]);
        const parts = [`成功 ${ok} 个`];
        if (dup) parts.push(`跳过 ${dup} 个已存在`);
        if (bad) parts.push(`跳过 ${bad} 个无法识别`);
        if (picked.skipped && picked.skipped.length) parts.push(`读取失败 ${picked.skipped.length} 个`);
        let msg = '导入完成：' + parts.join('，');
        if (badNames.length) {
            msg += '（' + badNames.slice(0, 3).join('、') + (badNames.length > 3 ? ' 等' : '') + '）';
        }
        this.setStatus(msg);
        return ok > 0;
    },

    async _libraryGradeEquals(name, grade) {
        const api = this._gradePresetApi();
        if (!api) return false;
        try {
            const data = await api.loadGradePreset(name, 'xmp');
            const other = this._gradeFromLoad({ name, ext: 'xmp' }, data);
            if (!other) return false;
            const a = this.normalizeGrade(other);
            const b = this.normalizeGrade(grade);
            a.masks = [];
            b.masks = [];
            return JSON.stringify(a) === JSON.stringify(b);
        } catch (_) {
            return false;
        }
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
        const safe = this._safePresetName(typed);
        if (!safe || safe === r.name) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.renameGradePreset !== 'function') {
            this.setStatus('当前环境不支持重命名调色预设');
            return false;
        }
        let res = null;
        try { res = await api.renameGradePreset(r.name, safe); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('重命名失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        // 文件改名后，把 XMP 里的预设名也重写一遍，分享给 LR 时标题不会还是旧名字。
        const xml = this._gradeToXmp(r.grade, safe);
        if (xml) {
            try {
                await api.saveGradePreset(safe, xml);
                // 旧版 .json 被改名后会在旁边留一份；已经有新 .xmp，旧格式可以删了。
                if (r.ext === 'json' && typeof api.deleteGradePreset === 'function') {
                    await api.deleteGradePreset(safe, 'json');
                }
            } catch (_) { /* 内容重写失败不影响改名 */ }
        }
        await this.refreshGradePresets();
        this._revealGradePreset(safe);
        this.setStatus(`已重命名为「${safe}」`);
        return true;
    },

    async deleteGradePresetItem(r) {
        if (!window.confirm(`确定删除调色「${r.disp}」？`)) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.deleteGradePreset !== 'function') {
            this.setStatus('当前环境不支持删除调色预设');
            return false;
        }
        let res = null;
        try { res = await api.deleteGradePreset(r.name, r.ext); }
        catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('删除失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        await this.refreshGradePresets();
        this.setStatus(`已删除「${r.disp}」`);
        return true;
    },

    async exportGradePresetToFile(r) {
        if (!r || !r.grade) return false;
        const api = this._gradePresetApi();
        if (!api || typeof api.pickGradePresetSavePath !== 'function') {
            this.setStatus('当前环境不支持导出调色预设');
            return false;
        }
        let picked = null;
        try { picked = await api.pickGradePresetSavePath(r.disp); }
        catch (e) { picked = { ok: false, error: String(e) }; }
        if (!picked || picked.canceled) return false;
        if (picked.ok === false) {
            this.setStatus('导出失败：' + (picked.error || '无法打开保存位置'));
            return false;
        }
        const name = this._safePresetName(picked.name || r.disp);
        const xml = this._gradeToXmp(r.grade, name);
        if (!xml) return false;
        let res = null;
        try {
            if (typeof api.exportGradePresetXmp === 'function') {
                res = await api.exportGradePresetXmp(picked.path, xml);
            } else {
                res = await api.saveGradePresetXmp(picked.path, xml);
            }
        } catch (e) { res = { ok: false, error: String(e) }; }
        if (!res || res.ok === false) {
            this.setStatus('导出失败：' + ((res && res.error) || '未知错误'));
            return false;
        }
        if (picked.inLibrary) await this.refreshGradePresets();
        this.setStatus(`已导出调色「${name}」（XMP）`);
        return true;
    },
});
