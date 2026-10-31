'use strict';
/* 基础调色：曝光 / 对比度 / 饱和度 / 色温 / 色调 / 高光 / 阴影 / 白色 / 黑色
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 不逐像素。Chromium 的 ctx.filter 是原生实现（GPU 或有优化的 CPU 路径），
 *    实测 2400×1600 一次全滤镜约 25ms（--use-gl=swiftshader 纯软件渲染），
 *    逐像素 JS 同尺寸要 300ms 以上，拖滑块根本没法用。
 * 2) 原则上不逐像素、不上 WebGL。例外是混色器（app-mix.js）：按色相选区
 *    的调整权重取决于每个像素自己的色相，是三维操作，逐通道 LUT 表达不了，
 *    用 WebGL 单 pass 做烘焙**前置级**（原图 → GL 混色 → ctx.filter 其余），
 *    GL 不可用时自动退回原图、混色器禁用，其余档位不受影响。
 * 3) 一次性「烘焙」到离屏画布，渲染时正常 drawImage 缓存。
 *    渲染热路径因此完全不带滤镜 —— engine.js 里特别强调过「裁剪态下
 *    drawImage 会走慢路径」，叠加滤镜只会更糟。烘焙只在参数变化时发生一次。
 * 4) 色温 / 色调 / 高光 / 阴影 用 SVG feComponentTransfer 的 256 项 table
 *    表达（合并成每通道一条曲线，一次过）；曝光/对比度/饱和度用原生函数式
 *    滤镜。二者可以混写在同一个 filter 字符串里，已实测生效。
 * 5) 自然饱和度与颜色分级依赖像素自己的饱和度/亮度，逐通道 LUT 表达不了，
 *    用 WebGL 后置单 pass（app-color-grade.js）；GL 不可用时退回 Canvas2D
 *    逐像素兼容路径。
 *
 * 借鉴来源：fabric.js 的 BaseFilter 分组（brightness/contrast/saturation/
 * hueRotation 的取值域与「0 为不变」约定），以及 glfx.js 的 vibrance/tone
 * 曲线思路。但最终实现换成浏览器原生滤镜，因为本项目只跑 Electron/Chromium。
 */
(function () {
    const GRADE_FILTER_ID = 'qfsGradeLut';
    const LUT_N = 256;
    // 三维表走小网格的尺寸上限：预览（含拖动时的降采样）在此之下用 25³
    const GRID_PREVIEW_MAX = 1700;
    // 高光/阴影用**平滑窗**而不是钟形：钟形 v(1-v)² 的翼太宽，
    // 满档会把中灰 128 压到 37（LR 只到约 122），整张预设看起来"大相径庭"。
    // 窗只覆盖两端，中间调基本为零位移，这才是 LR「高光/阴影」的语义。
    const SH_AMP = 0.16;   // 阴影满档时暗部最大位移（0 → +41）
    const HI_AMP = 0.24;   // 高光满档时亮部最大位移（230 → ~181，LR −100 实测量级）
    const HI_KNEE = 0.45;  // 高光窗下沿：低于此亮度完全不受影响
    const HI_TOP = 0.97;   // 高光窗上沿回落的起点：只有纯白/镜面高光才保住
    const LO_KNEE = 0.55;  // 阴影窗上沿：高于此亮度完全不受影响
    const T_AMP = 0.10;    // 色温满档时中间调最大位移
    const TINT_AMP = 0.075; // 色调满档时中间调最大位移（品红/绿轴）
    const CB_AMP = 0.11;    // 色彩平衡满档时该通道的位移（约 28 级/255）
    // 选中蒙版时，这些键改的是蒙版参数；其余键永远是全局
    const MASK_ROUTE_KEYS = ['exp', 'con', 'sat', 'vib', 'temp', 'tint', 'hi', 'sh', 'white', 'black', 'gam'];
    const LOW_EDGE = 1600; // 拖动过程中的降采样长边
    const FULL_EDGE = 0;   // 静止后的成品：0 = 按原图尺寸，不降采样
                           // （降采样会让导出的「原图」档位拿不到真实长边，宁可多占内存）
    const LRU_MAX = 4;     // 同时保留的烘焙缓存张数（24MP 一张约 96MB）

    const GRADE_FIELDS = [
        { k: 'exp', label: '曝光', min: -5, max: 5, step: 0.01, hint: 'EV：±5 档，1.00 = 一倍亮度' },
        { k: 'con', label: '对比度', min: -100, max: 100, hint: '明暗反差' },
        { k: 'sat', label: '饱和度', min: -100, max: 100, hint: '-100 为黑白' },
        { k: 'vib', label: '自然饱和度', min: -100, max: 100, hint: '优先保护已经鲜艳的颜色' },
        { k: 'temp', label: '色温', min: -100, max: 100, hint: '左冷右暖' },
        { k: 'tint', label: '色调', min: -100, max: 100, hint: '左绿右品红（与 LR 同向）' },
        { k: 'hi', label: '高光', min: -100, max: 100, hint: '只动亮部' },
        { k: 'sh', label: '阴影', min: -100, max: 100, hint: '只动暗部' },
        { k: 'white', label: '白色', min: -100, max: 100, hint: '白点：正档高光并合、负档压暗亮部' },
        { k: 'black', label: '黑色', min: -100, max: 100, hint: '黑点：正档抬黑起雾、负档压死暗部' },
        // 色阶的中间调（PS/LR 的 Levels 第二根三角）。与「对比度」不同：
        // 它只抬/压中间调，两端锚死，所以能在不动黑白场的前提下改通透度。
        { k: 'gam', label: '中间调', min: -100, max: 100, hint: '只抬/压中间调，两端不动（色阶 gamma）' }
    ];

    // ── 颜色分级（对齐 LR 的 3 向 + 全局） ─────────────────────────
    // hue 0..360，sat 0..100，lum -100..100；blending 0..100，balance -100..100。
    const CG_ZONES = [
        { k: 'shadow', label: '阴影' },
        { k: 'mid', label: '中间调' },
        { k: 'high', label: '高光' },
        { k: 'global', label: '全局' }
    ];
    function defaultCgZone() { return { h: 0, s: 0, l: 0 }; }
    function defaultCg() {
        return {
            shadow: defaultCgZone(), mid: defaultCgZone(),
            high: defaultCgZone(), global: defaultCgZone(),
            blending: 50, balance: 0
        };
    }
    function sanitizeCg(c) {
        if (!c || typeof c !== 'object') return null;
        const out = defaultCg();
        let any = false;
        for (const z of CG_ZONES) {
            const v = c[z.k] || {};
            const h = Number(v.h), s = Number(v.s), l = Number(v.l);
            out[z.k] = {
                h: Number.isFinite(h) ? Math.max(0, Math.min(360, Math.round(h))) : 0,
                s: Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : 0,
                l: Number.isFinite(l) ? Math.max(-100, Math.min(100, Math.round(l))) : 0
            };
            // 色相单独存在也要留住：色相本身不产生颜色（还要饱和度），但用户通常
            // 先定色相再拉饱和度。这里只看 s/l 的话，一拖色相整组就被判空 → cg 变
            // null → 滑块弹回 0，「色相拉不动」就是这么来的。
            if (out[z.k].h || out[z.k].s || out[z.k].l) any = true;
        }
        const b = Number(c.blending), ba = Number(c.balance);
        out.blending = Number.isFinite(b) ? Math.max(0, Math.min(100, Math.round(b))) : 50;
        out.balance = Number.isFinite(ba) ? Math.max(-100, Math.min(100, Math.round(ba))) : 0;
        return any ? out : null;
    }
    function cgActive(c) {
        if (!c) return false;
        for (const z of CG_ZONES) {
            const v = c[z.k];
            if (v && (Number(v.s) || Number(v.l))) return true;
        }
        return false;
    }

    // ── 色彩平衡（PS 的 Color Balance：三区 × 三轴） ─────────────
    // 每区 r/g/b ∈ [-100,100]，分别对应「青↔红 / 洋红↔绿 / 黄↔蓝」。
    // 走同一条 256 项 LUT（不需要 GL），分区权重与颜色分级同一套形态。
    const CB_ZONES = [
        { k: 'shadow', label: '阴影' },
        { k: 'mid', label: '中间调' },
        { k: 'high', label: '高光' }
    ];
    const CB_AXES = [
        { k: 'r', label: '青 ↔ 红' },
        { k: 'g', label: '洋红 ↔ 绿' },
        { k: 'b', label: '黄 ↔ 蓝' }
    ];
    function defaultCbZone() { return { r: 0, g: 0, b: 0 }; }
    function defaultCb() {
        return { shadow: defaultCbZone(), mid: defaultCbZone(), high: defaultCbZone(), preserve: 1 };
    }
    function sanitizeCb(c) {
        if (!c || typeof c !== 'object') return null;
        const out = defaultCb();
        let any = false;
        for (const z of CB_ZONES) {
            const v = c[z.k] || {};
            for (const a of CB_AXES) {
                const n = Number(v[a.k]);
                out[z.k][a.k] = Number.isFinite(n) ? Math.max(-100, Math.min(100, Math.round(n))) : 0;
                if (out[z.k][a.k]) any = true;
            }
        }
        out.preserve = c.preserve === 0 ? 0 : 1;
        return any ? out : null;
    }
    function cbActive(c) {
        if (!c) return false;
        for (const z of CB_ZONES) {
            const v = c[z.k];
            if (v && (Number(v.r) || Number(v.g) || Number(v.b))) return true;
        }
        return false;
    }

    // ── 渐变映射（PS 的 Gradient Map） ───────────────────────────
    // 用亮度索引一条两色渐变，再按 amount 与原图混合。比「颜色分级」粗，
    // 但它是整条亮度标尺统一映射，做单色调/双色分离最快。
    function defaultGm() { return { on: 1, dark: '#101a33', light: '#ffd9a0', amount: 100 }; }
    function normHex(v, dft) {
        const s = String(v || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
        return dft;
    }
    function sanitizeGm(v) {
        if (!v || typeof v !== 'object') return null;
        const out = defaultGm();
        out.dark = normHex(v.dark, out.dark);
        out.light = normHex(v.light, out.light);
        const a = Number(v.amount);
        out.amount = Number.isFinite(a) ? Math.max(0, Math.min(100, Math.round(a))) : 100;
        out.on = v.on === 0 ? 0 : 1;
        return (out.on && out.amount > 0) ? out : null;
    }
    function gmActive(v) { return !!(v && v.on !== 0 && (Number(v.amount) || 0) > 0); }
    function hexToRgb(h) {
        const s = normHex(h, '#000000');
        return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
    }

    // ── 镜头校正（目前只做畸变） ─────────────────────────────────
    // distort>0 校正桶形（把外围往里收），<0 校正枕形。几何重采样只能在
    // GL pass 里做（Canvas2D 逐像素重采样没有双线性插值，边缘会锯齿）。
    function defaultLc() { return { distort: 0 }; }
    function sanitizeLc(v) {
        if (!v || typeof v !== 'object') return null;
        const d = Number(v.distort);
        const out = { distort: Number.isFinite(d) ? Math.max(-100, Math.min(100, Math.round(d))) : 0 };
        return out.distort ? out : null;
    }
    function lcActive(v) { return !!(v && Number(v.distort)); }

    // ── 蒙版组合模式（PS/LR 的 Add / Subtract / Intersect）─────────
    // 一个「组」= 一个 new 蒙版 + 后续若干 add/subtract/intersect 成员，
    // 整组共用组首的参数、共用一条烘焙层。这样「修边缘」不用重画整个蒙版。
    const MASK_MODES = [
        { k: 'new', label: '新建', title: '独立的调整层（用自己的参数）' },
        { k: 'add', label: '添加', title: '并进上一个蒙版的生效范围' },
        { k: 'subtract', label: '减去', title: '从上一个蒙版里挖掉这块' },
        { k: 'intersect', label: '相交', title: '只保留与上一个蒙版重叠的部分' }
    ];
    function maskGroups(masks) {
        const list = Array.isArray(masks) ? masks : [];
        const groups = [];
        for (const m of list) {
            if (!m) continue;
            const mode = (m.mode && m.mode !== 'new' && groups.length) ? m.mode : 'new';
            if (mode === 'new') groups.push({ head: m, members: [m] });
            else groups[groups.length - 1].members.push(m);
        }
        return groups;
    }

    // ── 扩展档位（对齐 LR 的「细节 / 校准 / 混色器」） ──────────────
    const DET_FIELDS = [
        { k: 'clar', label: '清晰度', hint: '中间调立体感' },
        { k: 'tex', label: '纹理', hint: '表面细节' },
        { k: 'dhz', label: '去除薄雾', hint: '通透度：按 Camera Raw 的雾色反演，正档去雾、负档加雾' }
    ];
    const CAL_FIELDS = [
        { k: 'rh', label: '红·色相' }, { k: 'rs', label: '红·饱和' },
        { k: 'gh', label: '绿·色相' }, { k: 'gs', label: '绿·饱和' },
        { k: 'bh', label: '蓝·色相' }, { k: 'bs', label: '蓝·饱和' }
    ];
    // LR 混色器的 8 个色相带；hw = 权重过渡带宽（约取相邻带间距的一半再放宽一点）
    const MIX_BANDS = [
        { k: 'r', label: '红色', hue: 0, hw: 30 },
        { k: 'o', label: '橙色', hue: 30, hw: 25 },
        { k: 'y', label: '黄色', hue: 60, hw: 25 },
        { k: 'g', label: '绿色', hue: 120, hw: 40 },
        { k: 'a', label: '浅绿色', hue: 180, hw: 40 },
        { k: 'b', label: '蓝色', hue: 240, hw: 40 },
        { k: 'p', label: '紫色', hue: 285, hw: 32 },
        { k: 'm', label: '洋红', hue: 320, hw: 27 }
    ];
    const MIX_METRICS = [
        { k: 'h', label: '色相' }, { k: 's', label: '饱和度' }, { k: 'l', label: '明亮度' }
    ];

    // ── 黑白混色器（对齐 LR / PS 的 Black & White：8 色相带各自调亮调暗）──
    // 色带中心复用混色器那套（0/30/60/120/180/240/285/320），LR 的 GrayMixer 就是这 8 个。
    // XMP 里 ConvertToGrayscale + GrayMixerRed…Magenta 以前整组进 skipped，导进来等于没生效。
    const BW_BANDS = MIX_BANDS;
    const BW_KEYS = ['r', 'o', 'y', 'g', 'a', 'b', 'p', 'm'];
    function defaultBw() {
        const b = { on: 1 };
        for (const k of BW_KEYS) b[k] = 0;
        return b;
    }
    function sanitizeBw(v) {
        if (!v || typeof v !== 'object') return null;
        if (v.on === 0) return null;
        const out = defaultBw();
        for (const k of BW_KEYS) {
            const n = Number(v[k]);
            out[k] = Number.isFinite(n) ? Math.max(-100, Math.min(100, Math.round(n))) : 0;
        }
        // 注意：不能因为「8 个滑块都是 0」就返回 null —— 勾了黑白本身就是一次灰度转换，
        // 全 0 等于标准灰度（LR 里也是这样），返回 null 会让开关刚勾上就自己弹回去。
        return out;
    }
    function bwActive(v) { return !!(v && v.on !== 0); }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function bell(x) { return 4 * x * (1 - x); }
    // 三区分权重：阴影/中间调/高光，边界 0.33/0.66、过渡带 0.12（与颜色分级的
    // 默认形态一致）。返回已归一化的三元组。
    function cbWeights(y) {
        const lo = 0.33, hi = 0.66, soft = 0.12;
        let wS = 1 - smoothstep(lo - soft, lo + soft, y);
        let wH = smoothstep(hi - soft, hi + soft, y);
        let wM = Math.max(0, 1 - wS - wH);
        const sum = wS + wM + wH;
        if (sum > 1e-6) { wS /= sum; wM /= sum; wH /= sum; }
        return [wS, wM, wH];
    }
    function smoothstep(a, b, x) {
        if (a === b) return x < a ? 0 : 1;
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    }
    // sRGB ↔ 线性光：曝光必须在线上乘，否则 +1EV 会把 sRGB 128 直接推到 255。
    function srgbToLinear(v) {
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    function linearToSrgb(v) {
        return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    }

    // ── SVG 滤镜（单例，改参数只换属性/重建子节点，不重复建 DOM） ──
    // 链路：feComponentTransfer(色温/高光/阴影/曲线/薄雾黑场) → feColorMatrix(校准)
    //       → feGaussianBlur+feComposite(纹理 USM) → 同(清晰度 USM)
    // 各级都可选：参数为 0 时该级不进链，烘焙成本不涨。
    let _filterEl = null, _ctEl = null, _chainSig = '';
    function ensureFilter() {
        if (_filterEl) return _filterEl;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden';
        const f = document.createElementNS(ns, 'filter');
        f.setAttribute('id', GRADE_FILTER_ID);
        // 必须是 sRGB：默认值 linearRGB 会让中间调整体变暗，怎么调都不对
        f.setAttribute('color-interpolation-filters', 'sRGB');
        const ct = document.createElementNS(ns, 'feComponentTransfer');
        const mk = (tag) => {
            const n = document.createElementNS(ns, tag);
            n.setAttribute('type', 'table');
            n.setAttribute('tableValues', '0 1');
            ct.appendChild(n);
            return n;
        };
        _ctEl = { el: ct, r: mk('feFuncR'), g: mk('feFuncG'), b: mk('feFuncB') };
        f.appendChild(ct);
        svg.appendChild(f);
        (document.body || document.documentElement).appendChild(svg);
        _filterEl = f;
        return f;
    }

    // 校准 = 3×3 通道混合矩阵。色相偏移 = 原色轴在原色平面内旋转；
    // 饱和度 = 轴向「灰矢量」收放（-100 收进灰、正过冲更艳，LR 同款语义）。
    // 灰守恒：各列的改动量做均摊配平，保证 Σ列 = (1,1,1)，即 R=G=B 的输入
    // 输出恒等 —— 灰背景、白边、中性皮肤在任何校准组合下都不偏色。
    // （纯原色在别的列被配平后会带一点邻色，这是线性 3×3 的数学极限，
    //   典型用法 ±10~30 完全够用。）
    function calMatrixValues(cal) {
        // ── 绕灰轴旋转（Rodrigues）──
        // 每个原色轴绕 (1,1,1)/√3 转 θ，这是唯一同时满足两件事的模型：
        //   ① 行和 = 1  → 灰 (g,g,g) 输入仍是灰，白边/灰背景永不偏色；
        //   ② 正交矩阵 → 列模长不变，色度不被压缩。
        // 早期版本把三个轴各自朝 A/B 方向线性插值再归一化：行和是 1.31/1.35，
        // 灰 128 被推成 (123,166,172)；改成行归一化又把色度压掉约 24%，
        // 导入预设后整张发灰、黄叶变柠檬色。
        const K = 1 / Math.sqrt(3);
        const GRAY = 1 / 3;
        const rotCol = (deg, i) => {
            const th = deg * Math.PI / 180;
            const c = Math.cos(th), sn = Math.sin(th);
            const e = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
            // [k]× 的第 i 列（k = 灰轴单位向量）
            const kv = i === 0 ? [0, K, -K] : (i === 1 ? [-K, 0, K] : [K, -K, 0]);
            return [0, 1, 2].map((j) => c * e[j] + sn * kv[j] + (1 - c) * GRAY);
        };
        const axes = [
            rotCol(cal.rh / 100 * 45, 0),
            rotCol(cal.gh / 100 * 45, 1),
            rotCol(cal.bh / 100 * 45, 2)
        ];
        // 三个原色轴各转各的角度，Rodrigues 单列旋转**不保行和**
        // （实测 RedHue+49/GreenHue+46 时行和是 0.746/1.221/1.033）。
        // 不修就会让灰 (0.5,0.5,0.5) 变成 (0.33,0.5,0.5) —— 整张偏青绿。
        for (let j = 0; j < 3; j++) {
            const sum = axes[0][j] + axes[1][j] + axes[2][j];
            if (Math.abs(sum) > 1e-6) {
                const k = 1 / sum;
                for (let i = 0; i < 3; i++) axes[i][j] *= k;
            }
        }
        const sats = [cal.rs / 100, cal.gs / 100, cal.bs / 100];
        // 饱和度：col + s·(col − GRAY)。s=−1 收成灰、s=+1 过冲更艳；
        // 逐列的偏移量行和为 0，所以不会破坏灰守恒（三个 s 不同时再用下面的配平收口）。
        const cols = [[], [], []];
        let D0 = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const sg = Math.max(-1, Math.min(1, sats[i]));
            for (let j = 0; j < 3; j++) {
                const d = sg * (axes[i][j] - GRAY);
                cols[i][j] = axes[i][j] + d;
                D0[j] += d;
            }
        }
        // 三个 s 不一致时行和会被拉偏，把 Σd 均摊回去（量级很小，不伤饱和度）
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) cols[i][j] -= D0[j] / 3;
        }
        // 行主序 4×5：R' = cols[0][0]*R + cols[1][0]*G + cols[2][0]*B …
        return [
            cols[0][0], cols[1][0], cols[2][0], 0, 0,
            cols[0][1], cols[1][1], cols[2][1], 0, 0,
            cols[0][2], cols[1][2], cols[2][2], 0, 0,
            0, 0, 0, 1, 0
        ].map((v) => v.toFixed(5)).join(' ');
    }

    const nsURI = 'http://www.w3.org/2000/svg';
    function feEl(tag, attrs) {
        const n = document.createElementNS(nsURI, tag);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        return n;
    }

    // USM 一级：out = src*(1+amt) - blur*amt。amt<0 时反向（往模糊里混，柔化）。
    function usmStage(input, resultName, radius, amt) {
        return [
            feEl('feGaussianBlur', { in: input, stdDeviation: String(radius), result: 'qB' }),
            feEl('feComposite', {
                in: input, in2: 'qB', operator: 'arithmetic',
                k1: '0', k2: (1 + amt).toFixed(4), k3: (-amt).toFixed(4), k4: '0',
                result: resultName
            })
        ];
    }

    // 按「校准/纹理/清晰度是否启用 + 烘焙分辨率」重建子节点（分辨率变了模糊半径要跟着变）
    function syncChain(p, longPx, lutOn) {
        const f = ensureFilter();
        // 校准已并入三维表时这里不再叠矩阵
        const cal = calActive(p.cal) && !lutOn;
        const det = p.det || {};
        const clar = det.clar | 0, tex = det.tex | 0;
        // 注意别用全参数的 signature():对纯 cal 对象它算出的是常量串,
        // 会导致换校准矩阵时不重建链、滤镜停留在上一次的 values
        const calSig = cal ? CAL_FIELDS.map((x) => p.cal[x.k]).join(',') : '';
        const sig = calSig + '|' + clar + '|' + tex + '|' + Math.round(longPx);
        if (_chainSig === sig) return;
        _chainSig = sig;
        while (f.firstChild) f.removeChild(f.firstChild);
        _ctEl.el.setAttribute('result', 'qL');
        f.appendChild(_ctEl.el);
        let cur = 'qL';
        if (cal) {
            f.appendChild(feEl('feColorMatrix', {
                in: cur, type: 'matrix', values: calMatrixValues(p.cal), result: 'qC'
            }));
            cur = 'qC';
        }
        // 纹理先（细节层），清晰度后（整体立体感），与 LR 的作用层级一致
        if (tex) {
            const r = Math.max(1, Math.min(6, longPx / 250));
            const stages = usmStage(cur, 'qU1', r.toFixed(2), (tex / 100) * 0.5);
            stages.forEach((n) => f.appendChild(n));
            cur = 'qU1';
        }
        if (clar) {
            const r = Math.max(4, Math.min(60, longPx / 40));
            const stages = usmStage(cur, 'qU2', r.toFixed(2), (clar / 100) * 0.5);
            stages.forEach((n) => f.appendChild(n));
            cur = 'qU2';
        }
    }

    function defaultCal() { return { rh: 0, rs: 0, gh: 0, gs: 0, bh: 0, bs: 0 }; }
    function defaultDet() { return { clar: 0, tex: 0, dhz: 0 }; }
    // 只保留非零项，草稿里不塞一堆 0
    function sanitizeMix(m) {
        if (!m) return null;
        const out = {};
        let any = false;
        for (const b of MIX_BANDS) {
            const v = m[b.k];
            if (!v) continue;
            const e = {};
            for (const mt of MIX_METRICS) {
                const n = Math.round(Number(v[mt.k]) || 0);
                const c = Math.max(-100, Math.min(100, n));
                e[mt.k] = c;
                if (c) any = true;
            }
            if (e.h || e.s || e.l) out[b.k] = e;
        }
        return any ? out : null;
    }
    function sanitizeGroup(p, def) {
        if (!p) return null;
        const out = def();
        let any = false;
        for (const k in out) {
            const n = Math.round(Number(p[k]) || 0);
            out[k] = Math.max(-100, Math.min(100, n));
            if (out[k]) any = true;
        }
        return any ? out : null;
    }
    function gradeField(k) {
        for (const f of GRADE_FIELDS) if (f.k === k) return f;
        return null;
    }
    function clampGradeValue(k, v) {
        const f = gradeField(k);
        const lo = f ? f.min : -100, hi = f ? f.max : 100;
        const n = Math.max(lo, Math.min(hi, Number(v) || 0));
        return f && f.step ? Math.round(n / f.step) * f.step : Math.round(n);
    }

    function defaultGrade() {
        const p = {};
        for (const f of GRADE_FIELDS) p[f.k] = 0;
        p.curve = null;      // 四条曲线的控制点；null = 全是直线
        p.cal = null;        // 校准（原色色相/饱和）
        p.det = null;        // 细节（清晰度/纹理/去除薄雾）
        p.mix = null;        // 混色器（8 色相带 HSL）
        p.cg = null;         // 颜色分级（阴影/中间调/高光/全局）
        p.bw = null;         // 黑白混色器（8 色相带各自调亮调暗）
        p.cb = null;         // 色彩平衡（三区 × 三轴）
        p.gm = null;         // 渐变映射（两色 + 强度）
        p.lc = null;         // 镜头校正（畸变）
        p.masks = [];        // 蒙版（线性/椭圆/画笔/亮度），每个带一套基础参数
        return p;
    }

    function normalizeGrade(p) {
        const out = defaultGrade();
        if (!p) return out;
        for (const f of GRADE_FIELDS) {
            let v = Number(p[f.k]);
            if (!Number.isFinite(v)) { out[f.k] = 0; continue; }
            // 兼容旧草稿：旧版曝光是 -100..100 的线性滑块，新版是 EV。
            // 旧档位 >5 时按旧公式反推 EV，保证打开旧草稿不会突然过曝。
            if (f.k === 'exp' && Math.abs(v) > 5.01) {
                const old = Math.max(-100, Math.min(100, v));
                v = Math.log(Math.max(0.01, 1 + old * 0.005)) / Math.LN2;
            }
            v = Math.max(f.min, Math.min(f.max, v));
            out[f.k] = f.step ? Math.round(v / f.step) * f.step : v;
            if (f.k === 'exp') out[f.k] = Math.round(out[f.k] * 100) / 100;
        }
        const C = window.QfsCurve;
        out.curve = C ? C.sanitizeCurve(p.curve) : null;
        out.cal = sanitizeGroup(p.cal, defaultCal);
        out.det = sanitizeGroup(p.det, defaultDet);
        out.mix = sanitizeMix(p.mix);
        out.cg = sanitizeCg(p.cg);
        out.bw = sanitizeBw(p.bw);
        out.cb = sanitizeCb(p.cb);
        out.gm = sanitizeGm(p.gm);
        out.lc = sanitizeLc(p.lc);
        out.masks = (window.QfsMask && window.QfsMask.sanitizeMasks)
            ? window.QfsMask.sanitizeMasks(p.masks) : [];
        return out;
    }

    function calActive(c) { return !!(c && (c.rh || c.rs || c.gh || c.gs || c.bh || c.bs)); }
    function detActive(d) { return !!(d && (d.clar || d.tex || d.dhz)); }
    function mixActive(m) {
        if (!m) return false;
        for (const b of MIX_BANDS) {
            const v = m[b.k];
            if (v && (v.h || v.s || v.l)) return true;
        }
        return false;
    }

    function isNeutral(p) {
        if (!p) return true;
        for (const f of GRADE_FIELDS) if (Number(p[f.k]) || 0) return false;
        const C = window.QfsCurve;
        if (C && C.curveActive(p.curve)) return false;
        if (window.QfsMask && window.QfsMask.activeMasks(p.masks).length) return false;
        if (bwActive(p.bw)) return false;
        if (cbActive(p.cb) || gmActive(p.gm) || lcActive(p.lc)) return false;
        return !calActive(p.cal) && !detActive(p.det) && !mixActive(p.mix) && !cgActive(p.cg);
    }

    function signature(p) {
        if (!p) return '';
        const C = window.QfsCurve;
        let s = GRADE_FIELDS.map((f) => (Number(p[f.k]) || 0)).join(',')
            + (C ? '/' + C.curveSignature(p.curve) : '');
        if (calActive(p.cal)) s += '/c' + CAL_FIELDS.map((f) => p.cal[f.k]).join(',');
        if (detActive(p.det)) s += '/d' + DET_FIELDS.map((f) => p.det[f.k]).join(',');
        if (mixActive(p.mix)) s += '/m' + MIX_BANDS.map((b) => {
            const v = p.mix[b.k] || {};
            return (v.h || 0) + '.' + (v.s || 0) + '.' + (v.l || 0);
        }).join(',');
        if (bwActive(p.bw)) s += '/bw' + BW_KEYS.map((k) => (Number(p.bw[k]) || 0)).join(',');
        if (cbActive(p.cb)) s += '/cb' + CB_ZONES.map((z) => CB_AXES.map((a) => Number(p.cb[z.k][a.k]) || 0).join('.')).join(',')
            + '.' + (p.cb.preserve ? 1 : 0);
        if (gmActive(p.gm)) s += '/gm' + p.gm.dark + p.gm.light + (p.gm.amount || 0);
        if (lcActive(p.lc)) s += '/lc' + (p.lc.distort || 0);
        if (cgActive(p.cg)) s += '/g' + CG_ZONES.map((z) => {
            const v = p.cg[z.k] || {};
            return (v.h || 0) + '.' + (v.s || 0) + '.' + (v.l || 0);
        }).join(',') + '.' + (p.cg.blending || 0) + '.' + (p.cg.balance || 0);
        // 只把「会改变画面」的组算进来：只画了形状没调参数的蒙版不影响像素。
        // 组合模式下一个组可能含多个成员（add/subtract/intersect），
        // 任一成员改形状都要重烘，所以签名取整组。
        const grps = (window.QfsMask && window.QfsMask.activeGroups) ? window.QfsMask.activeGroups(p.masks) : [];
        if (grps.length) s += '/k' + grps.map((g) => window.QfsMask.groupSignature(g)).join('~');
        return s;
    }

    // 256 级实测响应表采样（x ∈ 0..1）
    function lutAt(arr, x) {
        const t = x * 255;
        const i = Math.min(254, Math.max(0, Math.floor(t)));
        const f = t - i;
        return arr[i] * (1 - f) + arr[i + 1] * f;
    }
    // 自适应档（对比度/高光/阴影）需要的图片亮度测度；按图缓存。
    function acrBrightness() {
        const im = window.App && window.App.image;
        if (!im || !im.el) return { con: 128, hi: 128, sh: 128 };
        if (!im._acrBright) {
            im._acrBright = (window.QfsAcr && window.QfsAcr.measureBrightness)
                ? window.QfsAcr.measureBrightness(im.el) : { con: 128, hi: 128, sh: 128 };
        }
        return im._acrBright;
    }

    // 去薄雾的雾色：全图最亮 1% 的平均色。按图缓存——它只取决于原图，
    // 与当前调色参数无关，所以拖滑块时不会再算。
    function acrHaze() {
        const im = window.App && window.App.image;
        if (!im || !im.el) return null;
        if (im._acrHaze === undefined) {
            im._acrHaze = (window.QfsAcr && window.QfsAcr.dehazeHaze)
                ? window.QfsAcr.dehazeHaze(im.el) : null;
        }
        return im._acrHaze;
    }

    // 色温/高光/阴影/白点黑点合成每通道一条曲线，再串联用户曲线与薄雾黑场
    function buildTables(p) {
        const sh = (p.sh || 0) / 100, hi = (p.hi || 0) / 100, tp = (p.temp || 0) / 100;
        const tn = (p.tint || 0) / 100;
        const wht = (p.white || 0) / 100, blk = (p.black || 0) / 100;
        const evGain = Math.pow(2, Number(p.exp) || 0);
        const gam = (Number(p.gam) || 0) / 100;
        // 色彩平衡 / 渐变映射：与亮度无关的量先算好，循环里只查权重
        let cbPrep = null;
        if (cbActive(p.cb)) {
            cbPrep = CB_ZONES.map((z) => {
                const v = p.cb[z.k] || {};
                return { r: (Number(v.r) || 0) / 100, g: (Number(v.g) || 0) / 100, b: (Number(v.b) || 0) / 100 };
            });
            cbPrep.preserve = p.cb.preserve !== 0;
        }
        let gmPrep = null;
        if (gmActive(p.gm)) {
            const dk = hexToRgb(p.gm.dark), lt = hexToRgb(p.gm.light);
            gmPrep = {
                dr: dk[0], dg: dk[1], db: dk[2],
                lr: lt[0], lg: lt[1], lb: lt[2],
                amt: Math.max(0, Math.min(100, Number(p.gm.amount) || 0)) / 100
            };
        }
        const C = window.QfsCurve;
        const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
        // ACR 实测 stage（QfsAcr）：曝光→白平衡→对比度→高光→阴影→白→黑，
        // 顺序与 Photoshop Camera Raw 一致。表没加载好时退回手写公式。
        const ACR = window.QfsAcr;
        const acrOn = !!(ACR && ACR.ready());
        const F = acrOn
            ? ACR.toneStages({
                exp: Number(p.exp) || 0, temp: Number(p.temp) || 0, tint: Number(p.tint) || 0,
                con: Number(p.con) || 0, hi: Number(p.hi) || 0, sh: Number(p.sh) || 0,
                white: Number(p.white) || 0, black: Number(p.black) || 0
            }, acrBrightness())
            : null;
        const gpow = Math.pow(2, -gam * 0.85);
        const r = new Array(LUT_N), g = new Array(LUT_N), b = new Array(LUT_N);
        for (let i = 0; i < LUT_N; i++) {
            const v = i / (LUT_N - 1);
            let vr, vg, vb;
            if (F) {
                // 实测复合响应：三分量在白平衡处开始分道，各自沿自己的曲线走
                vr = lutAt(F.r, v); vg = lutAt(F.g, v); vb = lutAt(F.b, v);
                if (gam) {
                    vr = Math.pow(clamp01(vr), gpow); vg = Math.pow(clamp01(vg), gpow); vb = Math.pow(clamp01(vb), gpow);
                }
            } else {
                // ── 兜底：手写公式（表未就绪/主进程无表）──
                // 曝光是线性光量：先在 sRGB 解码后的线性空间乘 2^EV，再编码回
                // sRGB。直接 brightness(2^EV) 会把中灰 128 翻成 255，LR 只到约 175。
                let o = v;
                if (evGain !== 1) {
                    o = linearToSrgb(clamp01(srgbToLinear(v) * evGain));
                }
                // 高光/阴影：只吃两端（窗内为 1、窗外为 0），中间调几乎不动。
                // 判定用当前亮度 o（曝光之后的实际亮度），避免"先提亮再压高光"错位。
                if (sh) o += sh * SH_AMP * (1 - smoothstep(0, LO_KNEE, o));
                // 高光窗在接近纯白处**回落**：LR 的高光恢复不会把白点压灰，
                // 否则整张照片失去最亮处，看起来"发灰不发亮"（用户对照 PS 时的第一感受）。
                if (hi) {
                    const w = smoothstep(HI_KNEE, HI_TOP, o) * (1 - 0.65 * smoothstep(HI_TOP, 1, o));
                    o += hi * HI_AMP * w;
                }
                o = clamp01(o);
                // 白点：正档把白点往里收（亮部提前并合到纯白），负档整体压暗亮部。
                // 与高光不同，它**故意允许溢出**——那是「白色」该干的事，所以用端点操作，
                // 但按 v² 加权，只让高光区吃到，中间调几乎不动。
                if (wht) {
                    // 三次方加权：128 只吃 12.5%，224 吃 68%，端点全吃
                    const gain = 1 / Math.max(0.1, 1 - wht * 0.25);
                    o = o + (clamp01(o * gain) - o) * o * o * o;
                }
                // 黑点：正档抬黑（0 变成 0.22，起雾/褪色），负档压死暗部（低于阈值的直接切黑）。
                // 按 (1-v)² 加权，只吃暗部。
                if (blk) {
                    // LR 的 Blacks +100 大约把纯黑抬到 30～35，0.22 会抬到 56（暗部发灰、不通透）
                    const op = blk > 0
                        ? o * (1 - blk * 0.16) + blk * 0.16
                        : Math.max(0, (o + blk * 0.16) / (1 + blk * 0.16));
                    o = o + (op - o) * (1 - o) * (1 - o) * (1 - o);
                }
                if (gam) o = Math.pow(clamp01(o), gpow);
                const d = tp * T_AMP * bell(o);
                const dt = tn * TINT_AMP * bell(o);
                // 色调：正 = 品红（R/B 升、G 降），负 = 绿（G 升、R/B 降），
                // 与 Lightroom 的 Tint 正负方向一致；不再是 hue-rotate 的整体转色。
                vr = clamp01(o + d + dt * 0.5);
                vg = clamp01(o + d * 0.18 - dt);
                vb = clamp01(o - d + dt * 0.5);
            }
            // 去除薄雾不再在这里拉黑场：ACR 的反演已经包含通透度的变化，
            // 再叠一次黑场拉伸会让暗部发死（旧实现就是这么糊掉的）。
            // 曲线串在最后：先色温/高光/阴影，再用户曲线（与 PS 的复合顺序一致）
            if (cl) {
                if (cl.r) vr = C.sampleLut(cl.r, vr);
                if (cl.g) vg = C.sampleLut(cl.g, vg);
                if (cl.b) vb = C.sampleLut(cl.b, vb);
            }
            // 色彩平衡：按当前亮度分三区，每区在 R/G/B 轴上做加减。
            // 顺序在曲线之后 —— 与 PS 的调整图层顺序一致（曲线定骨架、色彩平衡着色）。
            if (cbPrep) {
                const y0 = 0.299 * vr + 0.587 * vg + 0.114 * vb;
                const w = cbWeights(y0);
                // 极暗门控：纯黑不染色（0→0）。否则「暗部加红」会把画面的黑边、
                // 白边阴影一起染成暗红，看起来像脏了。6% 以上是满权重。
                const gate = smoothstep(0, 0.06, y0);
                let dr = 0, dg = 0, db = 0;
                for (let zi = 0; zi < 3; zi++) {
                    const z = cbPrep[zi], wz = w[zi] * gate;
                    if (!wz) continue;
                    dr += z.r * wz * CB_AMP;
                    dg += z.g * wz * CB_AMP;
                    db += z.b * wz * CB_AMP;
                }
                vr = clamp01(vr + dr); vg = clamp01(vg + dg); vb = clamp01(vb + db);
                // 保持明度：把亮度的净变化补回去（PS 的 Preserve Luminosity）。
                // 直接按比例缩放会把色度一起削掉，用差值补偿更接近 PS 的观感。
                if (cbPrep.preserve) {
                    const y1 = 0.299 * vr + 0.587 * vg + 0.114 * vb;
                    const dl = (y0 - y1) * 0.9;
                    vr = clamp01(vr + dl); vg = clamp01(vg + dl); vb = clamp01(vb + dl);
                }
            }
            // 渐变映射：拿当前亮度当索引去查那条两色渐变，再按强度混回去。
            if (gmPrep) {
                const t = clamp01(0.299 * vr + 0.587 * vg + 0.114 * vb);
                vr += (gmPrep.dr + (gmPrep.lr - gmPrep.dr) * t - vr) * gmPrep.amt;
                vg += (gmPrep.dg + (gmPrep.lg - gmPrep.dg) * t - vg) * gmPrep.amt;
                vb += (gmPrep.db + (gmPrep.lb - gmPrep.db) * t - vb) * gmPrep.amt;
                vr = clamp01(vr); vg = clamp01(vg); vb = clamp01(vb);
            }
            r[i] = vr.toFixed(5);
            g[i] = vg.toFixed(5);
            b[i] = vb.toFixed(5);
        }
        return { r, g, b };
    }

    function writeTables(p) {
        ensureFilter();
        const t = buildTables(p);
        _ctEl.r.setAttribute('tableValues', t.r.join(' '));
        _ctEl.g.setAttribute('tableValues', t.g.join(' '));
        _ctEl.b.setAttribute('tableValues', t.b.join(' '));
    }

    // lutOn：跨通道那几档已并入 ACR 三维表时，这里就不要再叠一遍
    // （校准矩阵 / CSS saturate），否则同一个滑块会生效两次。
    function filterString(p, longPx, lutOn) {
        syncChain(p, longPx || 0, !!lutOn);
        const parts = [];
        const sh = Number(p.sh) || 0, hi = Number(p.hi) || 0, tp = Number(p.temp) || 0;
        const tn = Number(p.tint) || 0;
        const wht = Number(p.white) || 0, blk = Number(p.black) || 0;
        const exp = Number(p.exp) || 0;
        const C = window.QfsCurve;
        const curved = !!(C && C.curveActive(p.curve));
        const calOn = calActive(p.cal) && !lutOn;
        // 只要滤镜进链就写表（写表只有 256 次循环，可忽略）：
        // 否则只开校准/USM 时会残留上一次烘焙的表值。
        // 曝光也在这张表里（线性光乘 2^EV），不再用 brightness()。
        const gamOn = Number(p.gam) || 0;
        if (sh || hi || tp || tn || wht || blk || exp || gamOn || curved
            || (Number(p.con) || 0)
            || cbActive(p.cb) || gmActive(p.gm)
            || calOn || detActive(p.det)) {
            writeTables(p);
            parts.push('url(#' + GRADE_FILTER_ID + ')');
        }
        const acrCon = (window.QfsAcr && window.QfsAcr.ready())
            && (Number(p.con) || 0);   // 实测表路径下对比度已进 LUT，不再叠 CSS contrast
        const con = (Number(p.con) || 0) / 100;
        if (con && !acrCon) parts.push('contrast(' + (1 + con * 0.5).toFixed(4) + ')');
        const sat = (Number(p.sat) || 0) / 100;
        if (sat && !lutOn) parts.push('saturate(' + (1 + sat).toFixed(4) + ')');
        // 去除薄雾不再走 contrast/saturate 叠加：那是「假通透」，与 ACR 差得远。
        // 真实做法（雾色 + 暗通道反演）已在后置 pass 里，见 QfsColor。
        return parts.join(' ');
    }

    // ── 缓存 ──────────────────────────────────────────────────────
    const _lru = [];
    function lruTouch(im) {
        const i = _lru.indexOf(im);
        if (i >= 0) _lru.splice(i, 1);
        _lru.push(im);
        while (_lru.length > LRU_MAX) {
            const old = _lru.shift();
            if (old && old._grade) { old._grade.canvas = null; old._grade.low = null; }
            if (old) old._gradeCache = null;
        }
    }

    // 单层烘焙：把 src 按 params 画成一张指定尺寸的画布（不含蒙版）。
    //
    // 跨通道的那几档（校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级）走 ACR 实测
    // 三维表：它们对红黄蓝的作用各不相同，逐通道 LUT 和手写公式都学不像 PS。
    // 表/WebGL 任一不可用时整段退回旧路径（QfsMix + shader 里的 vib/cg），
    // 功能不缺失，只是精度回到公式。
    function bakeOne(src, params, tw, th) {
        let drawSrc = src;
        // 预览用小网格、定稿用大网格：33³ 合成约 6ms，25³ 约 3ms，而两者逐点
        // 平均只差 0.3/255 级（肉眼不可见）。拖动时省下的 3ms 更值钱。
        const lutGrid = Math.max(tw, th) <= GRID_PREVIEW_MAX ? 25 : 33;
        let lut = (window.QfsAcr && window.QfsAcr.ready()) ? window.QfsAcr.colorLut(params, lutGrid) : null;
        const useLut = !!lut && !!(window.QfsColor && window.QfsColor.usingGL());
        if (!useLut) lut = null;
        // 混色器已并进三维表，就不再需要前置的 GL 混色 pass
        if (!useLut && mixActive(params.mix) && window.QfsMix) {
            drawSrc = window.QfsMix.pass(src, params.mix, tw, th) || src;
        }
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        const g = c.getContext('2d');
        if (!g) return null;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const fs = filterString(params, Math.max(tw, th), useLut);
        if (fs) g.filter = fs;
        g.drawImage(drawSrc, 0, 0, tw, th);
        if (fs) g.filter = 'none';
        // 后置 pass 的顺序（对齐 Compositor）：先几何（畸变重采样），再上三维颜色表，
        // 最后黑白（PS 的黑白混色器没有实测表，仍走公式）。
        // 旧路径下 vib / cg 也在这里（按像素自己的饱和度/亮度选区，LUT 表达不了）。
        if (useLut || bwActive(params.bw) || lcActive(params.lc)
            || (!useLut && ((Number(params.vib) || 0) || cgActive(params.cg)))
            || (Number(params.det && params.det.dhz) || 0)) {
            const haze = (Number(params.det && params.det.dhz) || 0) ? acrHaze() : null;
            const out = window.QfsColor && window.QfsColor.pass(c, params, tw, th, lut, haze);
            if (out) return out;
        }
        return c;
    }

    let _srcSeq = 0;
    // 降采样那档的中间结果缓存：拖动某个蒙版时只重烘它那一层，前缀直接复用。
    // 只缓存低分辨率（全尺寸留给静置/导出，避免几十 MB 的画布叠在内存里）。
    function cacheSlot(im, tw, th) {
        if (!im._gradeCache) im._gradeCache = {};
        const key = tw + 'x' + th;
        if (!im._gradeCache[key]) {
            const keys = Object.keys(im._gradeCache);
            if (keys.length >= 2) delete im._gradeCache[keys[0]];
            im._gradeCache[key] = { baseKey: '', base: null, chain: [] };
        }
        return im._gradeCache[key];
    }

    function bake(im, p, maxEdge) {
        const src = im.el;
        if (!src) return null;
        const W = src.naturalWidth || im.w || 0;
        const H = src.naturalHeight || im.h || 0;
        if (!W || !H) return null;
        let tw = W, th = H;
        const long = Math.max(W, H);
        if (maxEdge > 0 && long > maxEdge) {
            const k = maxEdge / long;
            tw = Math.max(1, Math.round(W * k));
            th = Math.max(1, Math.round(H * k));
        }
        // 源像素换了（裁切/旋转会替换 im.el）也必须失效，否则会拿到旧图烘的缓存
        if (!src._qfsVer) src._qfsVer = ++_srcSeq;

        const globalOnly = Object.assign({}, p, { masks: [] });
        const baseKey = signature(globalOnly) + '@' + src._qfsVer + '@' + tw + 'x' + th;
        const slot = maxEdge > 0 ? cacheSlot(im, tw, th) : { baseKey: '', base: null, chain: [] };
        if (slot.baseKey !== baseKey || !slot.base) {
            slot.base = bakeOne(src, p, tw, th);
            slot.baseKey = baseKey;
            slot.chain = [];
        }
        let cur = slot.base;
        if (!cur) return null;

        // 逐「组」烘焙：一个组 = 一个 new 蒙版 + 它的 add/subtract/intersect 成员，
        // 组内共用组首的参数、共用一条烘焙层；权重由 groupAlpha 按组合模式合并。
        // 这样「修边缘」= 加一个「减去」蒙版，不用重画整个蒙版。
        // 前缀缓存：只改第 N 组时，前 N-1 层直接复用。
        const grps = (window.QfsMask && window.QfsMask.activeGroups) ? window.QfsMask.activeGroups(p.masks) : [];
        let prevKey = baseKey;
        for (let i = 0; i < grps.length; i++) {
            const g = grps[i];
            const key = prevKey + '>' + window.QfsMask.groupSignature(g);
            const hit = slot.chain[i];
            if (hit && hit.key === key && hit.canvas) {
                cur = hit.canvas;
                prevKey = key;
                continue;
            }
            const layer = bakeOne(cur, g.head.p, tw, th) || cur;
            // 蒙版权重固定按**原图**算：亮度/颜色蒙版若拿已调色层当源，一压暗选区就变大、
            // 一提亮就变小，调完色再点回蒙版会发现"范围变了"。曲线/校准/混色器同理，
            // 选区应该只由原画面的内容决定，与调色参数无关。
            const alpha = window.QfsMask.groupAlpha(g, tw, th, im.el);
            cur = window.QfsMask.composite(cur, layer, alpha);
            slot.chain[i] = { key, canvas: cur };
            slot.chain.length = i + 1;
            prevKey = key;
        }
        if (grps.length === 0) slot.chain.length = 0;

        // canvas 没有 naturalWidth/naturalHeight，但引擎里到处用它算 fit / 比例 /
        // 自适应字号（autoExifSize = 档位 × clamp(照片宽/1200)）。
        // 必须恒等于原图尺寸，不能报烘焙后的像素尺寸：拖动中用的是 1600px 降采样，
        // 若按实际像素报，相机型号/参数文字会在拖动过程中变小、松手后又跳回原大小。
        // 烘焙画布只是像素密度不同，逻辑尺寸与原图一致，drawImage 仍按目标尺寸缩放绘制。
        cur.naturalWidth = W;
        cur.naturalHeight = H;
        cur.complete = true;
        return cur;
    }

    // 渲染取源：优先全分辨率，其次拖动中的降采样，都没有就原图
    window.photoSrcOf = function (im) {
        if (!im) return null;
        const g = im._grade;
        if (g && !g.neutral) {
            if (g.canvas) return g.canvas;
            if (g.low) return g.low;
        }
        return im.el || null;
    };

    // 导出/保存前必须保证存在全分辨率版本，否则会拿 1600px 的降采样去出 4K 图
    window.ensureFullGrade = function (im) {
        const app = window.App;
        if (!im || !im._grade || im._grade.neutral) return;
        if (im._grade.canvas) return;
        im._grade.canvas = bake(im, im.grade, FULL_EDGE);
        lruTouch(im);
        if (app && im._grade.canvas) app.__gradeBaked = true;
    };

    // ── 色彩平衡 / 渐变映射 / 镜头校正 的 UI 绑定 ──────────────────
    // 这三组的共同点：参数不是「单一数字」，所以不走 GRADE_FIELDS 那套通用滑块，
    // 各自 bind 一次，提交时整体 patch 进 grade。
    let _cbZone = 'shadow';

    function initToneExtra() {
        const $ = (id) => document.getElementById(id);
        const self = this;
        const commit = (patch) => {
            if (!self.image) return;
            self.setGrade(patch);
        };
        const bindRange = (inp, apply, settleMs) => {
            if (!inp) return;
            let t = 0;
            inp.addEventListener('input', () => {
                apply(Number(inp.value) || 0);
                clearTimeout(t);
                t = setTimeout(() => self.rebuildGrade('full'), settleMs || 220);
            });
            inp.addEventListener('change', () => {
                clearTimeout(t);
                apply(Number(inp.value) || 0);
                self.rebuildGrade('full');
            });
        };

        // 色彩平衡：三个区共九个值，当前区由「阴影/中间调/高光」子页决定
        const zones = $('cbZones');
        if (zones) {
            zones.querySelectorAll('[data-cbz]').forEach((b) => {
                b.addEventListener('click', () => {
                    _cbZone = b.dataset.cbz;
                    zones.querySelectorAll('[data-cbz]').forEach((x) => {
                        x.classList.toggle('active', x === b);
                    });
                    if (self.syncToneExtraUI) self.syncToneExtraUI(self.gradeOf(self.image));
                });
            });
        }
        for (const ax of CB_AXES) {
            bindRange($('slCb' + ax.k.toUpperCase()), (v) => {
                const cur = self.gradeOf(self.image).cb || defaultCb();
                const z = Object.assign({}, cur[_cbZone] || {}, { [ax.k]: v });
                commit({ cb: Object.assign({}, cur, { [_cbZone]: z }) });
            });
        }
        const pres = $('cbCbPreserve');
        if (pres) {
            pres.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).cb || defaultCb();
                commit({ cb: Object.assign({}, cur, { preserve: pres.checked ? 1 : 0 }) });
                self.rebuildGrade('full');
            });
        }
        const cbReset = $('btnCbReset');
        if (cbReset) {
            cbReset.addEventListener('click', () => {
                commit({ cb: null });
                self.rebuildGrade('full');
                self.setStatus('色彩平衡已重置');
            });
        }

        // 渐变映射
        const gmOn = $('cbGmOn');
        if (gmOn) {
            gmOn.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { on: gmOn.checked ? 1 : 0 }) });
                self.rebuildGrade('full');
            });
        }
        const bindColor = (id, key) => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('input', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { [key]: el.value, on: 1 }) });
                clearTimeout(el._gmT);
                el._gmT = setTimeout(() => self.rebuildGrade('full'), 200);
            });
            el.addEventListener('change', () => {
                const cur = self.gradeOf(self.image).gm || defaultGm();
                commit({ gm: Object.assign({}, cur, { [key]: el.value, on: 1 }) });
                self.rebuildGrade('full');
            });
        };
        bindColor('clGmDark', 'dark');
        bindColor('clGmLight', 'light');
        bindRange($('slGmAmount'), (v) => {
            const cur = self.gradeOf(self.image).gm || defaultGm();
            commit({ gm: Object.assign({}, cur, { amount: v, on: 1 }) });
        });

        // 镜头校正
        bindRange($('slLcDistort'), (v) => {
            commit({ lc: v ? { distort: v } : null });
        });
    }

    function syncToneExtraUI(p) {
        const $ = (id) => document.getElementById(id);
        const app = window.App;
        const text = (v) => (v === 0 ? '0' : (v > 0 ? '+' + v : String(v)));

        const cb = (p && p.cb) || null;
        const z = (cb && cb[_cbZone]) || { r: 0, g: 0, b: 0 };
        for (const ax of CB_AXES) {
            const id = 'Cb' + ax.k.toUpperCase();
            const inp = $('sl' + id);
            const v = Number(z[ax.k]) || 0;
            if (inp) inp.value = String(v);
            if (app.updateLabel) app.updateLabel('lbl' + id, text(v));
            else { const el = $('lbl' + id); if (el) el.textContent = text(v); }
        }
        const pres = $('cbCbPreserve');
        if (pres) pres.checked = !cb || cb.preserve !== 0;
        const grpCb = $('grpCb');
        if (grpCb) grpCb.classList.toggle('grade-on', !!cb);

        const gm = (p && p.gm) || null;
        const gmOn = $('cbGmOn');
        if (gmOn) gmOn.checked = !!(gm && gm.on !== 0);
        const dk = $('clGmDark'), lt = $('clGmLight');
        if (dk) dk.value = (gm && gm.dark) || '#101a33';
        if (lt) lt.value = (gm && gm.light) || '#ffd9a0';
        const amt = gm ? gm.amount : 100;
        const amtInp = $('slGmAmount');
        if (amtInp) amtInp.value = String(amt);
        if (app.updateLabel) app.updateLabel('lblGmAmount', String(amt));
        const grpGm = $('grpGm');
        if (grpGm) grpGm.classList.toggle('grade-on', !!gm);

        const lc = (p && p.lc) || null;
        const dv = lc ? (Number(lc.distort) || 0) : 0;
        const lcInp = $('slLcDistort');
        if (lcInp) lcInp.value = String(dv);
        if (app.updateLabel) app.updateLabel('lblLcDistort', text(dv));
        const grpLc = $('grpLc');
        if (grpLc) grpLc.classList.toggle('grade-on', !!lc);
    }

    Object.assign(window.App || (window.App = {}), {
        GRADE_FIELDS,
        DET_FIELDS,
        CAL_FIELDS,
        MIX_BANDS,
        MIX_METRICS,
        CG_ZONES,
        defaultCg,
        sanitizeCg,
        isCgActive: cgActive,
        BW_BANDS, BW_KEYS, isBwActive: bwActive, defaultBw, sanitizeBw,
        CB_ZONES, CB_AXES, defaultCb, sanitizeCb, isCbActive: cbActive,
        defaultGm, sanitizeGm, isGmActive: gmActive, hexToRgb,
        defaultLc, sanitizeLc, isLcActive: lcActive,
        MASK_MODES, maskGroups,
        initToneExtra, syncToneExtraUI,

        isNeutralGrade: isNeutral,
        isCalActive: calActive,
        isDetActive: detActive,
        isMixActive: mixActive,
        calMatrixValues,

        gradeOf(im) {
            return (im && im.grade) ? im.grade : defaultGrade();
        },

        // 参数变了：立刻出一张降采样供拖动时看，静置 220ms 再补全分辨率
        setGrade(patch, opts) {
            const im = this.image;
            if (!im) return false;
            // 选中某个蒙版时，9 档滑块改的是**该蒙版的参数**（与 LR 一致）；
            // 曲线/校准/混色器/蒙版列表这类全局项仍然落到 grade 上。
            // 组合模式：滑块读写「组首」的参数（一组共用一套）
            const act = this.paramMask ? this.paramMask(im) : (this.activeMask ? this.activeMask(im) : null);
            const keys = Object.keys(patch || {});
            const onlySlider = keys.length > 0 && keys.every((k) => MASK_ROUTE_KEYS.indexOf(k) >= 0);
            if (act && onlySlider) {
                for (const k of keys) act.p[k] = clampGradeValue(k, patch[k]);
                this.invalidateGrade(im);
                this.rebuildGrade(opts && opts.full ? 'full' : 'low');
                this.syncGradeUI();
                if (this.scheduleRender) this.scheduleRender(true);
                if (this.scheduleDraft) this.scheduleDraft();
                return true;
            }
            // 选中蒙版却改了「不受蒙版控制」的档位（曲线/黑白/清晰度/镜头校正/色彩平衡/渐变映射…）：
            // 这些一直是全局的，用户很容易以为"蒙版没生效"。这里直接说清楚它落到整张照片了。
            if (act && keys.length) {
                const globals = keys.filter((k) => MASK_ROUTE_KEYS.indexOf(k) < 0);
                if (globals.length && this.setStatus) {
                    const names = globals.map((k) => {
                        const f = GRADE_FIELDS.find((x) => x.k === k);
                        return f ? f.label : ({ det: '清晰度/纹理', bw: '黑白', lc: '镜头校正', cg: '色彩平衡',
                            curve: '曲线', mix: '混色器', cal: '校准', gm: '渐变映射' }[k] || k);
                    });
                    this.setStatus('「' + names.join('、') + '」是全局档位，不受蒙版影响（已作用于整张照片）');
                    // 这条提示只解释「刚才那一下」，4 秒后清掉；否则它会一直挂在状态栏，
                    // 用户接着调蒙版档位时还看见"不受蒙版影响"，反而更糊涂。
                    clearTimeout(this._maskGlobalTipT);
                    this._maskGlobalTipT = setTimeout(() => {
                        const el = this.dom && this.dom.stCanvas;
                        if (el && String(el.textContent || '').indexOf('不受蒙版影响') >= 0) this.setStatus('');
                    }, 4000);
                }
            }
            // XMP 预设导入用 replace：未写进预设的档位归零，避免上一套参数
            // 残留在新预设里（否则同一张照片连续导入会越叠越不像）。
            const replace = !!(opts && opts.replace);
            const p = normalizeGrade(replace
                ? Object.assign({}, patch || {})
                : Object.assign({}, im.grade || {}, patch || {}));
            if (replace) this._activeMaskId = null;
            im.grade = p;
            this.invalidateGrade(im);
            this.rebuildGrade(opts && opts.full ? 'full' : 'low');
            this.syncGradeUI();
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
            return true;
        },

        invalidateGrade(im) {
            const t = im || this.image;
            if (!t) return;
            const neutral = isNeutral(t.grade);
            t._grade = { neutral, canvas: null, low: null, key: '' };
            // 按图缓存的测度必须跟源图一起作废：裁切/旋转/还原换了底图之后，
            // ACR 的对比度/高光/阴影仍按旧直方图选行，「去薄雾」也还在用旧图
            // 最亮 1% 当雾色 —— 换图之后这些参数等于作用在错误的图像上。
            delete t._acrBright;
            delete t._acrHaze;
            if (neutral) { t._grade.key = ''; return; }
            lruTouch(t);
        },

        rebuildGrade(level) {
            const im = this.image;
            if (!im || !im._grade || im._grade.neutral) return false;
            const key = signature(im.grade);
            if (level === 'full') {
                if (im._grade.canvas && im._grade.key === key) return true;
                const c = bake(im, im.grade, FULL_EDGE);
                if (c) { im._grade.canvas = c; im._grade.key = key; im._grade.low = null; lruTouch(im); }
                return !!c;
            }
            if (im._grade.low && im._grade.key === key) return true;
            const c = bake(im, im.grade, LOW_EDGE);
            if (c) { im._grade.low = c; im._grade.key = key; lruTouch(im); }
            return !!c;
        },

        resetGrade() {
            const im = this.image;
            if (!im) return false;
            im.grade = defaultGrade();
            this._activeMaskId = null;
            im._gradeCache = null;
            this.invalidateGrade(im);
            this.syncGradeUI();
            if (this.renderFramedThumb) this.renderFramedThumb(im);
            if (this.scheduleRender) this.scheduleRender(true);
            if (this.scheduleDraft) this.scheduleDraft();
            this.setStatus('已重置调色');
            return true;
        },

        // 把当前照片的调色参数复制给所有照片（批量洗图的常见诉求）
        applyGradeToAll() {
            const im = this.image;
            if (!im) return false;
            const p = normalizeGrade(im.grade);
            let n = 0;
            for (const it of (this.images || [])) {
                if (!it || it === im) continue;
                // 曲线是点数组的嵌套结构、混色器是两层的带参数结构，必须深拷贝：
                // 浅拷贝会让所有照片共用同一份数据互相串台
                const cv = p.curve ? JSON.parse(JSON.stringify(p.curve)) : null;
                const mx = p.mix ? JSON.parse(JSON.stringify(p.mix)) : null;
                const cg = p.cg ? JSON.parse(JSON.stringify(p.cg)) : null;
                const mk = JSON.parse(JSON.stringify(p.masks || []));
                it.grade = Object.assign({}, p, {
                    curve: cv, mix: mx, cg, masks: mk,
                    cal: p.cal ? Object.assign({}, p.cal) : null,
                    det: p.det ? Object.assign({}, p.det) : null
                });
                it._grade = { neutral: isNeutral(p), canvas: null, low: null, key: '' };
                n++;
            }
            if (this.buildThumbnails) this.buildThumbnails();
            if (this.scheduleDraft) this.scheduleDraft();
            this.setStatus(n ? ('调色已应用到其余 ' + n + ' 张照片') : '只有一张照片，无需批量应用');
            return true;
        },

        syncGradeUI() {
            const d = this._gradeDom;
            if (!d) return;
            const p = this.gradeOf(this.image);
            const act = this.paramMask ? this.paramMask(this.image) : (this.activeMask ? this.activeMask(this.image) : null);
            const src = act ? act.p : p;
            for (const f of GRADE_FIELDS) {
                const inp = d.sliders[f.k];
                const v = Number(src[f.k]) || 0;
                if (inp) inp.value = String(v);
                // 标签必须走 updateLabel:它是数字框(.pval-num)的唯一同步入口,
                // 直接写 textContent 会让切照片/编程设值后数字框停在旧值。
                const id = 'lblGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1);
                const text = v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
                if (typeof this.updateLabel === 'function') this.updateLabel(id, text);
                else if (d.labels[f.k]) d.labels[f.k].textContent = text;
            }
            if (d.wrap) {
                d.wrap.classList.toggle('grade-on', !isNeutral(p));
                d.wrap.classList.toggle('editing-mask', !!act);
            }
            if (this.syncMaskUI) this.syncMaskUI();
            if (this.syncCurveUI) this.syncCurveUI();
            if (this.syncGradeExtraUI) this.syncGradeExtraUI(p);
            if (this.syncColorGradeUI) this.syncColorGradeUI(p);
            if (this.syncBwUI) this.syncBwUI(p);
            if (this.syncToneExtraUI) this.syncToneExtraUI(p);
        },

        initGrade() {
            const $ = (id) => document.getElementById(id);
            const ids = {
                exp: 'slGradeExp', con: 'slGradeCon', sat: 'slGradeSat', vib: 'slGradeVib',
                temp: 'slGradeTemp', tint: 'slGradeTint', hi: 'slGradeHi', sh: 'slGradeSh',
                white: 'slGradeWhite', black: 'slGradeBlack', gam: 'slGradeGam'
            };
            const sliders = {}, labels = {};
            let any = false;
            for (const f of GRADE_FIELDS) {
                const s = $(ids[f.k]);
                if (s) { sliders[f.k] = s; any = true; }
                labels[f.k] = $('lblGrade' + f.k.charAt(0).toUpperCase() + f.k.slice(1));
            }
            if (!any) return;
            this._gradeDom = { sliders, labels, wrap: $('grpGrade') };
            ensureFilter();

            let settle = 0;
            // 调色后胶片条缩略图还是旧样子,用户会以为"调了没变化"。
            // 缩略图是整帧重渲(走同一条管线),所以只在停手后做一次,不跟拖动抢帧。
            const syncThumb = () => {
                const im = this.image;
                if (!im || typeof this.renderFramedThumb !== 'function') return;
                clearTimeout(im._gradeThumbT);
                im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
            };
            // 一次拖动只压一次撤销快照：拖动开始时记下「拖动前」的状态，
            // 拖动过程中 input 只改参数不压栈，否则一次拖动能生成几十个撤销点。
            // 去重不靠「标记 + change 重置」那种易漏的时序（change 不一定触发，
            // 例如键盘方向键调完、或程序化设值），改成比对栈顶快照的内容：
            // 只要栈顶快照与当前状态完全一样，说明这次拖动已经压过了，不再重复压。
            const pushGradeUndoOnce = () => {
                if (!this.pushUndo) return;
                const top = this.undoStack && this.undoStack[this.undoStack.length - 1];
                if (top && this.sameUndoState(top)) return;
                this.pushUndo();
            };
            for (const f of GRADE_FIELDS) {
                const s = sliders[f.k];
                if (!s) continue;
                s.addEventListener('focus', pushGradeUndoOnce);
                s.addEventListener('input', () => {
                    // 拖动中只换降采样，别让每一次 input 都去烘焙 2400 万像素
                    pushGradeUndoOnce();
                    this.setGrade({ [f.k]: Number(s.value) || 0 });
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); syncThumb(); }, 220);
                });
                s.addEventListener('change', () => {
                    clearTimeout(settle);
                    this.setGrade({ [f.k]: Number(s.value) || 0 }, { full: true });
                    syncThumb();
                });
            }
            const reset = $('btnGradeReset');
            if (reset) reset.addEventListener('click', () => this.resetGrade());
            const all = $('btnGradeApplyAll');
            if (all) all.addEventListener('click', () => this.applyGradeToAll());
            if (this.initCurve) this.initCurve();
            if (this.initGradeExtra) this.initGradeExtra();
            if (this.initColorGrade) this.initColorGrade();
            if (this.initBw) this.initBw();
            if (this.initToneExtra) this.initToneExtra();
            if (this.initMasks) this.initMasks();
            this.syncGradeUI();
            // ACR 实测色表必须在启动时就加载。此前只有「导入 XMP 预设」会调 ensure()，
            // 普通用户永远拿不到表：toneStages 退回兜底公式（还能看出变化），
            // 而混色器 / 校准 / 饱和度 / 自然饱和度 / 颜色分级走的是 colorLut，
            // 表没就绪直接返回 null —— 表现就是「这些档位拖了完全没反应」。
            this.ensureAcrTables();
        },

        // 空闲时加载色表（1.8MB，不阻塞启动）；加载完把当前图按真实表重烘一遍，
        // 否则之前用兜底公式算出来的结果会一直挂到下次参数变化才更新。
        ensureAcrTables() {
            const A = window.QfsAcr;
            if (!A || typeof A.ensure !== 'function') return;
            const load = () => {
                A.ensure().then((ok) => {
                    if (!ok) {
                        this.setStatus('调色色表未加载：混色器/校准/饱和度等档位会按简化公式计算');
                        return;
                    }
                    // GL 不可用时三维表用不上（bakeOne 里 useLut 依赖 usingGL），
                    // 校准与饱和度会退回简化算法 —— 机器上看着就是"拖了没反应"，
                    // 说清楚比让用户以为坏了好。
                    const glOk = !!(window.QfsColor && window.QfsColor.usingGL && window.QfsColor.usingGL());
                    if (!glOk) this.setStatus('当前环境未启用 WebGL：校准、饱和度等档位会降级计算');
                    if (this.image && this.invalidateGrade && this.rebuildGrade) {
                        this.invalidateGrade(this.image);
                        this.rebuildGrade('full');
                        if (this.scheduleRender) this.scheduleRender(true);
                    }
                }).catch(() => { /* 色表缺失不阻塞使用 */ });
            };
            if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 2000 });
            else setTimeout(load, 800);
        }
    });
})();
