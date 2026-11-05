/* 锐化（LR 的「捕获锐化」）：只作用于亮度的 USM。
 *
 * 为什么不用 SVG 滤镜：
 *   out = rgb + a·(Y − blur(Y)) 里的 (Y − blur) 有正有负，而 feComposite 的
 *   arithmetic 结果会钳到 [0,1]，负半边直接没了；换成「先加 a·Y 再减 a·blur」
 *   又会在亮部中间结果饱和（实测高频反而掉 26%~63%，亮部整片压平）。
 *   feComposite 的 alpha 也按同一公式算，k3 取负会让 alpha 掉到 1−a，
 *   预乘存储下颜色跟着被缩放 —— 这条路没有干净写法。
 *
 * 所以走 CPU：和阴影 pass 同样的做法，取一次 ImageData、逐像素算、放回去。
 * 好处是能拿到带符号的浮点高通，也能做真正的边缘蒙版（masking）——
 * 而「保护平滑区域」正是锐化最容易出问题的地方（天空、皮肤、噪点）。
 *
 * 注意：这个文件现在是**兜底与像素基准**。硬件 GPU 可用时，app-color-grade.js
 * 的 sharpenCanvas() 会用同一套公式跑三趟 pass（横/纵高斯 + 合成），23MP 实测
 * 1064ms → ~100ms；两条路径用 tools/sharpen-gl-check.js 卡在最大差 ≤3 级。
 * 软件 GL（swiftshader）上 GPU 反而更慢，那边会主动回退到这里。
 *
 * 顺序：在颜色表与阴影之后、蒙版合成完之后调用一次（见 app-grade.js bake）。
 * LR 是在色调映射之前锐化，但我们的色调是逐通道 LUT，且实测对齐用的是最终像素，
 * 放在表后面更好控。
 */
(function () {
    'use strict';

    // 高斯核：半径 3σ，σ 很小（0.3~3px）时窗口只有几格，直接卷积就够快
    let _kSig = -1, _kR = 0, _kArr = null;
    function kernel(sigma) {
        if (sigma === _kSig) return { r: _kR, a: _kArr };
        const r = Math.max(1, Math.round(sigma * 3));
        const n = r * 2 + 1;
        const a = new Float32Array(n);
        const s2 = 2 * sigma * sigma;
        let sum = 0;
        for (let i = -r; i <= r; i++) {
            const v = Math.exp(-(i * i) / s2);
            a[i + r] = v; sum += v;
        }
        for (let i = 0; i < n; i++) a[i] /= sum;
        _kSig = sigma; _kR = r; _kArr = a;
        return { r, a };
    }

    // 参数：和 app-grade.js 的 sharpenParams 同一套语义
    // longPx = 本次烘焙的长边，fullPx = 原图长边；两者一起决定半径该落在哪个像素密度上。
    const REF_LONG = 1600;
    function paramsOf(det, longPx, fullPx) {
        const shp = Number(det && det.shp) || 0;
        if (shp <= 0) return null;
        const shr = Number(det.shr) || 1;
        const shd = Number.isFinite(Number(det.shd)) ? Number(det.shd) : 25;
        const shm = Number(det.shm) || 0;
        // 力度：实测标定，不是拍脑袋。
        // 拿 LR 自己的同图同预设导出当目标，用六级 DoG（σ 0.7~4.5）的 RMS 当谱，
        // 在对数域上最小平方拟合（tools/sharpen-fit.js、tools/sharpen-sim.js）。
        // 结论：
        //   · 我们未锐化时，墙面区每个频段都只有 LR 的 1/1.43~1/1.15，越细缺得越多
        //     —— 这才是「锐化」该补的形状（高频多补、低频少补）；
        //   · 老的 σ=2.95 / amount=0.45 形状是错的：最细一级刚好，中粗频段却超出
        //     12~15% —— 加的是局部对比，不是锐度，所以看着「发闷但不锐」；
        //   · 修正半径后，单看力度只需要 amount≈0.66，但那只在蒙版不吃权重时成立。
        //     实测蒙版平均权重只有 0.44（见下面 t0），所以最终要 1.0 才补得回来。
        // ×2.4 就是把 shp=40 映射到实测需要的 amount≈1.0。
        const dGain = 0.85 + 0.3 * shd / 100;
        // 半径：LR 的 Radius 是**原图像素**（这份预设是 0.5）。我们的烘焙分辨率随场景
        // 变化（拖动 1600、静止按原图），所以先算出它占原图的比例，再折回本次烘焙：
        //   σ_baked = shr · 1.5 · (longPx / fullPx)
        // 原图上 shr=0.5 得 σ=0.75，与上面的拟合一致。
        // 老的写法是 `shr·1.6·(longPx/1600)`，在原图烘焙时被放大到 2.95px，
        // 比 LR 的 0.5 宽了近 6 倍，整个锐化落到了错误的频带上。
        const long = longPx > 0 ? longPx : REF_LONG;
        const full = fullPx > 0 ? fullPx : long;
        const dens = Math.max(0.12, Math.min(1, long / full));
        if (dens < 0.5) {
            // 小尺寸烘焙（边框墙「本图预览」560 这类直接出图的小档）：
            // 这里**不能**套用 LR 等效半径 —— 0.75px 折到 560 只剩 0.07px，物理上不成立。
            // 但也不能像上一版那样直接跳过：560px 卡片在 2x 屏上是放大的，缩图重采样
            // 本来就软，不补一刀整面墙都会「糊」。这类烘焙的目标不是复现捕获锐化，
            // 而是**补偿缩放损失**，所以走独立的经验档：
            //   · 半径固定 0.6（8 位画布上再小就没有意义）；
            //   · 力度用改前的 1.1 系数（×2.4 是给原图等效锐化标定的，放这里会过火，
            //     560 上压出硬边和 webp 码纹）；
            //   · 蒙版尺度回到 24（缩略图的梯度本来就小，用 10 会几乎全落在地板上）。
            //
            // 注意：拖动中的 1600 预览**不**走这里 —— 它是过渡帧，松手 220ms 后就被
            // 全分辨率档替换，bake() 直接跳过锐化（那一刀实测 76ms，正好卡在手感上）。
            // 这一档留给真正以低分辨率交付的场景（小尺寸导出、未来的缩略图直出）。
            return {
                amount: Math.min(2, (shp / 100) * 1.1 * dGain),
                radius: 0.6,
                masking: Math.max(0, Math.min(100, shm)),
                maskScale: 24,
                lumPow: Number.isFinite(window.QfsSharpen._lumPow) ? window.QfsSharpen._lumPow : 0.5
            };
        }
        return {
            amount: Math.min(2, (shp / 100) * 2.4 * dGain),
            radius: Math.max(0.55, Math.min(14, shr * 1.5 * dens)),
            masking: Math.max(0, Math.min(100, shm)),
            lumPow: Number.isFinite(window.QfsSharpen._lumPow) ? window.QfsSharpen._lumPow : 0.5
        };
    }

    // 就地锐化画布。det = grade.det（含 shp/shr/shd/shm），
    // longPx = 烘焙长边，fullPx = 原图长边（缺省按 1:1 处理）
    function applyCanvas(canvas, det, longPx, fullPx) {
        const P = paramsOf(det, longPx, fullPx);
        if (!P || P.amount <= 0.002) return false;
        const W = canvas.width, H = canvas.height;
        if (W < 3 || H < 3) return false;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        const img = g.getImageData(0, 0, W, H);
        const d = img.data;
        const n = W * H;
        const K = kernel(P.radius);
        const r = K.r, k = K.a;

        // ① 横向：逐行抽亮度再做一维卷积，结果按行存进 A。
        //    亮度只在需要时算，不额外留一份 L（全尺寸 Float32 在 24MP 上是 92MB）
        const A = new Float32Array(n);
        const row = new Float32Array(W);
        for (let y = 0; y < H; y++) {
            const base = y * W, off = base * 4;
            for (let x = 0; x < W; x++) {
                const p = off + x * 4;
                row[x] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
            }
            for (let x = 0; x < W; x++) {
                let s = 0;
                // 边界按**复制边缘像素**处理（索引钳制），不能把越界的抽头直接丢掉：
                // 丢掉等于核权重和 <1，离边 r 像素内会被压暗，最终在照片四周留下
                // 一圈亮边（r=5 时边缘能亮 +70 级）。GPU 通道的 CLAMP_TO_EDGE 就是
                // 这个语义，两边必须一致。
                for (let i = -r; i <= r; i++) {
                    let xi = x + i;
                    xi = xi < 0 ? 0 : (xi >= W ? W - 1 : xi);
                    s += row[xi] * k[i + r];
                }
                A[base + x] = s;
            }
        }

        // ② 纵向：按条带做，只为条带+halo 申请缓冲，避免再来一张全尺寸 Float32
        const STRIP = 128;
        const halo = r;
        const sh = STRIP + halo * 2;
        const B = new Float32Array(W * sh);
        const maskOn = P.masking > 0;
        // 蒙版是软过渡，不是开关：LR 在平滑区仍留一部分锐化（否则天空会「塑料感」）。
        // 下限随蒙版量递减，100 时才真正完全不锐平地。
        const floor = maskOn ? 0.35 * (1 - P.masking / 100) : 1;
        // 阈值尺度：梯度（相邻两像素的亮度差之和，0~255）到这个量级就算「满权重」。
        // 原先是 24（t0 = 蒙版量×24，t1 = t0+12），等于要求一条**强边缘**才给满锐化，
        // 普通纹理永远卡在斜坡中间。实测墙面区（有砖纹、无强边）平均权重只有 0.44,
        // 树叶区 0.74 —— 整套锐化被蒙版砍掉一半以上，这还是加上力度之后的结果。
        // 改成 10 之后，纹理区拿满、纯平滑区仍落在 floor 上（1 级梯度的天空不受影响）：
        // 墙面平均权重 0.44 → 0.74，树叶 0.74 → 0.87。
        // 小尺寸烘焙（见 paramsOf 的缩略图档）传 maskScale=24 退回旧尺度：
        // 缩略图的梯度被重采样平均掉一大截，用 10 会几乎全落在地板上。
        const MS = P.maskScale > 0 ? P.maskScale : 10;
        const t0 = maskOn ? (P.masking / 100) * MS : 0;
        const t1 = t0 + MS / 2;
        const amt = P.amount;
        // 亮度加权：两端都要收。
        //   · 暗部：同一份 delta 加到暗部，相对对比度会被放大（实测暗带高频涨得
        //     比亮带快 1.7 倍），按 √(L/255) 缓收。
        //   · 亮部：这里原本给的是**满强度**，结果树冠高光被推到 255，一片白斑、
        //     颜色直接没了。实测白场裁切从 0% 涨到 3.8%（PS 成片只有 0.01%），
        //     肉眼读成「掉色」而不是「更锐」。0.82 以上线性收到 0.5。
        const lp = Math.max(0, Math.min(1, P.lumPow));
        const LW = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            const lowEnd = 1 - lp + lp * Math.sqrt(t);
            const highEnd = t <= 0.82 ? 1 : 1 - 0.5 * (t - 0.82) / 0.18;
            LW[i] = lowEnd * highEnd;
        }
        // 余量保护：正 delta 按「离白点还剩多少」线性收。只收正方向——
        // 负 delta 往暗部走不会裁切，收它等于偷偷减锐。
        const HEAD = 24;

        for (let y0 = 0; y0 < H; y0 += STRIP) {
            const y1 = Math.min(H, y0 + STRIP);
            const sy0 = Math.max(0, y0 - halo), sy1 = Math.min(H, y1 + halo);
            // 纵向卷积
            for (let y = sy0; y < sy1; y++) {
                const dst = (y - sy0) * W;
                for (let x = 0; x < W; x++) {
                    let s = 0;
                    // 同横向：钳制索引（复制边缘），不丢抽头
                    for (let i = -r; i <= r; i++) {
                        let yi = y + i;
                        yi = yi < 0 ? 0 : (yi >= H ? H - 1 : yi);
                        s += A[yi * W + x] * k[i + r];
                    }
                    B[dst + x] = s;
                }
            }
            // 合成：delta = a · (L − blur) · w
            for (let y = y0; y < y1; y++) {
                const bRow = (y - sy0) * W;
                const aRow = y * W;
                const up = ((y > 0 ? y - 1 : 0) - sy0) * W;
                const dn = ((y < H - 1 ? y + 1 : H - 1) - sy0) * W;
                for (let x = 0; x < W; x++) {
                    const p = (aRow + x) * 4;
                    // L 必须用原亮度：A 是「横向已模糊」的中间量，拿它当底等于只锐纵向
                    const L = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
                    const hp = L - B[bRow + x];
                    let w = 1;
                    if (maskOn) {
                        const xl = x > 0 ? x - 1 : 0, xr = x < W - 1 ? x + 1 : W - 1;
                        const grad = Math.abs(B[bRow + xr] - B[bRow + xl])
                            + Math.abs(B[dn + x] - B[up + x]);
                        const r0 = grad <= t0 ? 0 : (grad >= t1 ? 1 : (grad - t0) / (t1 - t0));
                        w = floor + (1 - floor) * r0;
                        if (!w) continue;
                    }
                    const L255 = L < 0 ? 0 : (L > 255 ? 255 : L | 0);
                    let delta = amt * hp * w * LW[L255];
                    if (delta > 0) {
                        const mx = d[p] > d[p + 1] ? (d[p] > d[p + 2] ? d[p] : d[p + 2])
                            : (d[p + 1] > d[p + 2] ? d[p + 1] : d[p + 2]);
                        const head = 255 - mx;
                        if (head < HEAD) delta *= head <= 0 ? 0 : head / HEAD;
                    }
                    let v = d[p] + delta;
                    d[p] = v < 0 ? 0 : (v > 255 ? 255 : v);
                    v = d[p + 1] + delta;
                    d[p + 1] = v < 0 ? 0 : (v > 255 ? 255 : v);
                    v = d[p + 2] + delta;
                    d[p + 2] = v < 0 ? 0 : (v > 255 ? 255 : v);
                }
            }
        }
        g.putImageData(img, 0, 0);
        return true;
    }

    window.QfsSharpen = {
        applyCanvas,
        paramsOf,
        // 诊断口：UI 上不显示，只给 tools/ 下的标定脚本用
        info: () => ({})
    };
})();
