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
 * 4) 色温 / 高光 / 阴影 用 SVG feComponentTransfer 的 256 项 table 表达
 *    （三者合并成每通道一条曲线，一次过）；曝光/对比度/饱和度/色调用原生
 *    函数式滤镜。二者可以混写在同一个 filter 字符串里，已实测生效。
 *
 * 借鉴来源：fabric.js 的 BaseFilter 分组（brightness/contrast/saturation/
 * hueRotation 的取值域与「0 为不变」约定），以及 glfx.js 的 vibrance/tone
 * 曲线思路。但最终实现换成浏览器原生滤镜，因为本项目只跑 Electron/Chromium。
 */
(function () {
    const GRADE_FILTER_ID = 'qfsGradeLut';
    const LUT_N = 256;
    // 阴影/高光增益的钟形曲线 v(1-v)^2 峰值 = 4/27，乘 27/4 归一到 1
    const BELL_K = 27 / 4;
    const SH_AMP = 0.42;   // 阴影满档时暗部最大位移
    const HI_AMP = 0.42;   // 高光满档时亮部最大位移
    const T_AMP = 0.10;    // 色温满档时中间调最大位移
    // 选中蒙版时，这些键改的是蒙版参数；其余键永远是全局
    const MASK_ROUTE_KEYS = ['exp', 'con', 'sat', 'temp', 'tint', 'hi', 'sh', 'white', 'black'];
    const LOW_EDGE = 1600; // 拖动过程中的降采样长边
    const FULL_EDGE = 0;   // 静止后的成品：0 = 按原图尺寸，不降采样
                           // （降采样会让导出的「原图」档位拿不到真实长边，宁可多占内存）
    const LRU_MAX = 4;     // 同时保留的烘焙缓存张数（24MP 一张约 96MB）

    const GRADE_FIELDS = [
        { k: 'exp', label: '曝光', min: -100, max: 100, hint: '整体明暗' },
        { k: 'con', label: '对比度', min: -100, max: 100, hint: '明暗反差' },
        { k: 'sat', label: '饱和度', min: -100, max: 100, hint: '-100 为黑白' },
        { k: 'temp', label: '色温', min: -100, max: 100, hint: '左冷右暖' },
        { k: 'tint', label: '色调', min: -100, max: 100, hint: '左品红右绿' },
        { k: 'hi', label: '高光', min: -100, max: 100, hint: '只动亮部' },
        { k: 'sh', label: '阴影', min: -100, max: 100, hint: '只动暗部' },
        { k: 'white', label: '白色', min: -100, max: 100, hint: '白点：正档高光并合、负档压暗亮部' },
        { k: 'black', label: '黑色', min: -100, max: 100, hint: '黑点：正档抬黑起雾、负档压死暗部' }
    ];

    // ── 扩展档位（对齐 LR 的「细节 / 校准 / 混色器」） ──────────────
    const DET_FIELDS = [
        { k: 'clar', label: '清晰度', hint: '中间调立体感' },
        { k: 'tex', label: '纹理', hint: '表面细节' },
        { k: 'dhz', label: '去除薄雾', hint: '通透度（简化版）' }
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

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function bell(x) { return 4 * x * (1 - x); }

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
        const D = Math.PI / 180;
        const GRAY = 1 / 3;
        const axis = (deg, P, A, B) => {
            const c = Math.cos(deg * D), sn = Math.sin(deg * D);
            const v = [
                P[0] * c + A[0] * Math.max(sn, 0) + B[0] * Math.max(-sn, 0),
                P[1] * c + A[1] * Math.max(sn, 0) + B[1] * Math.max(-sn, 0),
                P[2] * c + A[2] * Math.max(sn, 0) + B[2] * Math.max(-sn, 0)
            ];
            const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
            return [v[0] / len, v[1] / len, v[2] / len];
        };
        const axes = [
            axis(cal.rh / 100 * 45, [1, 0, 0], [0, 1, 0], [0, 0, 1]),
            axis(cal.gh / 100 * 45, [0, 1, 0], [0, 0, 1], [1, 0, 0]),
            axis(cal.bh / 100 * 45, [0, 0, 1], [0, 1, 0], [1, 0, 0])
        ];
        const sats = [cal.rs / 100, cal.gs / 100, cal.bs / 100];
        const cols = [[], [], []];
        let D0 = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const s = Math.max(-1, Math.min(1, sats[i]));
            // 滑块负档 = 向灰收（col → GRAY），正档 = 过冲更艳
            for (let j = 0; j < 3; j++) {
                const d = s * (axes[i][j] - GRAY);
                cols[i][j] = axes[i][j] + d;
                D0[j] += d;
            }
        }
        // 均摊配平：每列减去 Σd/3，Σ列 回到 (1,1,1)
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
    function syncChain(p, longPx) {
        const f = ensureFilter();
        const cal = calActive(p.cal);
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

    function defaultGrade() {
        const p = {};
        for (const f of GRADE_FIELDS) p[f.k] = 0;
        p.curve = null;      // 四条曲线的控制点；null = 全是直线
        p.cal = null;        // 校准（原色色相/饱和）
        p.det = null;        // 细节（清晰度/纹理/去除薄雾）
        p.mix = null;        // 混色器（8 色相带 HSL）
        p.masks = [];        // 蒙版（线性/椭圆/画笔/亮度），每个带一套 9 档参数
        return p;
    }

    function normalizeGrade(p) {
        const out = defaultGrade();
        if (!p) return out;
        for (const f of GRADE_FIELDS) {
            const v = Number(p[f.k]);
            out[f.k] = Number.isFinite(v) ? Math.max(f.min, Math.min(f.max, v)) : 0;
        }
        const C = window.QfsCurve;
        out.curve = C ? C.sanitizeCurve(p.curve) : null;
        out.cal = sanitizeGroup(p.cal, defaultCal);
        out.det = sanitizeGroup(p.det, defaultDet);
        out.mix = sanitizeMix(p.mix);
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
        return !calActive(p.cal) && !detActive(p.det) && !mixActive(p.mix);
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
        // 只把「会改变画面」的蒙版算进来：只画了形状没调参数的蒙版不影响像素
        const acts = (window.QfsMask && window.QfsMask.activeMasks) ? window.QfsMask.activeMasks(p.masks) : [];
        if (acts.length) s += '/k' + acts.map((m) => window.QfsMask.maskSignature(m)).join('~');
        return s;
    }

    // 色温/高光/阴影/白点黑点合成每通道一条曲线，再串联用户曲线与薄雾黑场
    function buildTables(p) {
        const sh = (p.sh || 0) / 100, hi = (p.hi || 0) / 100, tp = (p.temp || 0) / 100;
        const wht = (p.white || 0) / 100, blk = (p.black || 0) / 100;
        const dhz = ((p.det && p.det.dhz) || 0) / 100;
        const C = window.QfsCurve;
        const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
        const r = new Array(LUT_N), g = new Array(LUT_N), b = new Array(LUT_N);
        for (let i = 0; i < LUT_N; i++) {
            const v = i / (LUT_N - 1);
            let o = v;
            // 两端固定、只抬中间：纯黑不灰、纯白不溢，这是「高光/阴影」该有的样子
            o += sh * SH_AMP * BELL_K * v * (1 - v) * (1 - v);
            o += hi * HI_AMP * BELL_K * v * v * (1 - v);
            o = clamp01(o);
            // 白点：正档把白点往里收（亮部提前并合到纯白），负档整体压暗亮部。
            // 与高光不同，它**故意允许溢出**——那是「白色」该干的事，所以用端点操作，
            // 但按 v² 加权，只让高光区吃到，中间调几乎不动。
            if (wht) {
                const gain = 1 / Math.max(0.1, 1 - wht * 0.25);
                o = o + (clamp01(o * gain) - o) * o * o;
            }
            // 黑点：正档抬黑（0 变成 0.22，起雾/褪色），负档压死暗部（低于阈值的直接切黑）。
            // 按 (1-v)² 加权，只吃暗部。
            if (blk) {
                const op = blk > 0
                    ? o * (1 - blk * 0.22) + blk * 0.22
                    : Math.max(0, (o + blk * 0.22) / (1 + blk * 0.22));
                o = o + (op - o) * (1 - o) * (1 - o);
            }
            const d = tp * T_AMP * bell(o);
            let vr = clamp01(o + d), vg = clamp01(o + d * 0.18), vb = clamp01(o - d);
            // 去除薄雾（简化版）的黑场部分：正档压黑点（通透），负档抬黑点（起雾褪色）
            if (dhz > 0) {
                const bp = 0.07 * dhz, k = 1 / Math.max(0.05, 1 - bp);
                vr = clamp01((vr - bp) * k); vg = clamp01((vg - bp) * k); vb = clamp01((vb - bp) * k);
            } else if (dhz < 0) {
                const f = -dhz, lift = 0.09 * f, gain = 1 - 0.12 * f;
                vr = clamp01(vr * gain + lift); vg = clamp01(vg * gain + lift); vb = clamp01(vb * gain + lift);
            }
            // 曲线串在最后：先色温/高光/阴影，再用户曲线（与 PS 的复合顺序一致）
            if (cl) {
                if (cl.r) vr = C.sampleLut(cl.r, vr);
                if (cl.g) vg = C.sampleLut(cl.g, vg);
                if (cl.b) vb = C.sampleLut(cl.b, vb);
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

    function filterString(p, longPx) {
        syncChain(p, longPx || 0);
        const parts = [];
        const sh = Number(p.sh) || 0, hi = Number(p.hi) || 0, tp = Number(p.temp) || 0;
        const wht = Number(p.white) || 0, blk = Number(p.black) || 0;
        const dhz = ((p.det && p.det.dhz) || 0) / 100;
        const C = window.QfsCurve;
        const curved = !!(C && C.curveActive(p.curve));
        // 只要滤镜进链就写表（写表只有 256 次循环，可忽略）：
        // 否则只开校准/USM 时会残留上一次烘焙的表值
        if (sh || hi || tp || wht || blk || curved || dhz
            || calActive(p.cal) || detActive(p.det)) {
            writeTables(p);
            parts.push('url(#' + GRADE_FILTER_ID + ')');
        }
        const exp = (Number(p.exp) || 0) / 100;
        if (exp) parts.push('brightness(' + (1 + exp * 0.5).toFixed(4) + ')');
        const con = (Number(p.con) || 0) / 100;
        if (con) parts.push('contrast(' + (1 + con * 0.5).toFixed(4) + ')');
        const sat = (Number(p.sat) || 0) / 100;
        if (sat) parts.push('saturate(' + (1 + sat).toFixed(4) + ')');
        const tint = (Number(p.tint) || 0) / 100;
        if (tint) parts.push('hue-rotate(' + (tint * 24).toFixed(2) + 'deg)');
        // 薄雾的反差/饱和部分（黑场已在 LUT 里）
        if (dhz > 0) {
            parts.push('contrast(' + (1 + 0.28 * dhz).toFixed(4) + ')',
                'saturate(' + (1 + 0.4 * dhz).toFixed(4) + ')');
        } else if (dhz < 0) {
            parts.push('contrast(' + (1 + 0.18 * dhz).toFixed(4) + ')',
                'saturate(' + (1 + 0.45 * dhz).toFixed(4) + ')');
        }
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
    function bakeOne(src, params, tw, th) {
        let drawSrc = src;
        if (mixActive(params.mix) && window.QfsMix) {
            drawSrc = window.QfsMix.pass(src, params.mix, tw, th) || src;
        }
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        const g = c.getContext('2d');
        if (!g) return null;
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        const fs = filterString(params, Math.max(tw, th));
        if (fs) g.filter = fs;
        g.drawImage(drawSrc, 0, 0, tw, th);
        if (fs) g.filter = 'none';
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

        // 逐个蒙版：用该蒙版自己的 9 档参数再烘一层，然后按蒙版权重合成。
        // 前缀缓存：只改第 N 个蒙版时，前 N-1 层直接复用。
        const acts = (window.QfsMask && window.QfsMask.activeMasks) ? window.QfsMask.activeMasks(p.masks) : [];
        let prevKey = baseKey;
        for (let i = 0; i < acts.length; i++) {
            const m = acts[i];
            const key = prevKey + '>' + window.QfsMask.maskSignature(m);
            const hit = slot.chain[i];
            if (hit && hit.key === key && hit.canvas) {
                cur = hit.canvas;
                prevKey = key;
                continue;
            }
            const layer = bakeOne(cur, m.p, tw, th) || cur;
            // 蒙版权重固定按**原图**算：亮度蒙版若拿已调色层当源，一压暗选区就变大、
            // 一提亮就变小，调完色再点回蒙版会发现"范围变了"。曲线/校准/混色器同理，
            // 选区应该只由原画面的亮度决定，与调色参数无关。
            const alpha = window.QfsMask.render(m, tw, th, im.el);
            cur = window.QfsMask.composite(cur, layer, alpha);
            slot.chain[i] = { key, canvas: cur };
            slot.chain.length = i + 1;
            prevKey = key;
        }
        if (acts.length === 0) slot.chain.length = 0;

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

    Object.assign(window.App || (window.App = {}), {
        GRADE_FIELDS,
        DET_FIELDS,
        CAL_FIELDS,
        MIX_BANDS,
        MIX_METRICS,

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
            const act = this.activeMask ? this.activeMask(im) : null;
            const keys = Object.keys(patch || {});
            const onlySlider = keys.length > 0 && keys.every((k) => MASK_ROUTE_KEYS.indexOf(k) >= 0);
            if (act && onlySlider) {
                for (const k of keys) {
                    const v = Number(patch[k]) || 0;
                    act.p[k] = Math.max(-100, Math.min(100, Math.round(v)));
                }
                this.invalidateGrade(im);
                this.rebuildGrade(opts && opts.full ? 'full' : 'low');
                this.syncGradeUI();
                if (this.scheduleRender) this.scheduleRender(true);
                if (this.scheduleDraft) this.scheduleDraft();
                return true;
            }
            const p = normalizeGrade(Object.assign({}, im.grade || {}, patch || {}));
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
                const mk = JSON.parse(JSON.stringify(p.masks || []));
                it.grade = Object.assign({}, p, {
                    curve: cv, mix: mx, masks: mk,
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
            const act = this.activeMask ? this.activeMask(this.image) : null;
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
        },

        initGrade() {
            const $ = (id) => document.getElementById(id);
            const ids = {
                exp: 'slGradeExp', con: 'slGradeCon', sat: 'slGradeSat', temp: 'slGradeTemp',
                tint: 'slGradeTint', hi: 'slGradeHi', sh: 'slGradeSh',
                white: 'slGradeWhite', black: 'slGradeBlack'
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
            for (const f of GRADE_FIELDS) {
                const s = sliders[f.k];
                if (!s) continue;
                s.addEventListener('input', () => {
                    // 拖动中只换降采样，别让每一次 input 都去烘焙 2400 万像素
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
            if (this.initMasks) this.initMasks();
            this.syncGradeUI();
        }
    });
})();
