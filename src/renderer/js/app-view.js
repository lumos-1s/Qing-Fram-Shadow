// 视图模块：缩放/平移 / 状态栏 / 通用弹窗 / 主题 / 本地用户 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 缩放 / 平移 / 状态栏 / 主题 ══ */
    zoomAt(e, stage, factor) {
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const z0 = this.zoom;
        const z1 = Math.min(3, Math.max(0.1, z0 * factor));
        if (z1 === z0) return;
        const px = (mx - cx - this.panX) / z0;
        const py = (my - cy - this.panY) / z0;
        this.panX = mx - cx - px * z1;
        this.panY = my - cy - py * z1;
        this.setZoom(z1);
    },

    setZoom(z) {
        this.zoom = z;
        this.dom.zoomInput.value = Math.round(z * 100) + '%';
        this.dom.zoomRange.value = Math.round(z * 100);
        this.applyZoomStyle();
    },
    fitZoom() {
        if (!this.image) return;
        // 导出渲染期间不动 CSS/缩放(画布只是临时放大),避免大导出时视图抖动
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const sw = stage.clientWidth - 8, sh = Math.max(60, stage.clientHeight - 8);
        const z = Math.min(sw / canvas.width, sh / canvas.height);
        this.panX = 0; this.panY = 0;
        this.setZoom(Math.max(0.1, z));
    },
    applyZoomStyle() {
        // 导出渲染期间不动 CSS 显示样式(见 fitZoom 守卫)
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        const z = this.zoom;
        // 显示尺寸用逻辑像素(backing/DPR),高分屏不放大,文字保持清晰
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        canvas.style.width = Math.max(1, Math.round(lw * z)) + 'px';
        canvas.style.height = Math.max(1, Math.round(lh * z)) + 'px';
        canvas.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px)`;
    },

    switchTab(name) {
        this.dom.tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        this.dom.panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
        if (name === 'logo') this.renderLogoPools();
        if (name === 'template') this.refreshTemplates();
        if (name === 'puzzle') this.refreshPuzzleUI();
    },

    setupShortcuts() {
        document.addEventListener('keydown', e => {
            // 输入框/文本域聚焦时不触发快捷键(避免打字冲突)
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            // range 滑块(透明度/缩放/旋转)聚焦不算打字:否则拖完滑块按 Delete 删不掉选中元素
            let typing = tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
            if (tag === 'INPUT') {
                const itype = ((document.activeElement.type) || 'text').toLowerCase();
                typing = ['text', 'search', 'number', 'password', 'email', 'url', 'tel'].includes(itype);
            }
            if (typing && !e.ctrlKey) return;

            if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openImages(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
            else if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); this.redo(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                // 有图片时全选缩略图(批量勾选),再按一次取消全选;无图片则回退画布元素全选
                if (this.images && this.images.length) {
                    const allSel = this.images.every((_, i) => this.batchSel.includes(i));
                    this.batchSel = allSel ? [] : this.images.map((_, i) => i);
                    this.selectedIdx = this.batchSel.slice();
                    this.buildThumbnails();
                    this.setStatus(allSel ? '已取消全选' : '已全选 ' + this.images.length + ' 张图片');
                } else {
                    this.selectAllEls();
                }
            }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c') { if (!typing) this.copyElement(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'v') { if (typing) return; e.preventDefault(); this.pasteElement(); }
            else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
                e.preventDefault();
                // 优先处理批量勾选的照片(Ctrl+A 全选后按 Delete = 删掉全部勾选的)。
                // 必须放在最前:selectImage/afterImageSelect 会清空 selectedEls,所以"刚勾选完"
                // 这个时刻画布元素本来也是空的,不会抢走"删元素"的语义;而 >=2 才算批量,
                // 单击缩略图(batchSel 只有 1 项)仍保持原来的行为。
                if (this.batchSel && this.batchSel.length > 1) {
                    this.confirmRemoveImages(this.batchSel.slice());
                    return;
                }
                // 优先删拼图字幕,但必须确认「拼图已启用」且「该槽位真有字幕」。
                //
                // 这里必须走 this.$:本模块被拆成独立 <script> 后,$ 只在 app.js 的
                // 方法作用域里通过 const $ = this.$ 局部引入,setupShortcuts 作用域内
                // 没有裸 $ 绑定 —— 直接写 $('x') 会抛 ReferenceError: $ is not defined。
                //
                // 旧条件只看 this.template.puzzle 对象存在 + gapPick.value 非空,是错的:
                // refreshPuzzleUI 在 _puzzleSlot 为空时会自动把下拉选成 's0'(app-puzzle.js),
                // 于是任何带 puzzle 字段的模板(哪怕拼图根本没启用)都让 gapPick.value 恒为 's0',
                // Delete 就永远走 deleteCaption,画布上选中的元素一个都删不掉。
                // 现象:按 Delete 没反应,状态栏却提示「已删除字幕 S0」。
                const pk = this.template && this.template.puzzle;
                const gapPick = this.$('cbPuzzleGapPick');
                const key = gapPick ? gapPick.value : '';
                // 'v3'/'h3' = 竖/横拼图间隙; 's3' = 第 3 个宫格。取真实字幕值而非仅 key 存在。
                const cap = !key ? null
                    : (/^[vh]\d+$/.test(key) ? (pk && pk.gapCaptions && pk.gapCaptions[key])
                        : (/^s\d+$/.test(key) ? (pk && pk.captions && pk.captions[parseInt(key.substring(1), 10)]) : null));
                if (pk && pk.enabled && cap) {
                    this.deleteCaption();
                } else if (this.selectedEls.length) {
                    this.deleteElement();
                }
            }
            // 新增快捷键
            else if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); this.exportImage(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); this.applyBorderToSelected(); }
            else if (e.ctrlKey && e.key === '0') { e.preventDefault(); this.fitZoom(); }
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveTemplate(); }
            // Compositor 借鉴:选中元素时方向键微移(1px/次,Shift=10px);无选中元素时左右键仍切图
            else if (this.selectedEls && this.selectedEls.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                this.nudgeSelectedPosition(dx, dy);
            }
            else if (e.key === 'ArrowLeft' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx - 1 + this.images.length) % this.images.length); }
            else if (e.key === 'ArrowRight' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx + 1) % this.images.length); }
        });
    },

    // 把当前边框参数应用到所有勾选的照片
    applyBorderToSelected() {
        if (!this.image) { this.setStatus('请先打开一张照片'); return; }
        const targets = (this.batchSel && this.batchSel.length) ? this.batchSel.slice() : [this.currentIdx];
        let n = 0;
        targets.forEach(i => {
            if (i !== this.currentIdx) { this.syncBorderTo(i); n++; }
        });
        this.setStatus(n ? `已把当前边框同步到 ${n} 张选中照片` : '没有需要同步的选中照片(仅当前张)');
    },

    selectAllEls() {
        if (!this.template) return;
        this.selectedEls = [];
        (this.template.logoElements || []).forEach(o => this.selectedEls.push({ kind: 'logo', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.stickers || []).forEach(o => this.selectedEls.push({ kind: 'sticker', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.textLines || []).forEach(o => { if (o.align === 'free') this.selectedEls.push({ kind: 'text', obj: o }); });
        this.refreshElList();
    },

    /* ── 拖拽导入 ── */
    setupDragDrop() {
        const pane = this.dom.canvasPane;
        let depth = 0;
        pane.addEventListener('dragenter', e => { e.preventDefault(); depth++; pane.classList.add('dragging'); });
        pane.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        pane.addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) { depth = 0; pane.classList.remove('dragging'); } });
        pane.addEventListener('drop', e => {
            e.preventDefault(); depth = 0; pane.classList.remove('dragging');
            // 只接受操作系统文件拖放(类型为 "Files");应用内元素(缩略图等)的拖拽不触发重导入
            const types = Array.from(e.dataTransfer && e.dataTransfer.types || []);
            const osDrop = types.some(t => String(t).toLowerCase() === 'files');
            const files = osDrop ? Array.from(e.dataTransfer.files || []) : [];
            if (files.length) this.addImageFiles(files);
        });
    },

    /* 状态栏 / 主题 */
    statusMsg: '',
    setStatus(msg) {
        this.statusMsg = msg;
        this.diagLog && this.diagLog('状态: ' + msg);
        if (this.dom.stCanvas) {
            const m = String(msg || '');
            let level = '';
            if (/失败|错误|不支持|不可用|无法|未找到|未加载|请先|请输入|至少保留|没有可|不存在|异常|缺失|未知原因/.test(m)) level = ' st-err';
            else if (/已|完成|成功/.test(m)) level = ' st-ok';
            this.dom.stCanvas.className = 'st-item grow' + level;
            this.dom.stCanvas.textContent = `画布 ${this.canvasW()}×${this.canvasH()}` + (m ? ` · ${m}` : '');
        }
    },
    canvasW() { return this.dom.canvas ? (this.dom.canvas._logW || this.dom.canvas.width) : 0; },
    canvasH() { return this.dom.canvas ? (this.dom.canvas._logH || this.dom.canvas.height) : 0; },

    // 通用文本输入弹窗(Electron 不支持 window.prompt),resolve 值或 null(取消)
    promptText(title, def) {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.className = 'modal-overlay';
            const card = document.createElement('div');
            card.className = 'modal-card';
            const head = document.createElement('div');
            head.className = 'modal-header';
            const t = document.createElement('div');
            t.className = 'modal-title';
            t.textContent = title || '输入';
            t.style.whiteSpace = 'pre-wrap';
            t.style.lineHeight = '1.5';
            t.style.maxHeight = '40vh';
            t.style.overflow = 'auto';
            const close = document.createElement('button');
            close.className = 'modal-close'; close.textContent = '\u00d7'; close.title = '取消';
            head.appendChild(t); head.appendChild(close);
            const body = document.createElement('div');
            body.className = 'modal-body';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = def || '';
            input.className = 'ctl-tx';
            input.style.cssText = 'width:100%;box-sizing:border-box;font-size:13px;padding:8px 9px;';
            const btns = document.createElement('div');
            btns.className = 'btn-row btn-2';
            btns.style.cssText = 'padding:14px 0 0;';
            const btnCancel = document.createElement('button');
            btnCancel.className = 'mini-btn'; btnCancel.textContent = '取消';
            const btnOk = document.createElement('button');
            btnOk.className = 'mini-btn primary'; btnOk.textContent = '确定';
            btns.appendChild(btnCancel); btns.appendChild(btnOk);
            body.appendChild(input); body.appendChild(btns);
            card.appendChild(head); card.appendChild(body);
            ov.appendChild(card);
            document.body.appendChild(ov);
            const done = v => { document.body.removeChild(ov); resolve(v); };
            const ok = () => done(input.value);
            const cancel = () => done(null);
            btnOk.addEventListener('click', ok);
            btnCancel.addEventListener('click', cancel);
            close.addEventListener('click', cancel);
            ov.addEventListener('mousedown', e => { if (e.target === ov) cancel(); });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') ok();
                if (e.key === 'Escape') cancel();
            });
            input.focus();
            try { input.select(); } catch (_) { /* 忽略 */ }
        });
    },
    updateStatusBar() {
        if (!this.image) { this.setStatus(''); return; }
        const im = this.image;
        this.dom.stRes.textContent = `${im.w}×${im.h}`;
        this.dom.stInfo.textContent = `${this.currentIdx + 1}/${this.images.length} · ${im.name}`;
        this.setStatus(this.statusMsg && !this.statusMsg.startsWith('画布') ? this.statusMsg : '');
    },

    toggleTheme() {
        const root = document.documentElement;
        root.classList.toggle('dark');
    },

    /* ── 登录 / 用户 ── */
    user: null,

    async initLogin() {
        try {
            const u = await window.qingframe.getUser();
            this.user = u;
        } catch (e) {
            this.user = null;
        }
        this.refreshLoginStatus();
    },

    openLoginModal() {
        const d = this.dom;
        d.loginModal.style.display = 'flex';
        if (this.user) {
            d.loginFormView.style.display = 'none';
            d.loginProfileView.style.display = 'block';
            this.renderProfile();
        } else {
            d.loginFormView.style.display = 'block';
            d.loginProfileView.style.display = 'none';
            d.loginUsername.value = '';
            d.loginNickname.value = '';
            setTimeout(() => d.loginUsername.focus(), 60);
        }
    },

    closeLoginModal() {
        this.dom.loginModal.style.display = 'none';
    },

    renderProfile() {
        const d = this.dom;
        const name = (this.user.nickname || this.user.username).trim();
        const av = localStorage.getItem('qfs_user_avatar');
        if (av) { d.loginAvatar.style.background = 'url(' + av + ') center/cover'; d.loginAvatar.textContent = ''; }
        else { d.loginAvatar.style.background = '#444'; d.loginAvatar.textContent = ''; }
        d.loginDisplayName.textContent = name;
        d.loginUsernameDisplay.textContent = '@' + this.user.username;
    },

    async doLogin() {
        const username = this.dom.loginUsername.value.trim();
        if (!username) { this.setStatus('请输入用户名'); return; }
        const nickname = this.dom.loginNickname.value.trim() || username;
        this.user = { username, nickname, createdAt: Date.now() };
        try {
            await window.qingframe.saveUser(this.user);
            this.closeLoginModal();
            this.setStatus(`已登录「${nickname}」`);
        } catch (e) {
            this.setStatus('登录失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    async doLogout() {
        try {
            await window.qingframe.logoutUser();
            this.user = null;
            this.closeLoginModal();
            this.setStatus('已退出登录');
        } catch (e) {
            this.setStatus('退出失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    refreshLoginStatus() {
        const el = this.dom.loginStatus;
        if (this.user) {
            const name = (this.user.nickname || this.user.username).trim();
            el.textContent = name;
            el.classList.add('logged-in');
            el.title = '@' + this.user.username + ' · 点击管理';
        } else {
            el.textContent = '未登录';
            el.classList.remove('logged-in');
            el.title = '点击登录';
        }
    },
});
