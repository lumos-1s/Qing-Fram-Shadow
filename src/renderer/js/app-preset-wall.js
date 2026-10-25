// 预设墙启动主页：87 个预设的成片画廊（启动默认显示），点击卡片应用该预设并进入编辑模式。
// 编辑模式无左侧预设树（body.editing 隐藏 #sidebar）；工具栏「预设墙」按钮 / 工作台跳过入口可返回。
// 数据由 tools/gen-preset-wall.js 生成（assets/preset-wall/preset-wall-data.js + covers/）。
// 布局：Bravais 式无限磁贴墙 —— 单块周期网格（9 列 × 10 行 = 90 格，87 张预设循环填充），
// 拖动偏移在 [-周期宽,0]×[-周期高,0] 内取模回绕，墙"没有尽头"；视口中心附近卡片最大最亮。
const _pwWrap = (v, span) => {
    // 把 v 约束/回绕到 [-span, 0]：0 → 0（初始位置不动），超出回绕（墙无尽头）
    if (!span || span <= 0) return 0;
    const m = ((v % span) + span) % span; // 0..span-1
    return m === 0 ? 0 : m - span;
};
window.App = Object.assign(window.App || {}, {
    initPresetWall() {
        if (this._wallBound) return;
        this._wallBound = true;

        const $ = (id) => document.getElementById(id);
        const el = this._wallDom = {
            overlay: $('presetWall'),
            grid: $('presetWallGrid'),
            wall: null,   // wrapper：整墙 transform 平移
            block: null,  // 周期网格块（90 格）
            sub: $('pwSub'),
            skip: $('pwSkip'),
            back: $('btnBackWall'),
            backSep: $('backWallSep')
        };
        if (!el.overlay) return;

        if (el.skip) el.skip.addEventListener('click', () => this.closePresetWall(true));
        if (el.back) el.back.addEventListener('click', () => this.openPresetWall());
        // 键盘：方向键移动选中（上下左右，周期内循环）、Enter / 空格触发卡片
        el.grid.addEventListener('keydown', (e) => {
            const dir = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
            if (dir) { e.preventDefault(); this.moveWallSelection(dir[0], dir[1]); return; }
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            e.preventDefault();
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // Bravais 式无限磁贴墙：周期块平铺 + 拖动取模回绕（无边界），视口中心卡片最显眼
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this._wallBounds = null;
        this._wallSel = { r: 0, c: 0 };
        this._wallFocusTiles = new Set(); // 上一帧处于"中心聚焦"动态态的卡片（用于复位）
        this._wallDrag = { active: false, moved: false, downX: 0, downY: 0, startX: 0, startY: 0 };
        el.grid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const d = this._wallDrag;
            d.active = true; d.moved = false;
            d.downX = e.clientX; d.downY = e.clientY;
            d.startX = this._wallOffsetX; d.startY = this._wallOffsetY;
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
        // 合并处理：按住拖动 → 整墙平移（取模回绕）；未按住 → 卡片倾斜
        el.grid.addEventListener('pointermove', (e) => {
            const d = this._wallDrag;
            const b = this._wallBounds;
            if (d.active && b) {
                const dx = e.clientX - d.downX;
                const dy = e.clientY - d.downY;
                if (!d.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) d.moved = true;
                if (d.moved) {
                    this._wallOffsetX = _pwWrap(d.startX + dx, b.BW);
                    this._wallOffsetY = _pwWrap(d.startY + dy, b.BH);
                    this.applyWallTransform();
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
        // 拖动后不触发点击（拖动产生的 click 由浏览器取消，此处兜底）
        el.grid.addEventListener('click', (e) => {
            if (this._wallDrag.moved) return;
            const tile = e.target.closest('.pw-tile');
            if (!tile) return;
            this.enterEditorFromWall(tile.dataset.idx);
        });
        // 禁用滚轮（浏览统一由按住拖动驱动）
        el.grid.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

        // 窗口变化时重排磁贴墙（周期尺寸 / 卡片尺寸 / 焦点状态自适应）
        this._wallResize = () => this.layoutWallTiles();
        window.addEventListener('resize', this._wallResize);

        this.renderPresetWall();
    },

    // 应用整墙平移（wrapper transform）
    applyWallTransform() {
        const el = this._wallDom;
        const wall = el && el.wall;
        if (!wall) return;
        wall.style.transform = 'translate(' + (this._wallOffsetX || 0).toFixed(1) + 'px, ' + (this._wallOffsetY || 0).toFixed(1) + 'px)';
    },

    // Bravais 式周期布局：单块 9 列 × 10 行 = 90 格（87 张预设循环填充），
    // 块宽高 BW/BH 均大于视口，拖动偏移在 [-BW,0]×[-BH,0] 内取模回绕 → 无缝无限。
    layoutWallTiles() {
        const el = this._wallDom;
        const grid = el && el.grid;
        const block = el && el.block;
        if (!grid || !block) return;
        const vw = grid.clientWidth;
        if (vw <= 0) return;
        const pad = 28, gap = 24, P = 9, Q = 10;
        // 卡片尺寸：视口约显示 3×3 张（Bravais 磁贴墙观感）
        const tw = Math.max(240, Math.min(340, Math.floor((vw - pad * 2 - gap * 2) / 4)));
        const th = Math.round(tw * 1.25);
        const BW = pad * 2 + P * tw + (P - 1) * gap;
        const BH = pad * 2 + Q * th + (Q - 1) * gap;
        this._wallBounds = { pad, gap, tw, th, P, Q, BW, BH };
        block.style.width = BW + 'px';
        block.style.height = BH + 'px';
        block.style.gridTemplateColumns = 'repeat(' + P + ', ' + tw + 'px)';
        block.style.gridTemplateRows = 'repeat(' + Q + ', ' + th + 'px)';
        const tiles = Array.from(block.querySelectorAll('.pw-tile'));
        for (const t of tiles) {
            t.style.width = tw + 'px';
            const img = t.querySelector('.pw-tile-cover img');
            if (img) img.style.height = th + 'px';
        }
        // 偏移保持当前值（可为任意等价周期位置），拖动时由 pointermove 取模回绕
        this.applyWallTransform();
        this.focusWall();
    },

    // 中心聚焦：距离视口中心越近的卡片越大越亮（最中间的图片最显眼），
    // 越往四周越小越暗；倾斜角度（--pw tilt 状态）并入同一 transform。
    focusWall() {
        const el = this._wallDom;
        const grid = el && el.grid;
        const block = el && el.block;
        if (!grid || !block) return;
        const b = this._wallBounds;
        if (!b) return;
        const tiles = Array.from(block.querySelectorAll('.pw-tile'));
        if (!tiles.length) return;
        const vw = grid.clientWidth, vh = grid.clientHeight;
        const cx = vw / 2, cy = vh / 2;
        const ox = this._wallOffsetX || 0, oy = this._wallOffsetY || 0;
        const cxw = cx - ox, cyw = cy - oy; // 视口中心在块坐标系中的位置（块坐标 p 的屏幕位置 = p + offset）
        const maxScale = 1.25, minScale = 0.72;
        const distNorm = Math.max(180, Math.min(b.tw, b.th) * 1.7);
        const tilt = this._wallTilt;
        const cells = block._cells || (block._cells = {});
        const wrap = (v, n) => ((v % n) + n) % n;
        // 中心格
        const rc = Math.round((cxw - b.pad - b.tw / 2) / (b.tw + b.gap));
        const cc = Math.round((cyw - b.pad - b.th / 2) / (b.th + b.gap));
        const active = new Set();
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r = wrap(rc + dr, b.Q);
                const c = wrap(cc + dc, b.P);
                const tile = cells[r + '_' + c];
                if (!tile) continue;
                active.add(tile);
                // 格中心在块坐标系中的位置 → 到视口中心的"最近周期副本"距离
                const wx = b.pad + c * (b.tw + b.gap) + b.tw / 2 + ox;
                const wy = b.pad + r * (b.th + b.gap) + b.th / 2 + oy;
                const dx = wx - cx;
                const dy = wy - cy;
                const ddx = dx - Math.round(dx / b.BW) * b.BW;
                const ddy = dy - Math.round(dy / b.BH) * b.BH;
                const dist = Math.hypot(ddx, ddy);
                const u = Math.min(1, dist / distNorm);
                const s = maxScale - u * (maxScale - minScale);
                const o = 1 - u * 0.65;
                const isTilting = (tilt && tilt.card === tile);
                const rx = isTilting ? tilt.rx : 0;
                const ry = isTilting ? tilt.ry : 0;
                tile.style.transform = 'perspective(760px) scale(' + s.toFixed(3) + ') rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
                tile.style.opacity = o.toFixed(3);
                tile.style.zIndex = String(Math.max(1, Math.round(100 - u * 95)));
            }
        }
        // 复位离开中心区的卡片 → 静态态；倾斜卡若不在中心区则单独保持倾斜
        const prev = this._wallFocusTiles;
        for (const t of prev) {
            if (active.has(t)) continue;
            const isTilting = (tilt && tilt.card === t);
            if (isTilting) {
                t.style.transform = 'perspective(760px) scale(0.72) rotateX(' + tilt.rx.toFixed(2) + 'deg) rotateY(' + tilt.ry.toFixed(2) + 'deg)';
                t.style.opacity = '0.5';
                t.style.zIndex = '1';
            } else {
                t.style.transform = 'scale(0.72)';
                t.style.opacity = '0.5';
                t.style.zIndex = '1';
            }
        }
        this._wallFocusTiles = active;
    },

    // 渲染 90 格周期网格（87 张预设循环填充）：
    // 槽位 i = r*P + c，映射到 preset i % 87 —— 周期网格内容循环，配合取模回绕形成无缝无限墙。
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
        const wall = document.createElement('div');
        wall.className = 'pw-wall';
        const block = document.createElement('div');
        block.className = 'pw-block';
        const b = this._wallBounds || { pad: 28, gap: 24, P: 9, Q: 10, tw: 300, th: 375 };
        const frag = document.createDocumentFragment();
        const cells = {};
        const n = data.items.length;
        for (let r = 0; r < b.Q; r++) {
            for (let c = 0; c < b.P; c++) {
                const slot = r * b.P + c;
                const item = data.items[slot % n];
                const tile = document.createElement('div');
                tile.className = 'pw-tile';
                tile.dataset.cell = r + '_' + c;
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
                // 初始静态态（远离中心时的小卡状态）
                tile.style.transform = 'scale(0.72)';
                tile.style.opacity = '0.5';
                tile.style.zIndex = '1';
                cells[r + '_' + c] = tile;
                frag.appendChild(tile);
            }
        }
        block.replaceChildren(frag);
        block._cells = cells;
        wall.appendChild(block);
        el.grid.replaceChildren(wall);
        el.wall = wall;
        el.block = block;
        this.layoutWallTiles();
        // 墙整体淡入（卡片自身不做动画，transform 由 JS 接管）
        wall.style.animation = 'pwWallIn .55s ease-out both';
        if (el.sub) el.sub.textContent = data.items.length + ' 种预设 · 按住拖动浏览 · 点击卡片进入编辑';
    },

    // 方向键在磁贴墙中移动选中卡片：上下左右 ±1（周期内循环），选中卡片自动滚到视口中心
    moveWallSelection(dr, dc) {
        const el = this._wallDom;
        const grid = el && el.grid;
        const block = el && el.block;
        if (!grid || !block) return;
        const b = this._wallBounds;
        if (!b) return;
        const sel = this._wallSel;
        sel.r = ((sel.r + dr) % b.Q + b.Q) % b.Q;
        sel.c = ((sel.c + dc) % b.P + b.P) % b.P;
        for (const t of block.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
        // 选中格中心（块坐标系）→ 移到视口中心（偏移取模回绕）
        const wx = b.pad + sel.c * (b.tw + b.gap) + b.tw / 2;
        const wy = b.pad + sel.r * (b.th + b.gap) + b.th / 2;
        const cx = grid.clientWidth / 2, cy = grid.clientHeight / 2;
        // 直接居中（offset 可为任意等价周期位置，视觉上选中格永远在视口中心）
        this._wallOffsetX = cx - wx;
        this._wallOffsetY = cy - wy;
        const cells = block._cells || {};
        const target = cells[sel.r + '_' + sel.c];
        if (target) {
            target.classList.add('selected');
            try { target.focus({ preventScroll: true }); } catch (_) {}
        }
        this.applyWallTransform();
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
        this._wallOffsetY = 0;
        this.applyWallTransform();
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
