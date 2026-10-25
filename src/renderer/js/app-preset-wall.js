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
        el.grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // 键盘：方向键移动选中、Enter / 空格触发卡片
        el.grid.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); this.moveWallSelection(1, 0); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.moveWallSelection(-1, 0); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.moveWallSelection(0, 1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); this.moveWallSelection(0, -1); return; }
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            e.preventDefault();
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // folia 式鼠标浏览：不用滚轮下滑，鼠标在网格内移动驱动整墙平滑滚动
        // （鼠标位于顶部→看最上，中部→对应位置，底部→看最下；移出网格即停）
        this._wallHoverScroll = { raf: 0, target: 0, active: false };
        el.grid.addEventListener('mouseleave', () => { this._wallHoverScroll.active = false; });
        el.grid.addEventListener('mousemove', (e) => {
            const hs = this._wallHoverScroll;
            hs.active = true;
            const r = el.grid.getBoundingClientRect();
            const t = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
            hs.target = t * Math.max(0, el.grid.scrollHeight - el.grid.clientHeight);
            if (hs.raf) return;
            const step = () => {
                if (!hs.active || !el.grid) { hs.raf = 0; return; }
                const diff = hs.target - el.grid.scrollTop;
                if (Math.abs(diff) > 0.5) {
                    el.grid.scrollTop += diff * 0.14;
                    hs.raf = requestAnimationFrame(step);
                } else {
                    el.grid.scrollTop = hs.target;
                    hs.raf = 0;
                }
            };
            hs.raf = requestAnimationFrame(step);
        });
        // 禁用滚轮下滑滚动（浏览统一由鼠标位置驱动）
        el.grid.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

        // folia 式卡片倾斜：指针下的卡片朝指针方向 3D 倾斜，封面高光跟随指针
        // （机制同 folia exploreTilt：每帧把指针相对卡片的位置写成 CSS 变量，画法在 style.css）
        this._wallTilt = { raf: 0, card: null, x: 0, y: 0 };
        const within = (v) => Math.min(1, Math.max(-1, v));
        const tiltRest = () => {
            const t = this._wallTilt;
            if (t.card) { t.card.removeAttribute('data-tilting'); t.card = null; }
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
            card.style.setProperty('--pw-rx', (-ay * deg).toFixed(2) + 'deg');
            card.style.setProperty('--pw-ry', (ax * deg).toFixed(2) + 'deg');
            card.style.setProperty('--pw-hx', (((ax + 1) / 2) * 100).toFixed(2) + '%');
            card.style.setProperty('--pw-hy', (((ay + 1) / 2) * 100).toFixed(2) + '%');
        };
        el.grid.addEventListener('pointermove', (e) => {
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
        el.grid.addEventListener('pointerleave', tiltRest);

        // 窗口变化时重排封面墙（列数 / 卡片宽度 / 封面高度自适应）
        this._wallResize = () => this.layoutWallTiles();
        window.addEventListener('resize', this._wallResize);

        this.renderPresetWall();
    },

    // 封面墙自适应布局：flex-wrap 下按容器宽度计算列数与卡片宽度，
    // 显式设置 tile 宽与封面高（4:5 方块）。grid auto 行高对 aspect-ratio / 百分比高度
    // 的 max-content 计算在 Chromium 中会塌陷为单行文字高度，故改用 flex-wrap + 显式尺寸。
    layoutWallTiles() {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid) return;
        const tiles = Array.from(grid.querySelectorAll('.pw-tile'));
        if (!tiles.length) return;
        const gap = 16;
        const W = grid.clientWidth;
        if (W <= 0) return;
        // 紧凑铺满：7~10 列，150px 基准宽度（大卡片近半，一屏 3 行多）
        const cols = Math.max(7, Math.min(10, Math.floor((W + gap) / (150 + gap))));
        const tw = Math.floor((W - (cols - 1) * gap) / cols);
        for (const t of tiles) {
            t.style.width = tw + 'px';
            const img = t.querySelector('.pw-tile-cover img');
            if (img) img.style.height = Math.round(tw * 1.25) + 'px';
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
        if (el.sub) el.sub.textContent = data.items.length + ' 种预设 · 点击卡片进入编辑 · 滚动浏览';
    },

    // 方向键在封面墙中移动选中卡片（folia 式选中框）
    moveWallSelection(dirX, dirY) {
        const el = this._wallDom;
        const grid = el && el.grid;
        if (!grid) return;
        const tiles = Array.from(grid.querySelectorAll('.pw-tile'));
        if (!tiles.length) return;
        let idx = tiles.findIndex((t) => t.classList.contains('selected'));
        if (idx < 0) idx = 0;
        const gap = 16;
        const cols = Math.max(1, Math.round((grid.clientWidth + gap) / (tiles[0].offsetWidth + gap)));
        let n = idx;
        if (dirX === -1) n = (idx % cols === 0) ? idx : idx - 1;
        else if (dirX === 1) n = (idx % cols === cols - 1 || idx === tiles.length - 1) ? idx : idx + 1;
        else if (dirY === -1) n = (idx - cols >= 0) ? idx - cols : idx;
        else if (dirY === 1) n = (idx + cols < tiles.length) ? idx + cols : idx;
        for (const t of tiles) t.classList.remove('selected');
        const target = tiles[n];
        target.classList.add('selected');
        try { target.focus({ preventScroll: true }); } catch (_) {}
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
        if (el.grid) el.grid.scrollTop = 0;
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
