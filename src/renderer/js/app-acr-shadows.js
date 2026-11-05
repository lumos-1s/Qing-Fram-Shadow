// Camera Raw 的「阴影」不是一条色调曲线，而是一次**空间自适应**的压暗/提亮。
//
// 为什么不能用查找表：同一个 −30，全局表把整张图的暗部一起压暗（中间调也跟着掉），
// 而 PS/LR 只压「相对周围更暗、且整块区域低于全图参考亮度」的地方，同时把区域内的
// 纹理重新拉伸。实测对比时这一项就是主残差：把阴影关掉，LR 与我们的 25/50/75 分位
// 立刻重合，说明差的是**形状**而不是强度。
//
// 这里移植 Compositor 的 adjust_camera_raw_shadows（MIT）：
//   1. 参考亮度 key = 有纹理像素（与邻像素不同）的平均线性亮度，取 log2。
//   2. 区域亮度 = log2 亮度的边缘保持平滑（He 快速引导滤波，短边约 384 的缩略图上算），
//      得到 region = a·level + b。
//   3. detail = level − region；lift = Δ + 上增益·detail⁺ + 下增益·detail⁻，
//      系数按 (region−key, key) 双线性查表，表是在 260 张照片的 PS 渲染上拟合的。
//   4. 线性光乘 2^lift，色相比例不变。
// 系数表 CameraRawShadows.bin 原样取自 Compositor，分「长边 < 1020」和「≥ 1020」两套
// （PS 对小图抬得少），所以预览和导出各用自己那套，画面对得上。
'use strict';

(function () {
    const MAGIC = 'CRS2';
    const FLOOR_Y = 1 / 8192;      // 与 Compositor 的 floorY 一致
    const EPSILON = 1.5;           // 引导滤波的正则项
    const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;

    let S = null;       // 解码后的系数表
    let loading = null;

    function ensure() {
        if (S) return Promise.resolve(true);
        if (loading) return loading;
        const api = window.qingframe;
        if (!api || !api.loadAcrShadows) { loading = Promise.resolve(false); return loading; }
        loading = api.loadAcrShadows().then((r) => {
            S = decode(r);
            return !!S;
        }).catch(() => false);
        return loading;
    }

    // "CRS2" + 5 个 int16（组数/档位数/x 列/K 行/项数）+ 5 个 float32
    // （第二套的起始长边、x 的下界与步长、K 的下界与步长）；随后是档位值和系数，
    // 系数按「组 → 档位 → 项 → K 行 → x 列」排。
    function decode(buf) {
        try {
            const dv = new DataView(buf);
            const bytes = new Uint8Array(buf, 0, 4);
            let magic = '';
            for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
            if (magic !== MAGIC) return null;
            const sets = dv.getInt16(4, true), amounts = dv.getInt16(6, true);
            const xCount = dv.getInt16(8, true), kCount = dv.getInt16(10, true), terms = dv.getInt16(12, true);
            const per = xCount * kCount * terms, header = 34;
            if (sets !== 2 || amounts <= 0 || terms !== 3) return null;
            if (dv.byteLength !== header + amounts * 4 + sets * amounts * per * 4) return null;
            const values = [];
            for (let i = 0; i < amounts; i++) values.push(dv.getFloat32(header + i * 4, true));
            const start = header + amounts * 4;
            const coefficients = [];
            for (let s = 0; s < sets; s++) {
                const set = new Float32Array(amounts * per);
                for (let i = 0; i < amounts * per; i++) set[i] = dv.getFloat32(start + (s * amounts * per + i) * 4, true);
                coefficients.push(set);
            }
            return {
                normalFrom: dv.getFloat32(14, true), values, coefficients,
                xCount, kCount, per,
                xLow: dv.getFloat32(18, true), xStep: dv.getFloat32(22, true),
                kLow: dv.getFloat32(26, true), kStep: dv.getFloat32(30, true)
            };
        } catch (_) { return null; }
    }

    // 档位之间的混合：拟合档位两侧线性插值，0 档本身是「不变」，所以补一个零点。
    function coefficients(amount, set) {
        if (!S) return null;
        const pts = [];
        for (let i = 0; i < S.values.length; i++) pts.push([S.values[i], i]);
        pts.push([0, -1]);
        pts.sort((a, b) => a[0] - b[0]);
        const v = Math.min(pts[pts.length - 1][0], Math.max(pts[0][0], amount));
        let i = 0;
        while (i < pts.length - 2 && v > pts[i + 1][0]) i++;
        const lo = pts[i], hi = pts[i + 1];
        const t = (v - lo[0]) / (hi[0] - lo[0]);
        const src = S.coefficients[set], per = S.per;
        const out = new Float32Array(per);
        for (let j = 0; j < per; j++) {
            const a = lo[1] < 0 ? 0 : src[lo[1] * per + j];
            const b = hi[1] < 0 ? 0 : src[hi[1] * per + j];
            out[j] = a * (1 - t) + b * t;
        }
        return out;
    }

    // 每个邻域的均值（窗口在边界内缩，不是重复边缘）
    function boxMean(src, dst, width, height, radius) {
        const temp = new Float32Array(width * height);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            let sum = 0, lo = 0, hi = 0;
            for (let x = 0; x < width; x++) {
                const wantLo = x > radius ? x - radius : 0;
                const wantHi = x + radius + 1 < width ? x + radius + 1 : width;
                while (hi < wantHi) sum += src[row + hi++];
                while (lo < wantLo) sum -= src[row + lo++];
                temp[row + x] = sum / (hi - lo);
            }
        }
        for (let x = 0; x < width; x++) {
            let sum = 0, lo = 0, hi = 0;
            for (let y = 0; y < height; y++) {
                const wantLo = y > radius ? y - radius : 0;
                const wantHi = y + radius + 1 < height ? y + radius + 1 : height;
                while (hi < wantHi) sum += temp[hi++ * width + x];
                while (lo < wantLo) sum -= temp[lo++ * width + x];
                dst[y * width + x] = sum / (hi - lo);
            }
        }
    }

    // 区域亮度场：返回 { a, b, lw, lh, scale, key }
    // 一次扫描同时算 key（有纹理像素的线性亮度均值）和小图的 log2 亮度。
    // data 可以传进来复用（调用方已经 getImageData 时不要再来一次，全尺寸下那是一次
    // 十几毫秒的整幅拷贝）。
    function field(canvas, data, W, H) {
        if (!data) {
            W = canvas.width; H = canvas.height;
            data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
        }
        const d = data;
        const shortSide = Math.min(W, H);
        let scale = Math.floor(shortSide / 384);
        if (scale < 1) scale = 1;
        const lw = Math.ceil(W / scale), lh = Math.ceil(H / scale);
        const low = new Float32Array(lw * lh), weight = new Float32Array(lw * lh);

        const dec = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const e = i / 255;
            dec[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
        }

        let total = 0, textured = 0, all = 0, allCount = 0;
        const rowStride = W * 4;
        for (let y = 0; y < H; y++) {
            const row = y * rowStride;
            const cellRow = ((y / scale) | 0) * lw;
            for (let x = 0; x < W; x++) {
                const p = row + x * 4;
                if (d[p + 3] < 8) continue;
                const gv = d[p + 1];
                const isTex = (x > 0 && d[p - 3] !== gv) || (x + 1 < W && d[p + 5] !== gv)
                    || (y > 0 && d[p - rowStride + 1] !== gv) || (y + 1 < H && d[p + rowStride + 1] !== gv);
                const lum = LUMA_R * dec[d[p]] + LUMA_G * dec[gv] + LUMA_B * dec[d[p + 2]];
                all += lum; allCount++;
                if (isTex) { total += lum; textured++; }
                const cell = cellRow + ((x / scale) | 0);
                low[cell] += Math.log2(lum < FLOOR_Y ? FLOOR_Y : lum);
                weight[cell] += 1;
            }
        }
        const mean = textured > 0 ? total / textured : (allCount > 0 ? all / allCount : 0.18);
        const key = Math.log2(Math.max(FLOOR_Y, mean));
        for (let i = 0; i < low.length; i++) low[i] = weight[i] > 0 ? low[i] / weight[i] : key;

        // 引导滤波：a = var/(var+ε)、b = mean − a·mean，再把 a/b 各自平滑一次
        const lowShort = Math.min(lw, lh);
        let radius = Math.round(0.25 * lowShort);
        if (radius < 1) radius = 1;
        const cells = lw * lh;
        const mA = new Float32Array(cells), mB = new Float32Array(cells);
        const sq = new Float32Array(cells), tmp = new Float32Array(cells);
        boxMean(low, mA, lw, lh, radius);
        for (let i = 0; i < cells; i++) tmp[i] = low[i] * low[i];
        boxMean(tmp, sq, lw, lh, radius);
        for (let i = 0; i < cells; i++) {
            const variance = Math.max(0, sq[i] - mA[i] * mA[i]);
            const a = variance / (variance + EPSILON);
            tmp[i] = a;
            mB[i] = mA[i] - a * mA[i];
        }
        const aOut = new Float32Array(cells), bOut = new Float32Array(cells);
        boxMean(tmp, aOut, lw, lh, radius);
        boxMean(mB, bOut, lw, lh, radius);
        return { a: aOut, b: bOut, lw, lh, scale, key, W, H };
    }

    // 把一次 lift 量化成 8 位输出表：tab[j*256+v] = encode(decode(v) · 2^lift_j)。
    // 逐像素只做两次查表 + 一次插值，比每通道 pow 快一个数量级。
    const LIFT_MIN = -2, LIFT_MAX = 2, LIFT_STEPS = 129;
    const _tabCache = new Map();
    function gainTable(amount, set) {
        const key = set + '#' + amount;
        const hit = _tabCache.get(key);
        if (hit) return hit;
        const step = (LIFT_MAX - LIFT_MIN) / (LIFT_STEPS - 1);
        const tab = new Uint8Array(256 * LIFT_STEPS);
        for (let j = 0; j < LIFT_STEPS; j++) {
            const g = Math.pow(2, LIFT_MIN + step * j);
            const base = j * 256;
            for (let i = 0; i < 256; i++) {
                const e = i / 255;
                const lin = (e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4)) * g;
                const v = lin <= 0 ? 0 : lin >= 1 ? 1
                    : (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055);
                tab[base + i] = Math.round(v * 255);
            }
        }
        const out = { tab, step };
        // 只留最近两份：滑块拖动时 amount 连续变化，缓存没有意义，但静置重绘会命中
        if (_tabCache.size > 2) _tabCache.clear();
        _tabCache.set(key, out);
        return out;
    }

    // field 只取决于「阴影之前那张画布的像素」，与 sh 的取值无关。拖阴影滑块时每帧
    // 重算引导滤波是纯浪费：1600px 实测 field ~95ms、整次 apply ~225ms，光这一项就
    // 占去四成。调用方给一个能代表「画布内容」的键（同一张图 + 同一尺寸 + 同一套
    // 色调参数），命中就直接复用。
    //
    // 只留最近 3 份：正常使用只会在「同一张图」上反复命中；换图/缩放会自然淘汰。
    const _fieldCache = [];
    const FIELD_KEEP = 3;
    const _fstat = { calls: 0, hits: 0, misses: 0, keyed: 0, unkeyed: 0 };
    // getData 是**惰性**的：字段命中时根本不需要整幅像素。GL 通道只在首帧/换参数时
    // 才会走到 field()，其余帧连 getImageData（23MP 一次 92MB）都省了。
    function cachedField(key, canvas, W, H, getData) {
        _fstat.calls++;
        if (key) _fstat.keyed++; else _fstat.unkeyed++;
        if (key) {
            for (let i = 0; i < _fieldCache.length; i++) {
                const e = _fieldCache[i];
                // 不再要求 W/H 完全相等：场的格数按「短边/384」推导，同一张图在
                // 1600 与 23MP 上分别是 800×534 与 591×394，归一化坐标下是同一个
                // 场。键里已经带了长宽比，尺寸不同只是像素密度不同（见 fitField）。
                if (e.key === key) {
                    if (i > 0) { _fieldCache.splice(i, 1); _fieldCache.unshift(e); }
                    _fstat.hits++;
                    return e.f;
                }
            }
        }
        _fstat.misses++;
        const f = field(canvas, getData(), W, H);
        if (key && f) {
            _fieldCache.unshift({ key, W, H, f });
            while (_fieldCache.length > FIELD_KEEP) _fieldCache.pop();
        }
        return f;
    }

    // 把场的格点重采样到本次画布应有的格数。
    //
    // 场是归一化覆盖整幅画面的低频栅格；复用另一分辨率的场时，格数（lw/lh）与
    // 本次画布对不上。下游（CPU 的 (x+0.5)/scale 与 shader 的 uv*W/scale）都按
    // scale = 源像素/格点 换算，所以这里必须把它真的重采样成目标格数，而不是
    // 直接换个尺寸用 —— 否则 1600 的场铺到 23MP 上只会用到左边 1/4。
    //
    // 双线性、按格心对齐；每个目标尺寸的结果挂在源场对象上（通常只会有一个
    // 目标尺寸，内存 ~3MB）。场是平滑的，重采样误差远小于 1 级像素。
    function fitField(f, W, H) {
        const scale = Math.max(1, Math.floor(Math.min(W, H) / 384));
        const lw = Math.ceil(W / scale), lh = Math.ceil(H / scale);
        if (f.lw === lw && f.lh === lh) return f;
        const tag = lw + 'x' + lh;
        if (f.fit && f.fit[tag]) return f.fit[tag];
        const a = new Float32Array(lw * lh), b = new Float32Array(lw * lh);
        const sx = f.lw / lw, sy = f.lh / lh;
        const sx0 = new Int32Array(lw), sx1 = new Int32Array(lw), swx = new Float32Array(lw);
        for (let x = 0; x < lw; x++) {
            let fx = (x + 0.5) * sx - 0.5;
            fx = fx < 0 ? 0 : (fx > f.lw - 1 ? f.lw - 1 : fx);
            const i0 = fx | 0;
            sx0[x] = i0;
            sx1[x] = i0 + 1 < f.lw ? i0 + 1 : i0;
            swx[x] = fx - i0;
        }
        for (let y = 0; y < lh; y++) {
            let fy = (y + 0.5) * sy - 0.5;
            fy = fy < 0 ? 0 : (fy > f.lh - 1 ? f.lh - 1 : fy);
            const j0 = fy | 0, j1 = j0 + 1 < f.lh ? j0 + 1 : j0, wy = fy - j0;
            const r0 = j0 * f.lw, r1 = j1 * f.lw, dst = y * lw;
            for (let x = 0; x < lw; x++) {
                const i0 = sx0[x], i1 = sx1[x], wx = swx[x];
                const A0 = f.a[r0 + i0] * (1 - wx) + f.a[r0 + i1] * wx;
                const A1 = f.a[r1 + i0] * (1 - wx) + f.a[r1 + i1] * wx;
                const B0 = f.b[r0 + i0] * (1 - wx) + f.b[r0 + i1] * wx;
                const B1 = f.b[r1 + i0] * (1 - wx) + f.b[r1 + i1] * wx;
                a[dst + x] = A0 + (A1 - A0) * wy;
                b[dst + x] = B0 + (B1 - B0) * wy;
            }
        }
        const out = { a, b, lw, lh, scale, key: f.key, W, H };
        if (!f.fit) f.fit = {};
        f.fit[tag] = out;
        return out;
    }

    // 把这次要施加的阴影算成「一份数据、两种用法」：
    //   · GL 通道拿去当纹理（field 打包成 RGBA 浮点，rows 打包成 1×xc 的 RGB）；
    //   · CPU 通道拿去逐像素循环（applyCanvas）。
    // 两条路径共用同一份系数与场，像素口径才可能对得上。
    //
    // needPixels=false 时：字段命中就不取整幅像素，只返回纹理数据（拖动时的常态）。
    function prepare(canvas, amount, key, needPixels) {
        if (!S || !amount) return null;
        const W = canvas.width, H = canvas.height;
        if (W < 2 || H < 2) return null;
        const set = Math.max(W, H) >= S.normalFrom ? 1 : 0;
        const c = coefficients(amount, set);
        if (!c) return null;

        let img = null, g = null;
        const pixels = () => {
            if (!img) {
                g = canvas.getContext('2d', { willReadFrequently: true });
                img = g.getImageData(0, 0, W, H);
            }
            return img.data;
        };

        const fRaw = cachedField(key, canvas, W, H, pixels);
        const f = fRaw && fitField(fRaw, W, H);
        if (!f) return null;
        if (needPixels) pixels();     // 调用方要就地改像素，必须拿到 imageData

        // 档位之间按 k 双线性插值，得到三行（Δ / 上增益 / 下增益）在 x 上的采样
        const kp = Math.min(S.kCount - 1, Math.max(0, (f.key - S.kLow) / S.kStep));
        const k0 = Math.min(S.kCount - 1, Math.floor(kp)), k1 = Math.min(S.kCount - 1, k0 + 1), kt = kp - k0;
        const xc = S.xCount, plane = xc * S.kCount;
        const rows = [new Float32Array(xc), new Float32Array(xc), new Float32Array(xc)];
        for (let t = 0; t < 3; t++) {
            const base = t * plane;
            for (let x = 0; x < xc; x++) {
                const v0 = c[base + k0 * xc + x], v1 = c[base + k1 * xc + x];
                rows[t][x] = v0 * (1 - kt) + v1 * kt;
            }
        }

        // 场打包成纹理：RGBA 浮点，rg = a,b。只在场本身更新时打一次，
        // 之后每帧复用（场按 key 缓存在 _fieldCache 里，打包结果挂在它身上）。
        if (!f.tex) {
            const n = f.lw * f.lh, tex = new Float32Array(n * 4);
            for (let i = 0; i < n; i++) {
                tex[i * 4] = f.a[i];
                tex[i * 4 + 1] = f.b[i];
                tex[i * 4 + 3] = 1;
            }
            f.tex = tex;
        }
        if (!f.rows || f.rowsXc !== xc) {
            f.rowsXc = xc;
            f.rows = new Float32Array(xc * 4);
        }
        for (let x = 0; x < xc; x++) {
            f.rows[x * 4] = rows[0][x];
            f.rows[x * 4 + 1] = rows[1][x];
            f.rows[x * 4 + 2] = rows[2][x];
            f.rows[x * 4 + 3] = 1;
        }

        return {
            amount, key, img, g, f, rows,
            fieldTex: f.tex, rowsTex: f.rows,
            W, H, set, lw: f.lw, lh: f.lh, scale: f.scale,
            xc, xMax: xc - 1, keyOff: f.key + S.xLow, invStep: 1 / S.xStep
        };
    }

    // 在已经过色调（曝光/白平衡/对比度/高光/白/黑）的画布上就地施加阴影
    // key：可选的内容凭据，用来复用引导滤波的场（见 cachedField）
    //
    // 这是**兜底通道**：WebGL / 浮点纹理可用时走 QfsColor 的 shader（同一套场与系数），
    // 全分辨率实测 1387ms → 十几毫秒；逐像素实现保留给无 GL 环境，也用来做像素比对。
    function applyCanvas(canvas, amount, key) {
        const P = prepare(canvas, amount, key, true);
        if (!P) return false;
        const d = P.img.data;
        const f = P.f, W = P.W, H = P.H;
        const { tab, step } = gainTable(amount, P.set);
        const dec = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const e = i / 255;
            dec[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
        }
        const A = f.a, B = f.b, lw = f.lw, lh = f.lh, sc = f.scale;
        const r0 = P.rows[0], r1 = P.rows[1], r2 = P.rows[2];
        const xc = P.xc, xMax = P.xMax, invStep = P.invStep, keyOff = P.keyOff;
        const invJ = 1 / step, jMax = LIFT_STEPS - 1;

        // 每列的横向插值坐标与权重只算一次（原来是每像素一次除法 + 两次钳制）
        const ix0 = new Int32Array(W), ix1 = new Int32Array(W), wx = new Float32Array(W);
        for (let x = 0; x < W; x++) {
            let fx = (x + 0.5) / sc - 0.5;
            fx = fx < 0 ? 0 : (fx > lw - 1 ? lw - 1 : fx);
            const i0 = fx | 0;
            ix0[x] = i0;
            ix1[x] = i0 + 1 < lw ? i0 + 1 : i0;
            wx[x] = fx - i0;
        }

        for (let y = 0; y < H; y++) {
            let fy = (y + 0.5) / sc - 0.5;
            fy = fy < 0 ? 0 : (fy > lh - 1 ? lh - 1 : fy);
            const y0 = fy | 0, y1 = y0 + 1 < lh ? y0 + 1 : y0, ty = fy - y0;
            const rowA = y0 * lw, rowB = y1 * lw;
            let p = y * W * 4;
            for (let x = 0; x < W; x++, p += 4) {
                const lum = LUMA_R * dec[d[p]] + LUMA_G * dec[d[p + 1]] + LUMA_B * dec[d[p + 2]];
                if (lum <= FLOOR_Y) continue;
                const level = Math.log2(lum);
                const i0 = ix0[x], i1 = ix1[x], w1 = wx[x], w0 = 1 - w1;
                const aA = A[rowA + i0] * w0 + A[rowA + i1] * w1;
                const aB = A[rowB + i0] * w0 + A[rowB + i1] * w1;
                const bA = B[rowA + i0] * w0 + B[rowA + i1] * w1;
                const bB = B[rowB + i0] * w0 + B[rowB + i1] * w1;
                const sa = aA + (aB - aA) * ty, sb = bA + (bB - bA) * ty;
                const region = sa * level + sb;
                const detail = level - region;
                let xp = (region - keyOff) * invStep;
                xp = xp < 0 ? 0 : (xp > xMax ? xMax : xp);
                const c0 = xp | 0, c1 = c0 + 1 < xc ? c0 + 1 : c0, ct = xp - c0;
                const t0 = r0[c0] + (r0[c1] - r0[c0]) * ct;
                const t1 = r1[c0] + (r1[c1] - r1[c0]) * ct;
                const t2 = r2[c0] + (r2[c1] - r2[c0]) * ct;
                const lift = t0 + t1 * (detail > 0 ? detail : 0) + t2 * (detail < 0 ? detail : 0);
                let jf = (lift - LIFT_MIN) * invJ;
                jf = jf < 0 ? 0 : (jf > jMax ? jMax : jf);
                const j0 = jf | 0, jt = jf - j0;
                const o0 = j0 * 256, o1 = (j0 < jMax ? j0 + 1 : j0) * 256;
                const v0 = d[p], v1 = d[p + 1], v2 = d[p + 2];
                d[p] = tab[o0 + v0] + (tab[o1 + v0] - tab[o0 + v0]) * jt;
                d[p + 1] = tab[o0 + v1] + (tab[o1 + v1] - tab[o0 + v1]) * jt;
                d[p + 2] = tab[o0 + v2] + (tab[o1 + v2] - tab[o0 + v2]) * jt;
            }
        }
        P.g.putImageData(P.img, 0, 0);
        return true;
    }

    window.QfsShadows = {
        ensure,
        ready: () => !!S,
        applyCanvas,
        // GL 通道：把场与系数打包好交出去（不写画布），由 QfsColor 在 shader 里施加
        prepare,
        field,
        coefficients: (amount, longSide) => {
            if (!S) return null;
            return coefficients(amount, longSide >= S.normalFrom ? 1 : 0);
        },
        // 诊断用：把系数表的原始信息交出去
        info: () => S ? {
            normalFrom: S.normalFrom, amounts: S.values.slice(), xCount: S.xCount, kCount: S.kCount,
            xLow: S.xLow, xStep: S.xStep, kLow: S.kLow, kStep: S.kStep
        } : null,
        // 诊断用：场缓存的调用/命中次数（拖滑块时应当全是 hit）
        stats: () => Object.assign({}, _fstat, { cached: _fieldCache.length })
    };

    ensure();
})();
