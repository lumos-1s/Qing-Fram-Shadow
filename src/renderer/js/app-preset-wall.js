// 预设墙启动主页：87 个预设的成片画廊（启动默认显示），点击卡片应用该预设并进入编辑模式。
// 编辑模式无左侧预设树（body.editing 隐藏 #sidebar）；工具栏「预设墙」按钮 / 工作台跳过入口可返回。
// 数据由 tools/gen-preset-wall.js 生成（assets/preset-wall/preset-wall-data.js + covers/）。
window.App = Object.assign(window.App || {}, {
    initPresetWall() {
        if (this._wallBound) return;
        this._wallBound = true;

        const $ = (id) => document.getElementById(id);
        const el = this._wallDom = {
            overlay: $('presetWall'),
            grid: $('presetWallGrid'),
            sub: $('pwSub'),
            skip: $('pwSkip'),
            back: $('btnBackWall'),
            backSep: $('backWallSep')
        };
        if (!el.overlay) return;

        if (el.skip) el.skip.addEventListener('click', () => this.closePresetWall(true));
        if (el.back) el.back.addEventListener('click', () => this.openPresetWall());
        // 键盘：方向键移动选中、Enter / 空格触发卡片
        el.grid.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); this.moveWallSelection(1); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.moveWallSelection(-1); return; }
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            e.preventDefault();
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // folia 式横向焦点墙：图片横向排开溢出屏幕，鼠标按住拖动浏览，最中间的卡片最显眼
        this._wallOffsetX = 0;
        this._wallBounds = null;
        this._wallDrag = { active: false, moved: false, downX: 0, startX: 0 };
        const clampX = (x) => {
            const b = this._wallBounds;
            if (!b) return 0;
            return Math.max(b.minX, Math.min(b.maxX, x));
        };
        el.grid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const d = this._wallDrag;
            d.active = true; d.moved = false;
            d.downX = e.clientX; d.startX = this._wallOffsetX;
            el.grid.classList.add('pw-dragging');
            try { el.grid.setPointerCapture(e.pointerId); } catch (_) {}
        });
        const endDrag = (e) => {
            const d = this._wallDrag;
            if (!d.active) return;
            d.active = false;
            d.moved = false; // 会话结束即重置：拖动产生的 click 由浏览器取消，这里保证后续点击不被误拦
            el.grid.classList.remove('pw-dragging');
            try { el.grid.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        el.grid.addEventListener('pointerup', endDrag);
        el.grid.addEventListener('pointercancel', endDrag);

        // folia 式卡片倾斜：指针下的卡片朝指针方向 3D 倾斜，封面高光跟随指针
        // （机制同 folia exploreTilt；旋转角度并入 focusWall 的 transform，高光变量写 CSS）
        this._wallTilt = { raf: 0, card: null, x: 0, y: 0, rx: 0, ry: 0 };
        const within = (v) => Math.min(1, Math.max(-1, v));
        const tiltRest = () => {
            const t = this._wallTilt;
            if (t.card) { t.card.removeAttribute('data-tilting'); t.card = null; }
            t.rx = 0; t.ry = 0;
            this.focusWall();
        };
        const tiltLean = () => {
            const t = this._wallTilt;
            t.raf = 0;
            const card = t.card;
            if (!card || !card.isConnected) return;
            const box = card.getBoundingClientRect();
            const ax = within((t.x - (box.left + box.width / 2)) / (card.offsetWidth / 2 || 1));
            const ay = within((t.y - (box.top + box.height / 2)) / (card.offsetHeight / 2 || 1));
            const deg = 8;
            t.rx = -ay * deg;
            t.ry = ax * deg;
            card.style.setProperty('--pw-hx', (((ax + 1) / 2) * 100).toFixed(2) + '%');
            card.style.setProperty('--pw-hy', (((ay + 1) / 2) * 100).toFixed(2) + '%');
            this.focusWall();
        };
        // 合并处理：按住拖动 → 整墙平移；未按住 → 卡片倾斜
        el.grid.addEventListener('pointermove', (e) => {
            const d = this._wallDrag;
            if (d.active) {
                const dx = e.clientX - d.downX;
                if (!d.moved && Math.abs(dx) > 4) d.moved = true;
                if (d.moved) {
                    this._wallOffsetX = clampX(d.startX + dx);
                    el.grid.style.transform = 'translateX(' + this._wallOffsetX.toFixed(1) + 'px)';
                    this.focusWall();
                    return;
                }
            }
            const t = this._wallTilt;
            const card = (e.target instanceof Element) ? e.target.closest('.pw-tile') : null;
            if (card !== t.card) {
                tiltRest();
                t.card = card;
                if (card) card.setAttribute('data-tilting', '');
            }
            if (!card) return;
            t.x = e.clientX;
            t.y = e.clientY;
            if (!t.raf) t.raf = requestAnimationFrame(tiltLean);
        });
        el.grid.addEventListener('pointerleave', () => { tiltRest(); });
        // 拖动后不触发点击
        el.grid.addEventListener('click', (e) => {
            if (this._wallDrag.moved) return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // 禁用滚轮（浏览统一由按住拖动驱动）
        el.grid.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

        // 窗口变化时重排封面墙（横向布局 / 卡片尺寸 / 焦点状态自适应）
        this._wallResize = () => this.layoutWallTiles();
        window.addEventListener('resize', this._wallResize);

        this.renderPresetWall();
    },

    // folia 式横向布局：卡片单排横铺、溢出屏幕宽度，视口约显示 5~6 张，
    // 整墙用 transform: translateX 平移（按住拖动浏览），焦点由 focusWall 计算。
    layoutWallTiles() {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid) return;
        const tiles = Array.from(grid.querySelectorAll('.pw-tile'));
        if (!tiles.length) return;
        const vw = grid.clientWidth;
        if (vw <= 0) return;
        const pad = 28;
        const gap = 24;
        // 卡片宽度：视口 1/5.2，clamp 170~300（4:5 方块）
        const tw = Math.max(170, Math.min(300, Math.floor((vw - pad * 2) / 5.2)));
        for (const t of tiles) {
            t.style.width = tw + 'px';
            const img = t.querySelector('.pw-tile-cover img');
            if (img) img.style.height = Math.round(tw * 1.25) + 'px';
        }
        const totalW = pad * 2 + tiles.length * tw + (tiles.length - 1) * gap;
        this._wallBounds = {
            pad, gap, tw, count: tiles.length,
            minX: vw - totalW,          // 拖到最右：最后一张右缘贴视口右缘
            maxX: 0                     // 初始：第一张左缘贴 padding
        };
        // 约束当前偏移并应用
        const b = this._wallBounds;
        this._wallOffsetX = Math.max(b.minX, Math.min(b.maxX, this._wallOffsetX || 0));
        grid.style.transform = 'translateX(' + this._wallOffsetX.toFixed(1) + 'px)';
        this.focusWall();
    },

    // 中心聚焦：距离视口中心越近的卡片越大越亮（最中间的图片最显眼），
    // 越往两侧越小越暗；倾斜角度（--pw tilt 状态）并入同一 transform。
    focusWall() {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid) return;
        const b = this._wallBounds;
        if (!b) return;
        const tiles = grid.querySelectorAll('.pw-tile');
        if (!tiles.length) return;
        const cx = grid.clientWidth / 2;
        const tilt = this._wallTilt;
        const ox = this._wallOffsetX || 0;
        const maxScale = 1.22, minScale = 0.72;
        const distNorm = Math.max(1, cx * 1.1);
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const center = b.pad + i * (b.tw + b.gap) + b.tw / 2 + ox;
            const dist = Math.abs(center - cx);
            const u = Math.min(1, dist / distNorm);
            const s = maxScale - u * (maxScale - minScale);
            const o = 1 - u * 0.65;
            const isTilting = (tilt && tilt.card === t);
            const rx = isTilting ? tilt.rx : 0;
            const ry = isTilting ? tilt.ry : 0;
            t.style.transform = 'perspective(760px) scale(' + s.toFixed(3) + ') rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
            t.style.opacity = o.toFixed(3);
            t.style.zIndex = String(Math.max(1, Math.round(100 - u * 95)));
        }
    },

    // 渲染 87 张预设卡片（数据来自 assets/preset-wall/preset-wall-data.js）
    renderPresetWall() {
        const el = this._wallDom;
        if (!el || !el.grid) return;
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && Array.isArray(window.PRESET_WALL.items))
            ? window.PRESET_WALL
            : null;
        if (!data || !data.items.length) {
            if (el.sub) el.sub.textContent = '预设数据加载失败';
            return;
        }
        const frag = document.createDocumentFragment();
        for (const item of data.items) {
            const tile = document.createElement('div');
            tile.className = 'pw-tile';
            tile.dataset.idx = String(item.i);
            tile.tabIndex = 0;
            tile.setAttribute('role', 'button');
            tile.setAttribute('aria-label', item.name + '，' + item.tag + '，进入编辑');
            const cover = document.createElement('div');
            cover.className = 'pw-tile-cover';
            const img = document.createElement('img');
            img.src = item.cover;
            img.alt = '';
            img.draggable = false;
            cover.appendChild(img);
            tile.appendChild(cover);
            const name = document.createElement('div');
            name.className = 'pw-tile-name';
            name.textContent = item.name;
            tile.appendChild(name);
            const tag = document.createElement('div');
            tag.className = 'pw-tile-tag';
            tag.textContent = item.tag;
            tile.appendChild(tag);
            frag.appendChild(tile);
        }
        el.grid.replaceChildren(frag);
        this.layoutWallTiles();
        // 前 24 张卡片按序淡入（folia 式错落感），其余同时进入
        const fresh = Array.from(el.grid.querySelectorAll('.pw-tile'));
        fresh.forEach((t, i) => {
            if (i < 30) t.style.animationDelay = (i * 14) + 'ms';
        });
        this.layoutWallTiles();
        if (el.sub) el.sub.textContent = data.items.length + ' 种预设 · 按住拖动浏览 · 点击卡片进入编辑';
    },

    // 方向键在横向焦点墙中移动选中卡片：左右 ±1，选中卡片自动滚到视口中心
    moveWallSelection(dirX) {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid) return;
        const tiles = Array.from(grid.querySelectorAll('.pw-tile'));
        const b = this._wallBounds;
        if (!tiles.length || !b) return;
        let idx = tiles.findIndex((t) => t.classList.contains('selected'));
        if (idx < 0) idx = 0;
        const n = Math.max(0, Math.min(tiles.length - 1, idx + dirX));
        for (const t of tiles) t.classList.remove('selected');
        const target = tiles[n];
        target.classList.add('selected');
        try { target.focus({ preventScroll: true }); } catch (_) {}
        // 选中卡片居中
        const cx = grid.clientWidth / 2;
        const center = b.pad + n * (b.tw + b.gap) + b.tw / 2;
        this._wallOffsetX = Math.max(b.minX, Math.min(b.maxX, cx - center));
        grid.style.transform = 'translateX(' + this._wallOffsetX.toFixed(1) + 'px)';
        this.focusWall();
    },

    // 打开预设墙（启动默认显示；工具栏「预设墙」按钮返回时调用）
    openPresetWall() {
        const el = this._wallDom;
        if (!el || !el.overlay) return;
        // 若正处在沉浸展示中，先退出，避免两个全屏层叠在一起
        if (this._immersionOpen && typeof this.closeImmersive === 'function') this.closeImmersive();
        this._wallActive = true;
        el.overlay.hidden = false;
        document.body.classList.add('wall-open');
        document.body.classList.remove('editing');
        if (el.back) el.back.style.display = '';
        if (el.backSep) el.backSep.style.display = '';
        // 回到墙时从头浏览：偏移归零 + 重新布局焦点
        this._wallOffsetX = 0;
        if (el.grid) el.grid.style.transform = 'translateX(0px)';
        this.layoutWallTiles();
    },

    // 关闭预设墙进入编辑工作台
    // workbench=true 表示「跳过」：不应用任何预设，直接进空工作台
    closePresetWall(workbench) {
        const el = this._wallDom;
        if (!el || !el.overlay) return;
        this._wallActive = false;
        el.overlay.hidden = true;
        document.body.classList.remove('wall-open');
        document.body.classList.add('editing');
        const selTiles = el.grid ? el.grid.querySelectorAll('.pw-tile.selected') : [];
        for (const t of selTiles) t.classList.remove('selected');
        if (el.back) el.back.style.display = '';
        if (el.backSep) el.backSep.style.display = '';
        const btnOpen = document.getElementById('btnOpen');
        const focusTarget = (btnOpen && btnOpen.offsetParent) ? btnOpen : this.dom && this.dom.canvas;
        if (focusTarget && typeof focusTarget.focus === 'function') {
            try { focusTarget.focus({ preventScroll: true }); } catch (_) {}
        }
        if (workbench) this.setStatus('已进入工作台，从左侧工具栏导入照片开始');
    },

    // 点击预设卡片：应用该预设并进入编辑模式
    enterEditorFromWall(idx) {
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && window.PRESET_WALL.items)
            ? window.PRESET_WALL.items
            : [];
        const item = data.find((x) => String(x.i) === String(idx));
        if (!item) return;
        const preset = (this.presets || []).find((p) => p._fileName === item.preset);
        if (!preset) {
            if (typeof this.setStatus === 'function') this.setStatus('预设加载失败: ' + item.name);
            return;
        }
        // 有照片：走完整选择链（撤销栈 + 应用 + 最近使用）；无照片：直接替换模板，避免污染撤销栈
        if (this.images && this.images.length) {
            if (typeof this.selectPreset === 'function') this.selectPreset(preset);
            else this.template = JSON.parse(JSON.stringify(preset));
        } else {
            this.template = JSON.parse(JSON.stringify(preset));
        }
        this.closePresetWall(false);
        if (typeof this.setStatus === 'function') this.setStatus('已选择边框：' + item.name + '，导入照片开始编辑');
        if (typeof this.updateEmptyState === 'function') this.updateEmptyState();
    }
});
