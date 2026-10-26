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
// 手感参数照抄 folia-major 的 src/components/wall/wallPanMotion.ts（同值，不另调）：
// - 拖动阈值 7px 才进入拖动，且**超过阈值才 setPointerCapture**（Folia 的 useWallPointerPan 同序）；
//   按下即 capture 会把 click 的 target 改写成容器，是"点一下就跳走"那批 bug 的根源。
// - 松手惯性：framer「inertia」，v*power 就是这一甩的行程，τ 决定尾巴多长。
// - 滚轮：鼠标滚轮按格累加后逐帧追（τ=80ms），触控板增量直接跟手。
// 卡片尺寸系数：1 = 原来的 340px 档（一屏约 3×3），0.7 = 缩 30%（一屏约 5×2.5）。
// 改这一个数就能调密度；调大到盖不住视口之前请确认周期块仍然大于视口（wallWrapSpan 会兜住，但会失去无限感）。
const WALL_CARD_SCALE = 0.7;
const _pwPanCfg = {
    dragThresholdPx: 7,
    // 点选容差：按下到抬起位移不超过它、且时间够短，就算一次点击（哪怕中途已经越过拖动阈值）。
    // 没有这条，手抖 8px 就会变成"拖动"并吞掉 click，用户看到的就是"点模板没反应"。
    clickSlopPx: 12,
    clickSlopMs: 450,
    inertia: { minSpeed: 40, maxSpeed: 4000, power: 0.3, timeConstantMs: 280, restDeltaPx: 0.5, staleReleaseMs: 80 },
    wheel: {
        timeConstantMs: 80, restDistancePx: 0.5, maxFrameMs: 50,
        lineHeightPx: 16, minNotchPx: 50, gestureGapMs: 120
    }
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
        // 换封面：打开 userData/wall-covers，放好图回到窗口时自动刷新（focus 监听在下面）
        const coversBtn = $('pwCovers');
        if (coversBtn) coversBtn.addEventListener('click', async () => {
            const q = window.qingframe || {};
            const toast = window.__showErrToast;
            const say = (msg, bad) => {
                if (typeof this.setStatus === 'function') this.setStatus(msg);
                if (typeof toast === 'function') toast(msg, !!bad);
            };
            // 主进程可能是旧代码（只重载了渲染进程）：preload 有这个方法、主进程却没注册 handler，
            // 直接 invoke 会抛 "No handler registered"，以前会糊一个红色异常给用户。
            if (typeof q.openWallCoversDir !== 'function') {
                say('换封面需要完全退出并重新启动应用（主进程还是旧版本）', true);
                return;
            }
            let r = null;
            try {
                r = await q.openWallCoversDir();
            } catch (e) {
                // 优雅降级：老主进程没有这个 IPC → 退回打开数据目录，并说清下一步
                if (typeof q.openDataDir === 'function') { try { await q.openDataDir(); } catch (_) { /* 忽略 */ } }
                say('主进程还是旧版本：已打开数据目录，在里面新建 wall-covers 文件夹放封面；完全重启应用后「换封面」可一键直达', false);
                return;
            }
            if (r && r.ok) {
                try { localStorage.setItem('qfs_wall_covers_on', '1'); } catch (_) { /* 忽略 */ }
                say('把图片放进封面文件夹，文件名用预设名（如「圆角卡片.webp」）；关掉文件夹回到窗口即自动刷新', false);
            } else if (r && r.message) {
                say('打不开封面目录：' + r.message, true);
            }
        });
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
        this._wallPan = { x: 0, y: 0 };   // 未回绕的平移累计（惯性/滚轮都往这里积分）
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this._wallBounds = null;
        this._wallSel = { r: 0, c: 0 };
        this._wallFocusTiles = new Set(); // 上一帧处于"中心聚焦"动态态的卡片（用于复位）
        this._wallMotion = 0;              // 惯性/滚轮的 rAF 句柄
        this._wallWheelPending = null;     // 滚轮还没走完的位移
        this._wallWheelFrame = 0;
        this._wallWheelGesture = { lastTime: -Infinity, source: null };
        this._wallSwallowClick = false;    // 点击已在 pointerup 处理过，随后补发的 click 要吞掉
        // 系统「减少动态效果」：惯性、3D 倾斜、入场淡入统统关掉，交互退化为直接定位。
        // 监听切换：用户中途改系统设置也立刻生效（顺手清掉正在倾斜的那张卡）。
        this._wallReduceMq = (window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
        this._wallReduceHandler = () => {
            if (!this.wallReducedMotion()) return;
            const t = this._wallTilt;
            if (t && t.card) { t.card.removeAttribute('data-tilting'); t.card = null; }
            if (t) { t.rx = 0; t.ry = 0; }
            this.focusWall();
        };
        if (this._wallReduceMq && this._wallReduceMq.addEventListener) {
            this._wallReduceMq.addEventListener('change', this._wallReduceHandler);
        }
        this._wallDrag = {
            id: null, startX: 0, startY: 0, panX: 0, panY: 0,
            lastX: 0, lastY: 0, lastT: 0, downT: 0, vx: 0, vy: 0, dragging: false
        };
        el.grid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.isPrimary === false && e.pointerType) return; // 多指/次级指针交给主指针
            this.stopWallMotion();
            this._wallSwallowClick = false;
            const d = this._wallDrag;
            d.id = e.pointerId;
            d.startX = e.clientX; d.startY = e.clientY;
            d.panX = this._wallPan.x; d.panY = this._wallPan.y;
            d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = e.timeStamp;
            d.downT = e.timeStamp;
            d.vx = 0; d.vy = 0; d.dragging = false;
            // 这里**不** setPointerCapture：按下时 capture 会把 pointerup/click 的 target
            // 重定向到容器，点击卡片就再也拿不到 .pw-tile。Folia 也是过了阈值才捕获。
        });
        // 卡片是 tabIndex=0 的可聚焦元素。不拦 mousedown 的默认动作，浏览器会在聚焦时
        // 把最近的滚动容器滚到该卡片——`.pw-grid` 虽然 overflow:hidden / clip，旧内核下它
        // 仍是可编程滚动容器，于是整墙视觉上瞬间"跳"到那张卡，而偏移量一动没动。
        // 只拦 mousedown 的默认聚焦：不影响 click，也不影响拖动。
        el.grid.addEventListener('mousedown', (e) => {
            if (e.target instanceof Element && e.target.closest('.pw-tile')) e.preventDefault();
        });
        const endDrag = (e) => {
            const d = this._wallDrag;
            if (d.id === null || d.id !== e.pointerId) return;
            d.id = null;
            el.grid.classList.remove('pw-dragging');
            try { if (el.grid.hasPointerCapture(e.pointerId)) el.grid.releasePointerCapture(e.pointerId); } catch (_) {}
            if (e.type !== 'pointerup') { this._wallSwallowClick = false; return; }
            const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
            const quick = e.timeStamp - d.downT <= _pwPanCfg.clickSlopMs;
            // 点选：位移在容差内且够快 → 当点击处理（并把这几像素的平移抹掉）。
            // 判定放在 pointerup 而不是 click 上，因为越过拖动阈值后浏览器补发的 click
            // 的 target 会被 pointer capture 改写成容器，拿不到卡片。
            if (dist <= _pwPanCfg.clickSlopPx && quick) {
                this.stopWallMotion();
                if (d.dragging) this.panWallTo(d.panX, d.panY);
                this._wallSwallowClick = true;
                const hit = document.elementFromPoint(e.clientX, e.clientY);
                const tile = (hit && hit.closest) ? hit.closest('.pw-tile') : null;
                if (tile) this.enterEditorFromWall(tile.dataset.idx);
                return;
            }
            this._wallSwallowClick = false;
            if (!d.dragging) return;
            // 松手前已经停住（超过 staleReleaseMs 没再采样）就不滑行，免得"静止松手蹭出去一段"
            if (e.timeStamp - d.lastT > _pwPanCfg.inertia.staleReleaseMs) return;
            this.coastWall(d.vx, d.vy);
        };
        el.grid.addEventListener('pointerup', endDrag);
        el.grid.addEventListener('pointercancel', endDrag);
        // 指针在墙外抬起（没越过阈值所以没有 capture）时 grid 收不到 up，手势状态会卡住，
        // 之后滚轮和新的拖动全被挡。窗口兜底一次；重复调用由 d.id 判空挡住。
        const endOutside = (e) => { if (this._wallDrag.id !== null) endDrag(e); };
        window.addEventListener('pointerup', endOutside);
        window.addEventListener('pointercancel', endOutside);
        window.addEventListener('blur', () => this.stopWallMotion());

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
            if (d.id !== null && d.id === e.pointerId && b) {
                const dx = e.clientX - d.startX;
                const dy = e.clientY - d.startY;
                // 7px 阈值：手指/鼠标的微抖不算拖动，否则点击会被自己的抖动判成拖拽
                if (!d.dragging && Math.hypot(dx, dy) > _pwPanCfg.dragThresholdPx) {
                    d.dragging = true;
                    el.grid.classList.add('pw-dragging');
                    try { el.grid.setPointerCapture(e.pointerId); } catch (_) {}
                }
                // 采样松手速度（px/s）：惯性靠它，停住再松手由 staleReleaseMs 判掉
                const dt = e.timeStamp - d.lastT;
                if (dt > 0) {
                    d.vx = (e.clientX - d.lastX) / dt * 1000;
                    d.vy = (e.clientY - d.lastY) / dt * 1000;
                }
                d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = e.timeStamp;
                if (d.dragging) {
                    this.panWallTo(d.panX + dx, d.panY + dy);
                    return;
                }
            }
            // 降级动效时不倾斜：3D 旋转是纯装饰，对前庭敏感的人是负担
            if (this.wallReducedMotion()) {
                if (this._wallTilt.card) tiltRest();
                return;
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
        // 点击：真正的手势已经在 pointerup 里判定并处理（那里才拿得到卡片），
        // 这里只负责两件事——吞掉补发的重复 click，以及处理没有 pointer 序列的合成 click。
        el.grid.addEventListener('click', (e) => {
            if (this._wallSwallowClick) {
                this._wallSwallowClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const tile = (e.target instanceof Element) ? e.target.closest('.pw-tile') : null;
            if (!tile) return;
            this.enterEditorFromWall(tile.dataset.idx);
        }, true);
        // 滚轮：Folia 的墙是可以用滚轮走的。鼠标滚轮按格累加后逐帧追（τ=80ms），
        // 触控板/高分辨率滚轮增量小、自带惯性，直接跟手，否则再平滑一次会发飘。
        el.grid.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) return; // 缩放组合键不夺
            e.preventDefault();
            if (this._wallDrag.id !== null) return;
            const { dx, dy } = this.wallWheelDelta(e);
            if (this.wallReducedMotion()) {
                this.stopWallMotion();
                this.panWallTo(this._wallPan.x - dx, this._wallPan.y - dy);
                return;
            }
            if (this.wallWheelSource(e) === 'trackpad') {
                this.stopWallMotion();
                this.panWallTo(this._wallPan.x - dx, this._wallPan.y - dy);
                return;
            }
            // 只掐惯性，不清 pending：正在平滑的那段滚轮位移要接着累加，否则连滚会一顿一顿
            if (this._wallMotion) { cancelAnimationFrame(this._wallMotion); this._wallMotion = 0; }
            const pending = this._wallWheelPending || { x: 0, y: 0 };
            this._wallWheelPending = { x: pending.x - dx, y: pending.y - dy };
            this.smoothWallWheel();
        }, { passive: false });

        // 窗口变化时重排磁贴墙（周期尺寸 / 卡片尺寸 / 焦点状态自适应）
        this._wallResize = () => this.layoutWallTiles();
        window.addEventListener('resize', this._wallResize);
        // 用户去资源管理器丢完封面再回来：窗口拿到焦点就重新扫一遍封面目录
        this._wallFocusRefresh = () => { if (this._wallActive) this.refreshWallCovers(); };
        window.addEventListener('focus', this._wallFocusRefresh);

        this.renderPresetWall();
    },

    // 用户是否用过「换封面」（用过才值得每次开墙扫一遍目录）
    wallCoversEnabled() {
        try { return localStorage.getItem('qfs_wall_covers_on') === '1'; } catch (_) { return false; }
    },

    // 是否降级动效：系统「减少动态效果」开启时返回 true。
    // _wallReduceOverride 是给自动化用例的开关（可绕过系统设置直接断言降级行为）。
    wallReducedMotion() {
        if (this._wallReduceOverride !== null && this._wallReduceOverride !== undefined) {
            return !!this._wallReduceOverride;
        }
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    },

    // 应用整墙平移（wrapper transform）
    applyWallTransform() {
        const el = this._wallDom;
        const wall = el && el.wall;
        if (!wall) return;
        // 兜底：任何来源（聚焦、旧版本残留、程序化 scrollIntoView）产生的滚动偏移都清零，
        // 否则它会在 transform 之外再叠一层位移，画面和 _wallOffset 对不上。
        const grid = el.grid;
        if (grid && (grid.scrollLeft || grid.scrollTop)) { grid.scrollLeft = 0; grid.scrollTop = 0; }
        // 位移对齐到整设备像素（同 Folia 的 formatWorldTransform）：小数像素会让 Chromium
        // 每帧重栅格化整面墙，平移时会看到细密的抖动。
        const dpr = window.devicePixelRatio || 1;
        const snap = (v) => Math.round((v || 0) * dpr) / dpr;
        // 用 2D translate 而不是 translate3d：3D 变换会强制把整面墙提成一个合成层，
        // 3128×4272 在 DPR=2 下约 440MB 纹理，软件渲染每帧 blit 这个量级就是几十毫秒。
        // 2D 平移不建层，Chromium 只重绘视口内那十几张卡。
        wall.style.transform = 'translate(' + snap(this._wallOffsetX) + 'px, ' + snap(this._wallOffsetY) + 'px)';
    },

    // 回绕跨度 = 一个完整周期 BW/BH。之所以能取满一个周期：墙渲染了 2×2 份相同的块，
    // 偏移落在 (-BW,0] 时总有某一份盖住视口 —— 于是回绕点两侧的画面完全一致（同一批格子同一批图），
    // 拖动时不会出现"跳到别处/像刷新"。之前用 BW-vw 是把块推出视口换来的，代价就是每次拖动都肉眼可见地换一遍内容。
    wallWrapSpan() {
        const b = this._wallBounds;
        if (!b) return { w: 1, h: 1 };
        return { w: Math.max(1, b.BW), h: Math.max(1, b.BH) };
    },

    // 平移到未回绕坐标 (x, y)：累加器保留原值，可见偏移取模回绕 —— 惯性和滚轮都走这里，
    // 这样两者叠加时不会因为回绕跳变而断掉速度。
    panWallTo(x, y) {
        const b = this._wallBounds;
        if (!b) return;
        const span = this.wallWrapSpan();
        this._wallPan = { x, y };
        this._wallOffsetX = _pwWrap(x, span.w);
        this._wallOffsetY = _pwWrap(y, span.h);
        this.applyWallTransform();
        this.focusWall();
    },

    // 停掉惯性 / 滚轮补间：按下、键盘、开关墙都要先停，否则会和新的输入抢相机
    stopWallMotion() {
        if (this._wallMotion) { cancelAnimationFrame(this._wallMotion); this._wallMotion = 0; }
        if (this._wallWheelFrame) { cancelAnimationFrame(this._wallWheelFrame); this._wallWheelFrame = 0; }
        this._wallWheelPending = null;
        const grid = this._wallDom && this._wallDom.grid;
        if (grid) grid.classList.remove('pw-moving');
    },

    // 松手惯性：v*power 是这一甩的总行程，指数衰减（τ=timeConstantMs）走完收敛到 restDeltaPx。
    coastWall(vx, vy) {
        if (this.wallReducedMotion()) return;   // 降级：松手即停，不滑行
        const cfg = _pwPanCfg.inertia;
        const speed = Math.hypot(vx, vy);
        if (!(speed >= cfg.minSpeed)) return;
        const clamped = Math.min(speed, cfg.maxSpeed);
        const ux = vx / speed, uy = vy / speed;
        const distance = clamped * cfg.power;
        const from = { x: this._wallPan.x, y: this._wallPan.y };
        const t0 = performance.now();
        const grid = this._wallDom && this._wallDom.grid;
        // 滑行期间关掉卡片过渡：每帧写 transform 时过渡会再拖出 180ms 尾巴
        if (grid) grid.classList.add('pw-moving');
        let moved = 0;
        const step = (now) => {
            const remain = distance * Math.exp(-(now - t0) / cfg.timeConstantMs);
            moved = distance - remain;
            this.panWallTo(from.x + ux * moved, from.y + uy * moved);
            if (distance - moved > cfg.restDeltaPx) {
                this._wallMotion = requestAnimationFrame(step);
            } else {
                this._wallMotion = 0;
                if (grid) grid.classList.remove('pw-moving');
            }
        };
        this._wallMotion = requestAnimationFrame(step);
    },

    // 滚轮来源判别（同 Folia 的 createWallWheelClassifier）：一次手势里出现过触控板特征，
    // 整次手势都按触控板算——否则快速一划会在惯性峰值被误判成鼠标滚轮。
    wallWheelSource(e) {
        const cfg = _pwPanCfg.wheel;
        const g = this._wallWheelGesture || (this._wallWheelGesture = { lastTime: -Infinity, source: null });
        const sameGesture = e.timeStamp - g.lastTime <= cfg.gestureGapMs;
        g.lastTime = e.timeStamp;
        if (!sameGesture) g.source = null;
        const axis = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
        const trackpad = e.deltaMode === 0 && ((e.deltaX !== 0 && e.deltaY !== 0) || axis < cfg.minNotchPx);
        if (trackpad) g.source = 'trackpad';
        else if (!g.source) g.source = 'wheel';
        return g.source;
    },

    // 滚轮增量换算成像素（按行/按页的模式补齐单位）
    wallWheelDelta(e) {
        const grid = this._wallDom && this._wallDom.grid;
        const k = e.deltaMode === 1 ? _pwPanCfg.wheel.lineHeightPx
            : e.deltaMode === 2 ? (grid ? grid.clientHeight : 800)
                : 1;
        return { dx: e.deltaX * k, dy: e.deltaY * k };
    },

    // 鼠标滚轮平滑：把还没走完的位移每帧追一段（指数逼近，τ=80ms），连续滚动是叠加不是覆盖。
    smoothWallWheel() {
        const cfg = _pwPanCfg.wheel;
        if (this._wallWheelFrame) return;
        const grid = this._wallDom && this._wallDom.grid;
        if (grid) grid.classList.add('pw-moving');
        let last = performance.now();
        const step = (now) => {
            this._wallWheelFrame = 0;
            const pending = this._wallWheelPending;
            if (!pending) { if (grid) grid.classList.remove('pw-moving'); return; }
            const dt = Math.min(cfg.maxFrameMs, Math.max(0, now - last));
            last = now;
            const k = 1 - Math.exp(-dt / cfg.timeConstantMs);
            const mx = pending.x * k, my = pending.y * k;
            pending.x -= mx; pending.y -= my;
            this.panWallTo(this._wallPan.x + mx, this._wallPan.y + my);
            if (Math.abs(pending.x) > cfg.restDistancePx || Math.abs(pending.y) > cfg.restDistancePx) {
                this._wallWheelFrame = requestAnimationFrame(step);
            } else {
                this.panWallTo(this._wallPan.x + pending.x, this._wallPan.y + pending.y);
                this._wallWheelPending = null;
                if (grid) grid.classList.remove('pw-moving');
            }
        };
        this._wallWheelFrame = requestAnimationFrame(step);
    },

    // Bravais 式周期布局：单块 9 列 × 10 行 = 90 格（87 张预设循环填充），整墙铺 2×2 份相同块，
    // 块宽高 BW/BH 均大于视口，偏移在 [-BW,0]×[-BH,0] 内取模回绕 → 无缝无限。
    layoutWallTiles() {
        const el = this._wallDom;
        const grid = el && el.grid;
        const blocks = (el && el.blocks) || [];
        if (!grid || !blocks.length) return;
        const vw = grid.clientWidth;
        if (vw <= 0) return;
        const pad = 28, gap = 24, P = 9, Q = 10;
        // 卡片尺寸：基准是"视口约显示 3×3 张"，再乘 WALL_CARD_SCALE 整体缩放。
        // 0.7 → 340px 档位实际落在 224px，一屏约 5×2.5 张。
        const base = Math.max(240, Math.min(340, Math.floor((vw - pad * 2 - gap * 2) / 4)));
        const tw = Math.round(base * WALL_CARD_SCALE);
        const th = Math.round(tw * 1.25);
        const BW = pad * 2 + P * tw + (P - 1) * gap;
        const BH = pad * 2 + Q * th + (Q - 1) * gap;
        this._wallBounds = { pad, gap, tw, th, P, Q, BW, BH };
        blocks.forEach((block, i) => {
            block.style.width = BW + 'px';
            block.style.height = BH + 'px';
            block.style.gridTemplateColumns = 'repeat(' + P + ', ' + tw + 'px)';
            block.style.gridTemplateRows = 'repeat(' + Q + ', ' + th + 'px)';
            // 2×2：左上角一份在 (0,0)，右/下各偏移一个周期（多出来的两份专门用来填回绕边界）
            block.style.transform = 'translate(' + ((i % 2) * BW) + 'px, ' + (Math.floor(i / 2) * BH) + 'px)';
            const tiles = Array.from(block.querySelectorAll('.pw-tile'));
            for (const t of tiles) {
                t.style.width = tw + 'px';
                const img = t.querySelector('.pw-tile-cover img');
                if (img) img.style.height = th + 'px';
            }
        });
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
        // 与 applyWallTransform 同一条兜底：滚动偏移会让下面的中心距计算整体偏一格。
        if (grid.scrollLeft || grid.scrollTop) { grid.scrollLeft = 0; grid.scrollTop = 0; }
        // 每个格子有 4 个节点（2×2 份拷贝），cells[key] 是节点数组
        const cells = (el && el.cells) || {};
        if (!Object.keys(cells).length) return;
        const vw = grid.clientWidth, vh = grid.clientHeight;
        const cx = vw / 2, cy = vh / 2;
        const ox = this._wallOffsetX || 0, oy = this._wallOffsetY || 0;
        const cxw = cx - ox, cyw = cy - oy; // 视口中心在块坐标系中的位置（块坐标 p 的屏幕位置 = p + offset）
        const maxScale = 1.25, minScale = 0.72;
        const distNorm = Math.max(180, Math.min(b.tw, b.th) * 1.7);
        const tilt = this._wallTilt;
        const wrap = (v, n) => ((v % n) + n) % n;
        // 中心格：列（X 方向）用 tw，行（Y 方向）用 th。这里原来把两者算反了——
        // X 推出列号却当成行号用，等到 _wallOffset 被规整到 [-BW,0] 之后，3×3 动态区
        // 就整体漂到别处，中心那张卡再也拿不到 1.25（test-preset-wall 的"最中间的图片最显眼"会红）。
        const cc = Math.round((cxw - b.pad - b.tw / 2) / (b.tw + b.gap));
        const rc = Math.round((cyw - b.pad - b.th / 2) / (b.th + b.gap));
        const active = new Set();
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r = wrap(rc + dr, b.Q);
                const c = wrap(cc + dc, b.P);
                const list = cells[r + '_' + c];
                if (!list || !list.length) continue;
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
                const z = String(Math.max(1, Math.round(100 - u * 95)));
                // 同一格在 4 份拷贝里各有一个节点，必须给同样的 scale/opacity，
                // 否则回绕那一刻接缝两侧一大一小，看起来就是"闪了一下"。
                for (const tile of list) {
                    active.add(tile);
                    const isTilting = (tilt && tilt.card === tile);
                    const rx = isTilting ? tilt.rx : 0;
                    const ry = isTilting ? tilt.ry : 0;
                    tile.style.transform = 'perspective(760px) scale(' + s.toFixed(3) + ') rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
                    tile.style.opacity = o.toFixed(3);
                    tile.style.zIndex = z;
                }
            }
        }
        // 复位离开中心区的卡片 → 静态态；倾斜卡若不在中心区则单独保持倾斜
        const prev = this._wallFocusTiles;
        for (const t of prev) {
            if (active.has(t)) continue;
            const isTilting = (tilt && tilt.card === t);
            // 离开动态区就撤层，避免层数越攒越多（层只给真正在动的 9 张）
            t.style.willChange = 'auto';
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
        for (const t of active) {
            if (!prev.has(t)) t.style.willChange = 'transform, opacity';
        }
        this._wallFocusTiles = active;
    },

    // 用户自备封面：userData/wall-covers/<预设名>.webp|jpg|png
    // 每次开墙扫一次（只是 readdir + 360 次 src 比对），删掉文件就自动回落内置封面。
    // force=true 时无视「用户用过换封面」的标记（用例用）。
    // 默认不扫：没点过「换封面」的人根本没自定义封面，这次 IPC 纯属浪费，
    // 还会在没注册该 handler 的老测试桩里刷一屏 "No handler registered"。
    async refreshWallCovers(force) {
        const el = this._wallDom;
        if (!el || !el.grid) return 0;
        if (!force && !this.wallCoversEnabled()) return 0;
        if (!window.qingframe || typeof window.qingframe.listWallCovers !== 'function') return 0;
        let covers = {};
        try { covers = await window.qingframe.listWallCovers() || {}; } catch (_) { return 0; }
        let applied = 0;
        for (const tile of el.grid.querySelectorAll('.pw-tile')) {
            const img = tile.querySelector('.pw-tile-cover img');
            if (!img) continue;
            const nameEl = tile.querySelector('.pw-tile-name');
            const name = nameEl ? nameEl.textContent : '';
            const custom = covers[name];
            const want = custom && typeof this.photoUrl === 'function' ? this.photoUrl(custom) : (tile.dataset.cover || '');
            if (!want || img.getAttribute('src') === want) continue;
            img.src = want;
            if (custom) applied++;
        }
        return applied;
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
        const b = this._wallBounds || {
            pad: 28, gap: 24, P: 9, Q: 10,
            tw: Math.round(300 * WALL_CARD_SCALE), th: Math.round(300 * WALL_CARD_SCALE * 1.25)
        };
        const cells = {};
        const blocks = [];
        const n = data.items.length;
        const makeTile = (r, c, copy) => {
            const item = data.items[(r * b.P + c) % n];
            const tile = document.createElement('div');
            tile.className = 'pw-tile';
            tile.dataset.cell = r + '_' + c;
            tile.dataset.idx = String(item.i);
            tile.dataset.cover = item.cover;   // 内置封面，自定义封面撤掉时回落到它
            // 只有第 0 份拷贝参与键盘与无障碍：2×2 份拷贝若都 tabIndex=0，
            // Tab 键要按 360 次才能穿过墙，读屏也会把同一张卡播报四遍。
            // 另外三份是纯视觉填充，焦点/读屏都跳过。
            if (copy === 0) {
                tile.tabIndex = 0;
                tile.setAttribute('role', 'button');
                tile.setAttribute('aria-label', item.name + '，' + item.tag + '，进入编辑');
            } else {
                tile.tabIndex = -1;
                tile.setAttribute('aria-hidden', 'true');
            }
            const cover = document.createElement('div');
            cover.className = 'pw-tile-cover';
            const img = document.createElement('img');
            img.src = item.cover;
            img.alt = '';
            img.draggable = false;
            // 异步解码：90 张封面同步解码会卡住第一次绘制（打开墙时那一下顿）
            img.decoding = 'async';
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
            return tile;
        };
        // 2×2 份相同的块：多出来的三份专门填回绕边界的空白。四份的同一格共用同一张预设，
        // 所以偏移跨过一整周期回绕时，屏幕上的画面逐像素一致 —— 不会"跳一下像刷新"。
        for (let copy = 0; copy < 4; copy++) {
            const block = document.createElement('div');
            block.className = 'pw-block';
            block.dataset.copy = String(copy);
            const frag = document.createDocumentFragment();
            for (let r = 0; r < b.Q; r++) {
                for (let c = 0; c < b.P; c++) {
                    const tile = makeTile(r, c, copy);
                    // 初始静态态（远离中心时的小卡状态）
                    tile.style.transform = 'scale(0.72)';
                    tile.style.opacity = '0.5';
                    tile.style.zIndex = '1';
                    const key = r + '_' + c;
                    (cells[key] || (cells[key] = [])).push(tile);
                    frag.appendChild(tile);
                }
            }
            block.replaceChildren(frag);
            blocks.push(block);
            wall.appendChild(block);
        }
        el.grid.replaceChildren(wall);
        el.wall = wall;
        el.blocks = blocks;
        el.cells = cells;
        el.block = blocks[0]; // 兼容仍按单块取用的地方（选择态、测试）
        this.layoutWallTiles();
        // 墙整体淡入（卡片自身不做动画，transform 由 JS 接管）；降级动效时直接出现
        if (!this.wallReducedMotion()) wall.style.animation = 'pwWallIn .55s ease-out both';
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
        // 键盘接管前先停掉惯性和滚轮补间，不然刚按方向键就被上一甩拽回去
        this.stopWallMotion();
        const sel = this._wallSel;
        sel.r = ((sel.r + dr) % b.Q + b.Q) % b.Q;
        sel.c = ((sel.c + dc) % b.P + b.P) % b.P;
        for (const t of grid.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
        this.centerWallOn(sel.r, sel.c);
    },

    // 把某一格移到视口中心（方向键与「回墙定位当前预设」共用）。
    // select=false 时只居中不加选中框：首次启动没有任何选中项，不该凭空亮一张卡。
    centerWallOn(r, c, select) {
        const el = this._wallDom;
        const grid = el && el.grid;
        const b = this._wallBounds;
        if (!grid || !b) return;
        const wx = b.pad + c * (b.tw + b.gap) + b.tw / 2;
        const wy = b.pad + r * (b.th + b.gap) + b.th / 2;
        const cx = grid.clientWidth / 2, cy = grid.clientHeight / 2;
        const span = this.wallWrapSpan();
        this._wallPan = { x: cx - wx, y: cy - wy };
        this._wallOffsetX = _pwWrap(this._wallPan.x, span.w);
        this._wallOffsetY = _pwWrap(this._wallPan.y, span.h);
        for (const t of grid.querySelectorAll('.pw-tile.selected')) t.classList.remove('selected');
        const targets = (el.cells || {})[r + '_' + c] || [];
        if (select !== false) {
            for (const t of targets) t.classList.add('selected');
            if (targets.length) {
                try { targets[0].focus({ preventScroll: true }); } catch (_) {}
            }
        }
        this.applyWallTransform();
        this.focusWall();
    },

    // 回墙时把选中框落到「当前模板用的那个预设」上：用户不用再满墙找刚才选的是哪张
    selectWallPreset(name) {
        const el = this._wallDom;
        const b = this._wallBounds;
        const data = window.PRESET_WALL;
        if (!el || !el.cells || !b || !data || !Array.isArray(data.items)) return false;
        const key = (s) => String(s || '').replace(/\.json$/i, '').trim();
        const want = key(name);
        if (!want) return false;
        const n = data.items.length;
        const idx = data.items.findIndex((it) => key(it.name) === want || key(it.preset) === want);
        if (idx < 0) return false;
        // 90 格按 slot % n 取预设，找第一个正好显示它的槽位
        let slot = -1;
        for (let s = 0; s < b.P * b.Q; s++) { if (s % n === idx) { slot = s; break; } }
        if (slot < 0) return false;
        this._wallSel = { r: Math.floor(slot / b.P), c: slot % b.P };
        this.centerWallOn(this._wallSel.r, this._wallSel.c);
        return true;
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
        this.stopWallMotion();
        this._wallPan = { x: 0, y: 0 };
        this._wallOffsetX = 0;
        this._wallOffsetY = 0;
        this.applyWallTransform();
        this.layoutWallTiles();
        // 回墙先把选中框落到「当前图正在用的预设」上：找回来不用满墙翻。
        // 没选过预设（默认模板）就把视口中心对齐到最近一格 —— 否则偏移为 0 时中心正好落在
        // 格间隙上，首屏那张卡只有 1.05，看起来"中心放大没生效"。
        const current = (this.template && this.template.templateName) || '';
        if (!current || !this.selectWallPreset(current)) {
            const b = this._wallBounds;
            if (b && el.grid) {
                const cc = Math.round((el.grid.clientWidth / 2 - b.pad - b.tw / 2) / (b.tw + b.gap));
                const rc = Math.round((el.grid.clientHeight / 2 - b.pad - b.th / 2) / (b.th + b.gap));
                this.centerWallOn(((rc % b.Q) + b.Q) % b.Q, ((cc % b.P) + b.P) % b.P, false);
            }
            try { el.grid.focus({ preventScroll: true }); } catch (_) {}
        }
        // 每次开墙扫一次自定义封面（用户可能在别的窗口刚放好图）
        this.refreshWallCovers();
    },

    // 关闭预设墙进入编辑工作台
    // workbench=true 表示「跳过」：不应用任何预设，直接进空工作台
    closePresetWall(workbench) {
        const el = this._wallDom;
        if (!el || !el.overlay) return;
        this._wallActive = false;
        el.overlay.hidden = true;
        // 关墙时惯性可能还在跑，留着会在下次打开时突然自己滑一下
        this.stopWallMotion();
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
    async enterEditorFromWall(idx) {
        const data = (typeof window.PRESET_WALL === 'object' && window.PRESET_WALL && window.PRESET_WALL.items)
            ? window.PRESET_WALL.items
            : [];
        const item = data.find((x) => String(x.i) === String(idx));
        if (!item) return;
        // 墙数据里的 preset 是"参数横条.json"，而主进程 list-presets / load-all-presets 返回的
        // name 是**不带扩展名**的"参数横条"，App.presets[]._fileName 跟着这个名字走。
        // 之前用 === 硬比，永远不命中 → 点卡片静默 return，界面上就是"没反应"。
        const key = (s) => String(s || '').replace(/\.json$/i, '').trim();
        // 启动头一秒 preset 还在加载：此时点卡片会"点了没反应"。等它就绪再继续。
        if (!(this.presets || []).length && this._presetsReady) {
            try { await this._presetsReady; } catch (_) { /* 加载失败走下面的提示 */ }
        }
        const preset = (this.presets || []).find((p) => key(p._fileName) === key(item.preset));
        if (!preset) {
            // 静默失败最坑：状态栏在墙底下，用户只会看到"点了没反应"。用全局 toast 直接说到脸上。
            const msg = '预设加载失败：' + item.name;
            if (typeof window.__showErrToast === 'function') window.__showErrToast(msg, true);
            if (typeof this.setStatus === 'function') this.setStatus(msg);
            return;
        }
        // 统一入口：有照片就立刻套到当前图（撤销栈 + 保留用户元素），没照片就记为待应用，
        // 等导入时由 importPicked 复制给每张新图。墙和侧栏共用同一条逻辑。
        if (typeof this.applyPresetToCurrent === 'function') this.applyPresetToCurrent(preset);
        else this.template = JSON.parse(JSON.stringify(preset));
        this.closePresetWall(false);
        const hasPhoto = !!(this.images && this.images.length);
        if (typeof this.setStatus === 'function') {
            this.setStatus(hasPhoto
                ? '已套用边框：' + item.name
                : '已选择边框：' + item.name + '，导入照片开始编辑');
        }
        if (typeof this.updateEmptyState === 'function') this.updateEmptyState();
    }
});
