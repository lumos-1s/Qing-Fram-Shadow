// 模板模块：模板页签 + 预设加载/预设树 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 模板页签 ══ */
    refreshTemplateFields() {
        const $ = this.$;
        const t = this.template || {};
        if ($('tfTemplateName')) $('tfTemplateName').value = t.templateName || '';
        if ($('tfTemplateTag')) $('tfTemplateTag').value = t.templateTag || '';
    },

    async refreshTemplates() {
        const box = this.$('lvPresets');
        if (!box) return;
        const names = (await window.qingframe.listTemplates()) || [];
        this._savedTemplates = names;
        const cache = [];
        for (const n of names) {
            try {
                const data = await window.qingframe.loadTemplate(n);
                if (!data) continue;
                cache.push({
                    name: n,
                    disp: String(data.templateName || n),
                    tag: String(data.templateTag || ''),
                    tpl: data,
                });
            } catch (e) { /* 跳过损坏模板 */ }
        }
        this._tplCache = cache;
        if (this.$('tfTemplateSearch')) this.$('tfTemplateSearch').value = '';
        this._renderTplList(box, cache);
        this._renderTplThumbs();
    },

    _applyTplFilter() {
        const box = this.$('lvPresets');
        if (!box) return;
        const q = (this.$('tfTemplateSearch') ? this.$('tfTemplateSearch').value : '').trim().toLowerCase();
        const src = this._tplCache || [];
        const rows = !q ? src : src.filter(r => r.disp.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q));
        this._renderTplList(box, rows);
        this._renderTplThumbs();
    },

    _renderTplList(box, rows) {
        box.innerHTML = '';
        if (!rows.length) {
            const has = !!(this._tplCache && this._tplCache.length);
            box.innerHTML = '<div class="empty">' + (has ? '没有匹配的已存模板' : '暂无已存模板') + '</div>';
            return;
        }
        const groups = new Map();
        rows.forEach(r => {
            const g = r.tag || '未分类';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(r);
        });
        const order = [...groups.keys()].sort((a, b) => (b === '未分类') - (a === '未分类') || a.localeCompare(b, 'zh'));
        order.forEach((g, gi) => {
            const gEl = document.createElement('div');
            gEl.className = 'tpl-group' + (gi === 0 ? ' open' : '');
            const gn = document.createElement('div');
            gn.className = 'tpl-group-name';
            const caret = document.createElement('span');
            caret.className = 'caret'; caret.textContent = '▸';
            gn.appendChild(caret);
            gn.appendChild(document.createTextNode(g + ' · ' + groups.get(g).length));
            gn.addEventListener('click', () => gEl.classList.toggle('open'));
            gEl.appendChild(gn);
            groups.get(g).forEach(r => gEl.appendChild(this._buildTplRow(r)));
            box.appendChild(gEl);
        });
        this._thumbsPending = rows.filter(r => r.tpl);
    },

    _buildTplRow(r) {
        const row = document.createElement('div');
        row.className = 'tpl-row';
        const thumb = document.createElement('img');
        thumb.className = 'tpl-thumb';
        r._thumb = thumb;
        row.appendChild(thumb);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = r.disp;
        nameSpan.title = r.name;
        row.appendChild(nameSpan);
        const btnBox = document.createElement('div');
        const btnLoad = document.createElement('button');
        btnLoad.className = 'mini-btn'; btnLoad.textContent = '应用';
        const btnRename = document.createElement('button');
        btnRename.className = 'mini-btn'; btnRename.textContent = '重命名';
        const btnDel = document.createElement('button');
        btnDel.className = 'mini-btn danger'; btnDel.textContent = '删除';
        btnBox.appendChild(btnLoad); btnBox.appendChild(btnRename); btnBox.appendChild(btnDel);
        row.appendChild(btnBox);
        btnLoad.addEventListener('click', async ev => { ev.stopPropagation(); await this.loadTemplateByName(r.name); this.refreshTemplates(); });
        btnRename.addEventListener('click', async ev => {
            ev.stopPropagation();
            await this.renameTemplateItem(r);
        });
        btnDel.addEventListener('click', async ev => {
            ev.stopPropagation();
            if (!confirm('确定删除模板「' + r.disp + '」？')) return;
            await window.qingframe.deleteTemplate(r.name);
            this.setStatus('已删除「' + r.disp + '」');
            this.refreshTemplates();
        });
        row.addEventListener('click', async () => {
            await this.loadTemplateByName(r.name);
            this.refreshTemplates();
        });
        return row;
    },

    async renameTemplateItem(r) {
        const name = await this.promptText('重命名模板(另存为新名称并删除旧的)', r.disp);
        if (!name) return;
        const safe = String(name).trim();
        if (!safe || safe === r.name) return;
        const res = await window.qingframe.renameTemplate(r.name, safe);
        this.setStatus(res && res.ok ? '已重命名为「' + safe + '」' : '重命名失败：' + ((res && res.error) || ''));
        this.refreshTemplates();
    },

    _thumbsPending: [],
    // 模板缩略图缓存:键 = 名称 + 内容指纹(见 _tplThumbKey),值 = dataURL。
    // 每个缩略图是一次完整引擎渲染 + 一次 toDataURL,而模板内容多数时候没变。
    _tplThumbCache: new Map(),

    _tplThumbKey(r) {
        // 模板对象每次 refreshTemplates 都是重新读盘的新对象,不能用对象身份当键;
        // 用 JSON 文本 + 长度当内容指纹,内容一改自然换键。
        let s;
        try { s = JSON.stringify(r.tpl); } catch (e) { s = 'x'; }
        return (r.name || '') + '#' + s.length + '#' + s;
    },

    async _renderTplThumbs() {
        if (!window.__render || !this._thumbsPending.length) return;
        // 面板不在前台就不渲染:每个缩略图是一次完整引擎渲染 + toDataURL(约 5~25ms),
        // 而 refreshTemplates 还会被保存/重命名/删除等路径调用。切到「模板」页签时
        // switchTab 会重新 refreshTemplates,那时再渲染;此处保留 _thumbsPending 不动。
        const panel = this.$('panel-template');
        if (panel && !panel.classList.contains('active')) return;
        const prevCanvas = this.dom.canvas;
        const prevMax = this.displayMax;
        const prevImg = this.image;
        const prevTpl = this.template;
        try {
            const sample = this._samplePhoto || (this._samplePhoto = this._makeSamplePhoto());
            for (const r of this._thumbsPending.slice()) {
                const thumb = r._thumb;
                if (!thumb || !r.tpl) continue;
                const tkey = this._tplThumbKey(r);
                const cached = this._tplThumbCache.get(tkey);
                if (cached) { thumb.src = cached; continue; }   // 内容没变,直接复用上次的图
                if (!sample.complete) await new Promise(res => { sample.onload = res; sample.onerror = res; });
                const cv = document.createElement('canvas');
                cv.width = 1; cv.height = 1;
                cv.style.position = 'absolute'; cv.style.visibility = 'hidden';
                try {
                    this.dom.canvas = cv;
                    this.displayMax = 96;
                    this.image = { el: sample, exif: {}, w: sample.naturalWidth || 1000, h: sample.naturalHeight || 1250 };
                    this.template = JSON.parse(JSON.stringify(r.tpl));
                    if (r.tpl.puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                    else window.__render(this, false);
                    thumb.src = cv.toDataURL('image/jpeg', 0.75);
                    if (this._tplThumbCache.size > 200) this._tplThumbCache.clear();
                    this._tplThumbCache.set(tkey, thumb.src);
                } catch (_) { thumb.style.display = 'none'; }
            }
        } finally {
            this.image = prevImg;
            this.template = prevTpl;
            if (this.dom.canvas) this.dom.canvas = prevCanvas;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }
        this._thumbsPending = [];
    },

    _makeSamplePhoto() {
        const c = document.createElement('canvas');
        c.width = 1000; c.height = 1250;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 1000, 1250);
        grad.addColorStop(0, '#dfe9f3'); grad.addColorStop(0.5, '#c1a8e8'); grad.addColorStop(1, '#8b5cf6');
        g.fillStyle = grad; g.fillRect(0, 0, 1000, 1250);
        g.fillStyle = 'rgba(255,255,255,.5)';
        for (let i = 0; i < 16; i++) {
            g.beginPath();
            g.arc(Math.random() * 1000, Math.random() * 1250, 20 + Math.random() * 90, 0, Math.PI * 2);
            g.fill();
        }
        g.fillStyle = '#2b2f3a'; g.fillRect(0, 990, 1000, 260);
        g.strokeStyle = '#ffd166'; g.lineWidth = 6; g.strokeRect(40, 40, 920, 910);
        g.fillStyle = '#fff'; g.font = 'bold 76px "Microsoft YaHei", sans-serif'; g.textAlign = 'center';
        g.fillText('SAMPLE', 500, 620);
        const im = new Image();
        im.src = c.toDataURL('image/jpeg', 0.8);
        return im;
    },

    async saveTemplate() {
        const $ = this.$;
        const name = ($('tfTemplateName') ? $('tfTemplateName').value : '').trim();
        if (!name) { this.setStatus('请输入模板名称'); return; }
        // 从回显字段刷新模板(名称/标签)
        if (this.template) {
            this.template.templateName = name;
            this.template.templateTag = $('tfTemplateTag') ? $('tfTemplateTag').value.trim() : '';
        }
        this.syncModelFromUI();
        const r = await window.qingframe.saveTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? `已保存模板「${name}」` : '保存失败：' + (r.error || ''));
        this.refreshTemplates();
    },

    async loadTemplateByName(name) {
        if (window.qingframe.loadTemplate) {
            const data = await window.qingframe.loadTemplate(name);
            if (!data) { this.setStatus('加载模板失败'); return; }
            this.onSettingCommit();
            this.template = JSON.parse(JSON.stringify(data));
            this.normalizeTemplate();
            this.saveCurrentTemplate();
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用模板「${name}」`);
            return;
        }
    },

    async exportTemplate() {
        // 导出 .qfs 工程(含照片)或旧版裸模板 JSON
        if (this.images && this.images.length) return this.exportQFS();
        const name = (this.$('tfTemplateName') ? this.$('tfTemplateName').value : '').trim() || 'template';
        this.syncModelFromUI();
        const r = await window.qingframe.exportTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? '模板已导出' : (r.canceled ? '已取消' : '导出失败'));
    },

    async importTemplate() {
        // 导入 .qfs 工程或旧版裸模板 JSON
        return this.importQFS();
    },

    // 导出「配置」:当前编辑状态(边框方案 + 右侧栏参数 + 签名/文字 + 相机参数)打包为
    // 单个轻量 JSON,不含照片 —— 用于备份 / 迁移 / 分享,微信传几 KB 就能给别人套用
    async exportConfig() {
        if (!this.template) { this.setStatus('没有可导出的配置'); return; }
        this.syncModelFromUI();
        const name = (this.$('tfTemplateName') && this.$('tfTemplateName').value.trim()) || '我的配置';
        const bundle = {
            v: 1,
            kind: 'qfs-config',
            app: 'qingframe-web',
            name,
            exportedAt: new Date().toISOString(),
            template: this.cloneTemplate()
        };
        this.setStatus('正在导出配置…');
        const r = await window.qingframe.exportTemplate(name, bundle);
        this.setStatus(r.ok ? `配置已导出为「${name}」` : (r.canceled ? '已取消导出' : '导出失败：' + (r.error || '')));
    },

    // 导入「配置」:读取上面的配置 JSON(也兼容裸模板 JSON),校验后还原到当前照片的编辑状态
    async importConfig() {
        const r = await window.qingframe.importTemplate();
        if (!r.ok) { this.setStatus(r.canceled ? '已取消' : '导入失败：' + (r.error || '')); return; }
        let data = r.data;
        if (!data || typeof data !== 'object') { this.setStatus('导入失败：文件内容无法识别'); return; }
        // 配置包:取内部 template;裸模板:直接用
        if (data.kind === 'qfs-config' && data.template && typeof data.template === 'object') data = data.template;
        if (!data || typeof data !== 'object' || typeof data.photoFrameStyle !== 'string') {
            this.setStatus('导入失败：不是有效的清框影配置/模板文件');
            return;
        }
        this.onSettingCommit();
        this.template = JSON.parse(JSON.stringify(data));
        this.normalizeTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已导入配置「${r.name}」（照片不变，边框/参数已还原）`);
    },

    applyQuickPreset(kind) {
        if (!this.presets.length) { this.setStatus('预设库未加载'); return; }
        this.onSettingCommit();
        let p = null;
        if (kind === 'film') p = this.presets.find(x => /胶片/i.test(x.templateName)) || this.presets[0];
        else p = this.presets.find(x => /证件照/i.test(x.templateName)) || this.presets[0];
        if (p) {
            // 走 applyPreset 统一入口,保留用户的 logo/贴纸/自由文字(见 applyPreset 注释)。
            // undo 快照已由上面的 onSettingCommit() 压入,这里不要重复 pushUndo。
            this.applyPreset(p);
            this.setStatus(`已应用预设「${p.templateName}」`);
        }
    },

    async autoColorBorder() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const color = window.EngineStyles && window.EngineStyles.extractDominant;
        if (typeof color !== 'function') { this.setStatus('自动取色不可用'); return; }
        try {
            const c = await color(this.image.el);
            this.onSettingCommit();
            const layer = this.currentLayer();
            layer.fillConfig.fillType = 'solid';
            layer.fillConfig.fillHex = c.replace('#', '');
            if (this.$('cpFillColor')) this.$('cpFillColor').value = c;
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用自动取色边框 #${c}`);
        } catch (e) { this.setStatus('取色失败: ' + e.message); }
    },

    /* ══ 预设加载 ══ */
    async loadPresets() {
        this.splashStatus('正在加载预设…');
        try { this.presets = await window.__loadAllPresets(); }
        catch (e) { this.presets = []; }
        this.buildTree();
        this.refreshCamLibSelect();
        // 首帧预设选择不在启动路径上执行:先把窗口/预设树渲染出来,选择推迟到
        // init() 末尾的空闲回调(见 app.js),恢复草稿/用户手动选择都不会被覆盖。
        this.splashTick();
    },

    async loadLogos() {
        try { this.logos = (await window.qingframe.listLogos()) || []; }
        catch (e) { this.logos = []; }
        try {
            const builtin = (await window.qingframe.listCustomIcons()) || [];
            builtin.forEach(c => { if (c && c.dataUrl) this.logos.push(c); });
        } catch(e) {}
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.forEach(c => { if (c && c.dataUrl && !this.logos.some(l => l.dataUrl === c.dataUrl)) this.logos.push(c); });
        } catch(e) {}
        // 内置原创标记:单独放 this.marks,不进 this.logos —— 后者要参与品牌那套逻辑
        // (_brandRank 热度排序、brandLogoEntry 按文件名匹配 EXIF 品牌),标记混进去会被当成品牌。
        // 测试用的 preload-measure.js 没有 listMarks,所以先判存在性再调。
        try {
            const q = window.qingframe;
            if (q && typeof q.listMarks === 'function') {
                this.marks = ((await q.listMarks()) || []).filter(m => m && m.dataUrl);
                // 诊断信息会显示在「内置标记」标题后面 —— 空池时必须能一眼看出是哪一层的问题,
                // 否则界面只显示"缺失",排查得靠猜(这个坑已经踩过两次了)。
                this._marksDiag = this.marks.length === 0 ? '主进程返回空' : '';
            } else {
                // 测试用的 preload-measure.js 本来就没有这个方法(属正常),
                // 但正式版走到这里说明主进程/preload 是旧的(改了 main 或 preload 却没完全重启)。
                this.marks = [];
                this._marksDiag = 'preload 未提供';
                console.warn('[清框影] preload 未提供 listMarks:内置标记不可用。' +
                    '若刚改过 src/main 或 preload,请完全退出应用后重新启动(渲染进程刷新不够)。');
            }
        } catch (e) {
            this.marks = [];
            this._marksDiag = '调用失败';
            console.warn('[清框影] listMarks 调用失败(主进程可能还是旧的):', e && e.message);
        }
        this.splashTick();
        // 启动路径不立即构建 logo 池 DOM(上百个 img 赋值 src 会触发批量解码,是启动卡顿主因)。
        // 空闲时再建;用户切到「Logo」页签时 switchTab 有兜底渲染,数据(this.logos)已在上面就绪。
        const buildPools = () => { if (this.dom.stRes) this.renderLogoPools(); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(buildPools, { timeout: 2500 });
        else setTimeout(buildPools, 1500);
    },
    saveCustomIcon(logo) {
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.push(logo);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
    },
    // 返回 { ok, error }:调用方要能告诉用户"这次没删掉",否则图标看着消失、重启又回来,
    // 用户只会以为应用有 bug。旧实现只 console.warn,失败完全不可见。
    async deleteCustomIcon(logo) {
        try {
            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved = saved.filter(c => c.dataUrl !== logo.dataUrl);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
        try {
            if (window.qingframe && typeof window.qingframe.deleteCustomIcon === 'function') {
                const r = await window.qingframe.deleteCustomIcon(logo.dataUrl) || {};
                if (r.ok === false) return { ok: false, error: r.error };
                return { ok: true, removed: r.removed };
            }
            return { ok: true };
        } catch(e) { return { ok: false, error: (e && e.message) || String(e) }; }
    },

    async loadTextures() {
        try { this.textures = (await window.qingframe.listTextures()) || []; }
        catch (e) { this.textures = []; }
        this.splashTick();
    },

    getFavorites() { try { return JSON.parse(localStorage.getItem("qfs_fav_presets") || "[]"); } catch(e) { return []; } },
    setFavorites(arr) { localStorage.setItem("qfs_fav_presets", JSON.stringify(arr)); },
    getRecent() { try { return JSON.parse(localStorage.getItem("qfs_recent_presets") || "[]"); } catch(e) { return []; } },
    pushRecent(name) {
        if (!name) return;
        let r = this.getRecent().filter(n => n !== name);
        r.unshift(name);
        if (r.length > 6) r = r.slice(0, 6);
        localStorage.setItem("qfs_recent_presets", JSON.stringify(r));
    },
    toggleFav(name) {
        let f = this.getFavorites();
        if (f.includes(name)) f = f.filter(n => n !== name);
        else f.push(name);
        this.setFavorites(f);
        this.buildTree(this._searchVal || "");
    },

    buildTree(filter) {
        const tree = this.dom.presetTree;
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();
        this._searchVal = filter || '';
        const favs = this.getFavorites();
        const recent = this.getRecent();
        // 分组大标题的显示顺序:不在这里的 tag 会被排到最末尾(99 位),所以新加预设分类时必须登记。
        // 「票根 / 邮票 / 个性」是最近重做的三组,提到最前;其余保持原有顺序(纯工具性的「水印」仍在最后)。
        const order = ['票根', '邮票', '个性', '潮流', '高级感', '艺术', '极简', '胶片', '质感', '手作', '复古', '杂志', '水印', '氛围', '光影'];
        const merge = { 创意: '潮流', 奢华: '高级感', 现代: '极简', 排版: '极简', 影院: '胶片', 星空: '氛围' };
        const groupIcons = {
            潮流: '🪩', 高级感: '💎', 艺术: '🎨', 极简: '⚪', 胶片: '🎞️', 质感: '🪵', 手作: '✂️',
            复古: '📻', 杂志: '📰', 水印: '💧', 氛围: '🌙', 光影: '✨', 比例: '📐', 个性: '🪪',
            票根: '🎫', 其他: '🖼️'
        };
        const iconFor = name => {
            const kw = [
                ['拼贴', '🧩'], ['霓虹', '🪩'], ['光环', '✨'], ['双', '📎'], ['星', '🌌'], ['极光', '🌈'],
                ['渐变', '🌈'], ['边框', '🖼️'], ['白框', '🖼️'], ['卡片', '💳'], ['卡', '🔲'], ['票根', '🎫'],
                ['相机', '📷'], ['胶片', '🎞️'], ['胶卷', '🎞️'], ['电影', '🎬'], ['银幕', '🎬'], ['宽银幕', '🎬'],
                ['撕裂', '💥'], ['双重曝光', '📸'], ['曝光', '📸'], ['杂志', '📰'], ['大刊头', '📰'], ['页眉', '📰'],
                ['封面', '📕'], ['报纸', '📰'], ['海报', '🖼️'], ['波普', '🌀'],
                ['极简', '⚪'], ['简约', '🗒️'], ['细线', '➖'], ['编号', '🔢'], ['日期', '📅'],
                ['复古', '📻'], ['登机牌', '🎫'], ['深色', '🌑'], ['身份卡', '🪪'], ['苹果', '🍎'],
                ['小红', '❤️'], ['cream', '🍰'], ['奶油', '🍰'], ['醒图', '🍰'], ['琉璃', '🍯'],
                ['牛仔', '👖'], ['布纹', '🧵'], ['磨砂', '🌫️'], ['毛玻璃', '🌫️'], ['玻璃', '🪟'],
                ['晨雾', '🌫️'], ['金箔', '🥇'], ['奢华', '👑'], ['丝绒', '🧶'], ['参数', '🔤'],
                ['logo', '🔤'], ['留白', '🌬️'], ['画廊', '🏛️'], ['画框', '🖼️'], ['分层', '🗂️'],
                ['胶片条', '🎞️'], ['比例', '📐'], ['信息条', 'ℹ️'], ['背景模糊', '🌫️'], ['模糊', '🌸']
            ];
            const n = String(name || '');
            for (const [k, ic] of kw) if (n.includes(k)) return ic;
            return '💠';
        };
        const groups = new Map();
        for (const p of this.presets) {
            if (f && !p.templateName.toLowerCase().includes(f) && !(p.templateTag || '').toLowerCase().includes(f)) continue;
            const grp = merge[p.templateTag] || p.templateTag || '其他';
            if (!groups.has(grp)) groups.set(grp, []);
            groups.get(grp).push(p);
        }
        const sorted = [...groups.keys()].sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh');
        });
        const curName = (this.template && this.template.templateName) || '';
        const curGrp = curName ? [...sorted].find(g => (groups.get(g) || []).some(p => p.templateName === curName)) : null;
        const defOpen = curGrp || sorted[0] || null;
        const renderItem = (p, grp) => {
            const item = document.createElement('div');
            item.className = 'preset-item' + (p.templateName === curName ? ' active' : '');
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.textContent = iconFor(p.templateName);
            item.appendChild(dot);
            const label = document.createElement('span');
            label.textContent = p.templateName;
            item.appendChild(label);
            const star = document.createElement('span');
            star.textContent = favs.includes(p.templateName) ? '★' : '☆';
            star.style.cssText = 'margin-left:auto;cursor:pointer;font-size:14px;color:#f59e0b;padding:0 4px;';
            star.title = '收藏/取消收藏';
            star.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFav(p.templateName); });
            item.appendChild(star);
            item.addEventListener('click', () => this.selectPreset(p, item));
            item.dataset.grp = grp;
            return item;
        };
        // 收藏分组
        if (!f || favs.some(n => n.toLowerCase().includes(f))) {
            const favPresets = favs.map(n => this.presets.find(p => p.templateName === n)).filter(Boolean);
            if (favPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group open';
                const nm = document.createElement('div');
                nm.className = 'group-name';
                nm.innerHTML = '<span class="caret">▸</span><span class="g-icon">⭐</span><span>收藏 · ' + favPresets.length + '</span>';
                nm.addEventListener('click', () => gEl.classList.toggle('open'));
                gEl.appendChild(nm);
                favPresets.forEach(p => gEl.appendChild(renderItem(p, '收藏')));
                tree.appendChild(gEl);
            }
        }
        // 最近使用分组
        if (!f) {
            const recPresets = recent.map(n => this.presets.find(p => p.templateName === n)).filter(Boolean);
            if (recPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group open';
                const nm = document.createElement('div');
                nm.className = 'group-name';
                nm.innerHTML = '<span class="caret">▸</span><span class="g-icon">🕐</span><span>最近使用 · ' + recPresets.length + '</span>';
                nm.addEventListener('click', () => gEl.classList.toggle('open'));
                gEl.appendChild(nm);
                recPresets.forEach(p => gEl.appendChild(renderItem(p, '最近使用')));
                tree.appendChild(gEl);
            }
        }
        for (const grp of sorted) {
            const groupEl = document.createElement('div');
            groupEl.className = 'preset-group' + ((f && groups.get(grp).length) || grp === defOpen ? ' open' : '');
            const name = document.createElement('div');
            name.className = 'group-name';
            name.title = '点击展开/收起';
            const caret = document.createElement('span');
            caret.className = 'caret';
            caret.textContent = '\u25B8';
            name.appendChild(caret);
            const gic = document.createElement('span');
            gic.className = 'g-icon';
            gic.textContent = groupIcons[grp] || '🖼️';
            name.appendChild(gic);
            const tag = document.createElement('span');
            tag.textContent = `${grp} · ${groups.get(grp).length}`;
            name.appendChild(tag);
            name.addEventListener('click', () => {
                groupEl.classList.toggle('open');
            });
            groupEl.appendChild(name);
            tree.appendChild(groupEl);
            for (const p of groups.get(grp)) groupEl.appendChild(renderItem(p, grp));
        }
    },
    filterTree(v) { this.buildTree(v); },

    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        this.pushRecent(p.templateName);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
        this.buildTree(this._searchVal || '');
    },

    // 应用预设 = 换「边框方案」,不是换整张图。
    //
    // 旧实现直接 this.template = p,把用户已经加的 logo / 贴纸 / 文字一起丢掉。
    // 实测:先加 logo 再点任意预设,template.logoElements 变空 —— 画布上还留着上一帧的
    // 渲染残影,所以看起来「logo 还在」,但数据已不存在,于是点不中、拖不动、不能放缩。
    //
    // 统计全部 78 个预设:logoElements 字段虽然存在(45 个),但**全部为空数组**,
    // 从不携带 logo;stickers 也恒为 0。唯一例外是 textLines(27 个预设有),
    // 那是预设自带的排版文字(align 为 top/bottom/center 锚点对齐),属于边框方案本身,
    // 应当跟随预设替换。
    //
    // 区分用户文字与预设文字的依据:用户手动加的自由文字 align='free' 且带真实 x/y
    // (app-export.js 导出缩放时也按这个约定区分),预设文字一律是锚点对齐。
    // 因此只保留 align==='free' 的行,预设自带的排版照常跟随预设更新。
    applyPreset(p) {
        const prev = this.template || {};
        const next = JSON.parse(JSON.stringify(p));

        // 用户内容:logo(品牌/自定义图标)与贴纸
        if (Array.isArray(prev.logoElements) && prev.logoElements.length) next.logoElements = JSON.parse(JSON.stringify(prev.logoElements));
        const prevStk = (prev.decorConfig && prev.decorConfig.stickers) || [];
        const prevTxt = (prev.decorConfig && prev.decorConfig.textLines) || [];
        const userFreeTxt = prevTxt.filter(t => t && t.align === 'free');
        const userStk = prevStk.length ? JSON.parse(JSON.stringify(prevStk)) : [];
        const userFree = userFreeTxt.length ? JSON.parse(JSON.stringify(userFreeTxt)) : [];

        // 预设自带的锚点排版文字要保留(它是边框方案的一部分),
        // 但若用户在同一处加过自由文字,则以用户的为准,避免两套文字叠在一起。
        const presetTxt = ((next.decorConfig && next.decorConfig.textLines) || []).filter(t => t && t.align !== 'free');
        const mergedTxt = presetTxt.concat(userFree);
        next.decorConfig = Object.assign({}, next.decorConfig || {}, {});
        if (mergedTxt.length || userStk.length) {
            if (mergedTxt.length) next.decorConfig.textLines = mergedTxt;
            else delete next.decorConfig.textLines;
            if (userStk.length) next.decorConfig.stickers = userStk;
            else delete next.decorConfig.stickers;
        }

        // 签名相关:预设完全没写这个键 = 沿用用户自己的(8 个签名/头像预设就是靠这条
        // 之外的「预设自带值」跑的)。预设显式写出来 = 预设说了算,哪怕写的是空串——
        // 票根/电影票四款用 userSignature:"" + avatarShow:0 表达「本预设默认不带签名/头像」,
        // 此时不能被上一份模板的签名盖回去。0 / '#fff' / 0.85 这些显式值本来就会保留。
        for (const k of ['userSignature', 'signFont', 'signColor', 'avatarScale', 'signSize', 'signIncludeModel', 'avatarShow']) {
            if (prev[k] === undefined) continue;
            if (next[k] === undefined || next[k] === null) next[k] = prev[k];
        }

        this.template = next;
        this.normalizeTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
    },

    resetParams() {
        if (!this.template) return;
        this.pushUndo();
        // 重置后本图不再视为“已用预设”:清理 customSettings 与旧的模板记忆,
        // 否则切走再切回/导出时仍会取到重置前的旧边框
        if (this.image) {
            delete this.image.customSettings;
            this.imageTemplates.delete(this.image);
        }
        this.template = this.defaultTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('参数已重置');
    },

    randomBorder() {
        if (!this.presets.length) return;
        this.pushUndo();
        let p = this.presets[Math.floor(Math.random() * this.presets.length)];
        // 同样保留用户的 logo/贴纸/自由文字,理由见 applyPreset 注释
        this.applyPreset(p);
        this.setStatus(`已应用随机边框：${p.templateName}`);
    },

    syncToSelected() {
        if (this.selectedIdx.length <= 1) { this.setStatus('请先在胶片条中多选需要同步的照片(Ctrl/Shift+点击)'); return; }
        // 源模板 = 当前编辑中模板(含全部最新修改)。不要用 customSettings/imageTemplates 旧快照,
        // 否则第一张带过独立设置/保存过之后,再次修改第一张再点同步仍会同步旧参数
        const applied = JSON.parse(JSON.stringify(this.template));
        if (Array.isArray(applied.logoElements)) applied.logoElements = [];
        if (applied.decorConfig) { delete applied.decorConfig.stickers; delete applied.decorConfig.textLines; }
        delete applied.puzzle;
        let count = 0;
        // 目标 = 除当前编辑图以外的全部选中图。旧写法 slice(1) 假设「选中序列第一张=源」,
        // 但源模板取的是当前编辑图,与 selectedIdx[0] 无关:Ctrl+A 全选时会固定漏掉下标最小的那张
        this.selectedIdx.forEach(i => {
            if (i === this.currentIdx) return;
            const im = this.images[i];
            if (!im) return;
            const tgtSnap = JSON.parse(JSON.stringify(applied));
            // 相机数据与 syncBorderTo 一致:同步只动边框。目标图自己能识别 EXIF → 用自己的;
            // 没有 EXIF 但手动填过 → 保留该图自己的手动参数;都无 → 沿用源图的有效相机数据
            const prev = this.imageTemplates.get(im) || (im.customSettings || null);
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
                const srcAuto = (this.image && this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
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
            im.customSettings = tgtSnap;
            this.imageTemplates.set(im, JSON.parse(JSON.stringify(tgtSnap)));
            this.queueThumb(im);
            count++;
        });
        this.setStatus(`已将当前边框同步到 ${count} 张选中照片（Logo/元素按各图独立记忆）`);
        this.scheduleRender(true);
    }
});
