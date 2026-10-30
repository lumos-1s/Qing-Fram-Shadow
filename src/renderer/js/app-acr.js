// ACR 实测查找表：Photoshop「Camera Raw 滤镜」在每个滑块每个档位下对 17³ 色格的
// 实测输出（Compositor 项目以 MIT 许可发布的 CameraRawTables.bin，此处转存为 zlib）。
// 为什么用它：LR/ACR 的色调引擎是私有的，公式猜不准（我们已经在高光/暗部上
// 连续翻车三次）；而我们的应用处理的同样是 8-bit sRGB 图像，和 Camera Raw 滤镜
// 的输入输出域完全一致，实测表就是最直接的 ground truth。
//
// 用法：buildTables 里把每个滑块档位的表按值线性混合成「灰轴对角线响应」
// （输入 v,v,v → 输出），作为每通道曲线替换手写公式。表保持灰守恒
// （灰进灰出），所以对角线提取对色温之外的档位是精确的。
'use strict';

(function () {
    const BRIGHT = [53, 80, 104, 130, 160, 190, 224];   // 自适应档位的背景亮度（sRGB 级）
    const AVAL = [-100, -50, -25, 0, 25, 50, 100];      // 自适应档位的滑块值

    // 表区起点（与 Compositor 的 CameraRawTables.swift 布局一致）
    const WB_START = 0, EXPO_START = 81, WHITES_START = 102, BLACKS_START = 111,
        SAT_START = 120, VIB_START = 129, CON_START = 138, HI_START = 187,
        SH_START = 236, MIXER_START = 285, CAL_START = 405, PARAM_START = 435,
        GRAD_START = 455, GRAD_LUM_START = 743;

    // 三维合成网格：Compositor 用 33（比 17 的表更细，合成本身几乎不增加模糊）。
    // 实测绘：33³ × 24~30 级合成在 JS 里约 23~27ms，够交互式拖动。
    const GRID = 33;
    // 混色器 8 带的顺序必须与 Compositor 一致（red, orange, yellow, green, aqua, blue, purple, magenta）
    const MIX_KEYS = ['r', 'o', 'y', 'g', 'a', 'b', 'p', 'm'];

    let T = null;        // { size, count, step, data, entries }
    let loading = null;  // Promise

    function ensure() {
        if (T) return Promise.resolve(true);
        if (!loading) {
            const api = window.qingframe;
            if (!api || !api.loadAcrTables) { loading = Promise.resolve(false); return loading; }
            loading = api.loadAcrTables().then((r) => {
                if (!r || !r.data) return false;
                T = decode(r);
                return !!T;
            }).catch(() => false);
        }
        return loading;
    }

    // 主进程已 zlib.inflate；这里做差分解码（每表每通道是前值增量）
    function decode(r) {
        try {
            const size = r.size, count = r.count, step = r.step;
            const cells = size * size * size, entries = cells * 3;
            const src = new Uint8Array(r.data);
            if (src.length !== count * entries) return null;
            const out = new Uint8Array(count * entries);
            const level = [];
            for (let i = 0; i < size; i++) level.push(Math.round(i * 255 / (size - 1)));
            for (let t = 0; t < count; t++) {
                for (let ch = 0; ch < 3; ch++) {
                    const base = (t * 3 + ch) * cells;
                    let running = 0;
                    for (let cell = 0; cell < cells; cell++) {
                        running += (src[base + cell] << 24) >> 24;
                        const axis = ch === 0 ? (cell / (size * size)) | 0
                            : ch === 1 ? ((cell / size) | 0) % size : cell % size;
                        let v = level[axis] + running * step;
                        out[t * entries + cell * 3 + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
                    }
                }
            }
            return { size, count, step, data: out, entries };
        } catch (_) { return null; }
    }

    // 一段连续取值里的两个表下标与分数（Swift 的 between(_:low:step:tables:)）
    function span(value, low, step, tables) {
        const pos = Math.min(tables - 1, Math.max(0, (value - low) / step));
        const idx = Math.min(tables - 2, Math.floor(pos));
        return [idx, pos - idx];
    }

    // 混合一个 stage（最多 8 张表）在灰轴对角线上的每通道响应。
    // 返回 {r,g,b}：各 17 个格子（0..255 等距）的输出。
    function stageDiag(parts) {
        const size = T.size, entries = T.entries, data = T.data;
        const cell0 = size * size, out = { r: [], g: [], b: [] };
        for (let i = 0; i < size; i++) {
            const cell = i * cell0 + i * size + i;
            let sr = 0, sg = 0, sb = 0;
            for (let k = 0; k < parts.length; k++) {
                const p = parts[k];
                if (!p || p.w === 0 || p.off < 0) continue;
                const base = p.off * entries + cell * 3;
                sr += p.w * data[base];
                sg += p.w * data[base + 1];
                sb += p.w * data[base + 2];
            }
            out.r.push(sr); out.g.push(sg); out.b.push(sb);
        }
        return out;
    }

    // ── 各滑块的 stage 构造（与 Swift 一一对应）──
    function whiteBalance(temp, tint) {
        const [row, down] = span(temp, -100, 25, 9);
        const [col, across] = span(tint, -100, 25, 9);
        const b = WB_START + row * 9 + col;
        return [
            { off: b, w: (1 - down) * (1 - across) }, { off: b + 1, w: (1 - down) * across },
            { off: b + 9, w: down * (1 - across) }, { off: b + 10, w: down * across }
        ];
    }
    function exposure(ev) {
        const [i, f] = span(ev, -5, 0.5, 21);
        return [{ off: EXPO_START + i, w: 1 - f }, { off: EXPO_START + i + 1, w: f }];
    }
    function plain(start, v) {
        const [i, f] = span(v, -100, 25, 9);
        return [{ off: start + i, w: 1 - f }, { off: start + i + 1, w: f }];
    }
    // 自适应档（对比度/高光/阴影）：亮度行 × 滑块值列，四表混合
    function adaptive(start, value, brightness) {
        const [row, down] = betweenPts(brightness, BRIGHT);
        const [col, across] = betweenPts(value, AVAL);
        const width = AVAL.length, base = start + row * width + col;
        return [
            { off: base, w: (1 - down) * (1 - across) }, { off: base + 1, w: (1 - down) * across },
            { off: base + width, w: down * (1 - across) }, { off: base + width + 1, w: down * across }
        ];
    }
    function betweenPts(value, pts) {
        const v = Math.min(pts[pts.length - 1], Math.max(pts[0], value));
        let i = 0;
        while (i < pts.length - 2 && v > pts[i + 1]) i++;
        return [i, (v - pts[i]) / (pts[i + 1] - pts[i])];
    }
    function fifty(start, v) {
        const [i, f] = span(v, -100, 50, 5);
        return [{ off: start + i, w: 1 - f }, { off: start + i + 1, w: f }];
    }

    // 17 格对角线 → 256 级每通道 LUT（线性插值，端点钳制）
    function toLut256(diag) {
        const size = T.size, lut = new Array(256);
        for (let i = 0; i < 256; i++) {
            const x = i * (size - 1) / 255;
            const i0 = Math.min(size - 2, Math.floor(x)), f = x - i0;
            lut[i] = (diag[i0] * (1 - f) + diag[i0 + 1] * f) / 255;
        }
        lut[0] = Math.min(lut[0], lut[1]);
        lut[255] = Math.max(lut[255], lut[254]);
        return lut;
    }

    // 依次施加多个 stage 的对角线（灰进灰出，通道不发散时安全）
    function composeDiags(diags) {
        // diags: [{r,g,b}]，把后一个作用在前一个的输出上（按 17 格线性插值）
        return diags.reduce((acc, d) => {
            const out = { r: [], g: [], b: [] };
            for (let c = 0; c < 3; c++) {
                const key = ['r', 'g', 'b'][c], src = acc[key], fn = d[key];
                for (let i = 0; i < T.size; i++) {
                    const v = src[i] / 255 * (T.size - 1);
                    const i0 = Math.min(T.size - 2, Math.max(0, Math.floor(v))), f = v - i0;
                    out[key].push(fn[i0] * (1 - f) + fn[i0 + 1] * f);
                }
            }
            return out;
        });
    }

    // ── 对外：色调 stage 组（曝光→白平衡→对比度→高光→阴影→白→黑）──
    // bright = { con, hi, sh } 三种亮度测度（0..255，缺省 128）
    function toneStages(p, bright) {
        if (!T) return null;
        bright = bright || {};
        const bc = bright.con == null ? 128 : bright.con;
        const bh = bright.hi == null ? 128 : bright.hi;
        const bs = bright.sh == null ? 128 : bright.sh;
        const stages = {};
        if (p.exp) stages.exp = stageDiag(exposure(Math.max(-5, Math.min(5, p.exp))));
        if (p.temp || p.tint) stages.wb = stageDiag(whiteBalance(p.temp || 0, p.tint || 0));
        if (p.con) stages.con = stageDiag(adaptive(CON_START, p.con, bc));
        if (p.hi) stages.hi = stageDiag(adaptive(HI_START, p.hi, bh));
        if (p.sh) stages.sh = stageDiag(adaptive(SH_START, p.sh, bs));
        if (p.white) stages.white = stageDiag(plain(WHITES_START, p.white));
        if (p.black) stages.black = stageDiag(plain(BLACKS_START, p.black));
        if (!Object.keys(stages).length) return null;
        // 按键序组合成一条复合对角线（ACR 顺序）
        const order = ['exp', 'wb', 'con', 'hi', 'sh', 'white', 'black'];
        const chain = order.map((k) => stages[k]).filter(Boolean);
        const d = chain.length === 1 ? chain[0] : composeDiags(chain);
        return { r: toLut256(d.r), g: toLut256(d.g), b: toLut256(d.b) };
    }

    // 参数曲线：用实测参数曲线表替换公式换算（值 −100..100 步 50）
    // 返回 17 格控制点 [{x,y}…]（0..1），失败返回 null
    function parametricDiag(sh, dk, lt, hi) {
        if (!T) return null;
        const stages = [];
        if (sh) stages.push(stageDiag(fifty(PARAM_START + 0 * 5, sh)));
        if (dk) stages.push(stageDiag(fifty(PARAM_START + 1 * 5, dk)));
        if (lt) stages.push(stageDiag(fifty(PARAM_START + 2 * 5, lt)));
        if (hi) stages.push(stageDiag(fifty(PARAM_START + 3 * 5, hi)));
        if (!stages.length) return null;
        const d = stages.length === 1 ? stages[0] : composeDiags(stages);
        const size = T.size, pts = [];
        for (let i = 0; i < size; i++) {
            const y = Math.max(0, Math.min(1, d.r[i] / 255));   // 灰轴上三通道一致
            pts.push([Math.round(i / (size - 1) * 100) / 100, Math.round(y * 100) / 100]);
        }
        // 单调性兜底
        for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
        return pts;
    }

    // ── 三维合成：混色器 / 校准 / 饱和度 / 自然饱和度 / 颜色分级 ─────
    // 这些档位是**跨通道**的（同一个滑块对红黄蓝的作用完全不同），灰轴对角线
    // 提取不出来，必须整格合成。Compositor 正是把这些 stage 合成到 33³ 再查表。
    const _blend = new Float32Array(17 * 17 * 17 * 3);
    // 「不变」的那张表：颜色分级在饱和度落到 0 档时 Compositor 放的是 nil，
    // 权重缺口必须补成恒等（否则权重和不为 1，绝对输出会被按缺口比例压暗 ——
    // 实测整套预设会整整暗 4 倍）。
    let IDENT = null;
    function buildIdent() {
        const size = T.size, cells = size * size * size;
        const level = [];
        for (let i = 0; i < size; i++) level.push(Math.round(i * 255 / (size - 1)));
        const out = new Float32Array(cells * 3);
        for (let cell = 0; cell < cells; cell++) {
            out[cell * 3] = level[(cell / (size * size)) | 0];
            out[cell * 3 + 1] = level[((cell / size) | 0) % size];
            out[cell * 3 + 2] = level[cell % size];
        }
        return out;
    }

    // 把一个 stage（最多 8 张表 + 权重）混成一张 17³ 表。用 Float32 中间量，
    // 免得每级都量化一次（8 级串下来会攒出可见误差）。
    function blendInto(parts) {
        const entries = T.entries, data = T.data;
        if (!IDENT) IDENT = buildIdent();
        _blend.fill(0);
        let wsum = 0;
        for (let k = 0; k < parts.length; k++) {
            const p = parts[k];
            if (!p || p.w === 0 || p.off < 0 || p.off >= T.count) continue;
            const base = p.off * entries, w = p.w;
            wsum += w;
            for (let i = 0; i < entries; i++) _blend[i] += w * data[base + i];
        }
        const miss = 1 - wsum;
        if (miss > 1e-6 || miss < -1e-6) {
            for (let i = 0; i < entries; i++) _blend[i] += miss * IDENT[i];
        }
    }

    // 把一组 stage 依次作用到 grid³ 网格上：每级一次三线性采样。
    // 表存的是**绝对输出色**（level + 累计增量），所以合成就是 f_n(…f_1(c))。
    function compose3d(partsList, grid) {
        const n = grid * grid * grid;
        const cur = new Float32Array(n * 3);
        const lv = new Float32Array(grid);
        for (let i = 0; i < grid; i++) lv[i] = i * 255 / (grid - 1);
        let q = 0;
        for (let bi = 0; bi < grid; bi++) {
            for (let gi = 0; gi < grid; gi++) {
                for (let ri = 0; ri < grid; ri++, q += 3) {
                    cur[q] = lv[ri]; cur[q + 1] = lv[gi]; cur[q + 2] = lv[bi];
                }
            }
        }
        const SZ = T.size, S = SZ - 1, P2 = SZ * SZ, P3 = P2 * 3, R3 = SZ * 3;
        for (let s = 0; s < partsList.length; s++) {
            blendInto(partsList[s]);
            let p3 = 0;
            for (let i = 0; i < n; i++, p3 += 3) {
                const x = cur[p3] * (S / 255), y = cur[p3 + 1] * (S / 255), z = cur[p3 + 2] * (S / 255);
                let i0 = x | 0; if (i0 > S - 1) i0 = S - 1;
                let j0 = y | 0; if (j0 > S - 1) j0 = S - 1;
                let k0 = z | 0; if (k0 > S - 1) k0 = S - 1;
                const fx = x - i0, fy = y - j0, fz = z - k0;
                // 格子里 r 最慢、b 最快，每格 3 字节：r 邻 +P3、g 邻 +R3、b 邻 +3
                const o = (i0 * P2 + j0 * SZ + k0) * 3;
                const oi = o + P3, oj = o + R3, oij = oi + R3;
                const ok = o + 3, oik = oi + 3, ojk = oj + 3, oijk = oij + 3;
                const w0 = 1 - fx;
                for (let ch = 0; ch < 3; ch++) {
                    const v00 = _blend[o + ch] * w0 + _blend[oi + ch] * fx;
                    const v10 = _blend[oj + ch] * w0 + _blend[oij + ch] * fx;
                    const v01 = _blend[ok + ch] * w0 + _blend[oik + ch] * fx;
                    const v11 = _blend[ojk + ch] * w0 + _blend[oijk + ch] * fx;
                    const v0 = v00 + (v10 - v00) * fy, v1 = v01 + (v11 - v01) * fy;
                    cur[p3 + ch] = v0 + (v1 - v0) * fz;
                }
            }
        }
        // RGBA：行字节数天然 4 对齐，上传纹理不用改 UNPACK_ALIGNMENT。
        // 纹理是 grid 张 grid×grid 切片横排（宽 grid*grid、高 grid）：
        // 纹素 (x=bi*grid+ri, y=gi)，所以这里要按**纹素序**落盘，不能直接用节点序。
        const rgba = new Uint8Array(n * 4);
        for (let gi = 0; gi < grid; gi++) {
            for (let bi = 0; bi < grid; bi++) {
                for (let ri = 0; ri < grid; ri++) {
                    const s3 = (bi * grid * grid + gi * grid + ri) * 3;
                    const d4 = (gi * grid * grid + bi * grid + ri) * 4;
                    for (let ch = 0; ch < 3; ch++) {
                        const v = Math.round(cur[s3 + ch]);
                        rgba[d4 + ch] = v < 0 ? 0 : (v > 255 ? 255 : v);
                    }
                    rgba[d4 + 3] = 255;
                }
            }
        }
        return { grid, rgba };
    }

    // 校准：红/绿/蓝 各自的色相与饱和，顺序与 Swift 一致
    function calStages(cal) {
        const out = [];
        const vals = [cal.rh, cal.rs, cal.gh, cal.gs, cal.bh, cal.bs];
        for (let i = 0; i < 6; i++) {
            const v = Number(vals[i]) || 0;
            if (v) out.push(fifty(CAL_START + i * 5, v));
        }
        return out;
    }

    // 混色器：明亮度 → 饱和度 → 色相（Compositor 实测出「这个顺序合成才像 PS」）
    function mixerStages(mix) {
        const out = [];
        const kinds = ['l', 's', 'h'];
        for (let kind = 0; kind < 3; kind++) {
            for (let c = 0; c < 8; c++) {
                const band = mix[MIX_KEYS[c]];
                const v = band ? (Number(band[kinds[kind]]) || 0) : 0;
                if (v) out.push(fifty(MIXER_START + (kind * 8 + c) * 5, v));
            }
        }
        return out;
    }

    // 颜色分级：先四个亮度滑块，再 全局 → 中间调 → 高光 → 阴影（Compositor 的顺序）
    function gradingStages(cg) {
        const out = [];
        const zones = ['shadow', 'mid', 'high', 'global'];   // 亮度表下标 0..3
        for (let i = 0; i < 4; i++) {
            const z = cg[zones[i]] || {};
            const l = Number(z.l) || 0;
            if (l) out.push(fifty(GRAD_LUM_START + i * 5, l));
        }
        const bal = (Number(cg.balance) || 0) / 100;
        const hiShare = Math.max(0, bal < 0 ? 1 + 1.4 * bal : 1 + 2 * bal);
        const shShare = Math.max(0, bal < 0 ? 1 - 1.2 * bal : 1 - 1.4 * bal);
        const bl = Number.isFinite(Number(cg.blending)) ? Number(cg.blending) : 50;
        const [blendLow, blendUp] = betweenPts(bl, [0, 50, 100]);
        // [轮下标, 我们的分区键, 平衡占比, 是否随 Blending 插值]
        const wheels = [[3, 'global', 1, false], [2, 'mid', 1, false],
            [1, 'high', hiShare, true], [0, 'shadow', shShare, true]];
        for (const w of wheels) {
            const wheel = w[0], z = cg[w[1]] || {}, s = (Number(z.s) || 0) * w[2];
            if (!(s > 0)) continue;
            const h = ((Number(z.h) || 0) % 360 + 360) % 360;
            const pos = h / 30;
            const first = Math.floor(pos) % 12, second = (first + 1) % 12;
            const around = pos - Math.floor(pos);
            const [level, up] = betweenPts(s, [0, 25, 50, 100]);
            const parts = [];
            const blendings = w[3] ? [[blendLow, 1 - blendUp], [blendLow + 1, blendUp]] : [[1, 1]];
            for (let bi = 0; bi < blendings.length; bi++) {
                const bIdx = blendings[bi][0], bW = blendings[bi][1];
                const base = bIdx === 0 ? GRAD_START + wheel * 36
                    : (bIdx === 1 ? GRAD_START + 72 + wheel * 36 : GRAD_START + 216 + wheel * 36);
                const hues = [[first, 1 - around], [second, around]];
                const sats = [[level, 1 - up], [level + 1, up]];
                for (let hi2 = 0; hi2 < 2; hi2++) {
                    for (let si = 0; si < 2; si++) {
                        const sat = sats[si][0];
                        if (sat === 0) continue;   // 没有「饱和 0」这张表，等于不变
                        parts.push({ off: base + hues[hi2][0] * 3 + sat - 1, w: bW * hues[hi2][1] * sats[si][1] });
                    }
                }
            }
            if (parts.length) out.push(parts.slice(0, 8));
        }
        return out;
    }

    // ── 对外：颜色侧三维 LUT（校准 → 饱和度 → 自然饱和度 → 混色器 → 颜色分级）──
    // 返回 { grid, rgba }；没有可测档位时返回 null（调用方退回原路径）。
    // 两个常用网格各留一份缓存：预览用小网格（快），静置/导出用大网格（精）。
    // 只留一份会在「拖动→静置」来回时反复重算。
    const _lutCache = {};
    let _lutSeq = 0;
    function colorLut(p, grid) {
        if (!T || !p) return null;
        const parts = [];
        if (p.cal) parts.push.apply(parts, calStages(p.cal));
        const sat = Number(p.sat) || 0;
        if (sat) parts.push(plain(SAT_START, sat));
        const vib = Number(p.vib) || 0;
        if (vib) parts.push(plain(VIB_START, vib));
        if (p.mix) parts.push.apply(parts, mixerStages(p.mix));
        if (p.cg) parts.push.apply(parts, gradingStages(p.cg));
        if (!parts.length) return null;
        const key = parts.map((q) => q.map((x) => x.off + ':' + x.w.toFixed(4)).join(' ')).join('|');
        const g = grid || GRID;
        const slot = _lutCache[g];
        if (slot && slot.key === key && slot.lut) return slot.lut;
        const out = compose3d(parts, g);
        out.token = ++_lutSeq;   // 纹理上传的变更凭据
        _lutCache[g] = { key, lut: out };
        return out;
    }

    // 图片亮度测度（与 Swift 的 Brightness 一致）：最亮通道均值的线性光均值、
    // 最亮通道的对数平均、平均亮度，都编码回 sRGB 级（0..255）。
    function measureBrightness(src) {
        const fallback = { con: 128, hi: 128, sh: 128 };
        if (!src || !src.naturalWidth) return fallback;
        try {
            const w = 96, h = Math.max(1, Math.round(96 * src.naturalHeight / src.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, w, h);
            const d = g.getImageData(0, 0, w, h).data;
            let sumB = 0, sumL = 0, sumLog = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 8) continue;
                const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
                const mx = Math.max(r, gg, b);
                const lin = mx <= 0.04045 ? mx / 12.92 : Math.pow((mx + 0.055) / 1.055, 2.4);
                const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
                sumB += lin; sumL += lum; sumLog += Math.log(Math.max(1e-4, lin)); n++;
            }
            if (!n) return fallback;
            const enc = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
            return {
                con: Math.round(enc(sumB / n) * 255),
                sh: Math.round(enc(sumL / n) * 255),
                hi: Math.round(enc(Math.exp(sumLog / n)) * 255)
            };
        } catch (_) { return fallback; }
    }

    // Camera Raw 去薄雾用的「雾色」：全图最亮 1% 像素的平均色（按亮度阈值取）。
    // 移植自 Compositor 的 dehaze_haze()，同样在缩略图上算——最亮 1% 的均值
    // 对分辨率不敏感，而全图扫两遍在拖动时太贵。
    function dehazeHaze(src) {
        if (!src || !src.naturalWidth) return null;
        try {
            const w = 192, h = Math.max(1, Math.round(192 * src.naturalHeight / src.naturalWidth));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, w, h);
            const d = g.getImageData(0, 0, w, h).data;
            const hist = new Float64Array(256);
            const n = w * h;
            for (let i = 0, p = 0; i < n; i++, p += 4) {
                const level = Math.round(255 * (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255);
                hist[level < 0 ? 0 : (level > 255 ? 255 : level)]++;
            }
            let total = 0;
            for (let i = 0; i < 256; i++) total += hist[i];
            if (!total) return null;
            let threshold = 255;
            for (let above = 0; threshold > 0 && above + hist[threshold] < total * 0.01; --threshold) above += hist[threshold];
            // 阈值之上一个像素都没有时（纯色图），把阈值降到底：整幅都是雾，ACR 也是不动它
            let sumR = 0, sumG = 0, sumB = 0, weight = 0;
            for (let i = 0, p = 0; i < n; i++, p += 4) {
                const level = Math.round(255 * (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255);
                if (level < threshold) continue;
                sumR += d[p]; sumG += d[p + 1]; sumB += d[p + 2]; weight++;
            }
            if (!weight) return null;
            return [sumR / weight / 255, sumG / weight / 255, sumB / weight / 255];
        } catch (_) { return null; }
    }

    window.QfsAcr = {
        ensure,
        ready: () => !!T,
        grid: GRID,
        toneStages,
        colorLut,
        parametricDiag,
        measureBrightness,
        dehazeHaze,
        diag256: (stage) => T ? { r: toLut256(stage.r), g: toLut256(stage.g), b: toLut256(stage.b) } : null
    };

    // 启动即后台解压（首次拖滑块前基本就绪；没就绪时 buildTables 走公式兜底）
    ensure();
})();
