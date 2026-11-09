// RAW 显影视图（裁切 + 90° 旋转）的纯函数用例：不启动 Electron，几十毫秒跑完。
//
// 这一层是整条 RAW 链路里最容易"看起来对、实际镜像/错位"的地方：
// 像素搬错一格，缩略图上看不出来，导出大图才会发现构图被翻了一面。
// 所以按坐标逐点断言：源 (x,y) 必须落在旋转后 (f(x,y)) 上。
//
// 用法：node tools/test-raw-view.js
'use strict';

const tm = require('../src/main/raw-tonemap.js');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 3 宽 × 2 高的灰度图，像素值 1..6，方便按坐标核对
const W = 3, H = 2;
const base = new Uint8Array([1, 2, 3, 4, 5, 6]);
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { rgb[i * 3] = base[i]; rgb[i * 3 + 1] = base[i]; rgb[i * 3 + 2] = base[i]; }
const px = (buf, w, x, y, ch) => Array.from(buf.subarray((y * w + x) * ch, (y * w + x) * ch + ch));

// ── 原样返回：整图 + 不旋转时零拷贝 ──
{
    const r = tm.cropRotate(rgb, W, H, 3, null, 0);
    check(r.data === rgb && r.width === W && r.height === H && r.colors === 3,
        '整图不旋转直接返回原缓冲（零拷贝）', `${r.width}×${r.height} same=${r.data === rgb}`);
}

// ── 裁切：右下 1/3 × 1/2 ──
{
    const r = tm.cropRotate(rgb, W, H, 3, { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }, 0);
    check(r.width === 1 && r.height === 1 && px(r.data, 1, 0, 0, 3)[0] === 6,
        '裁切按归一化坐标取右下角（x=2/3,y=1/2 → 像素 6）',
        `${r.width}×${r.height} v=${px(r.data, 1, 0, 0, 3)[0]}`);
}

// ── 顺时针 90°：源 (x,y) → 目标 (H-1-y, x) ──
{
    const r = tm.cropRotate(rgb, W, H, 3, null, 1);
    const got = [
        [px(r.data, r.width, 0, 0, 3)[0], px(r.data, r.width, 1, 0, 3)[0]],
        [px(r.data, r.width, 0, 1, 3)[0], px(r.data, r.width, 1, 1, 3)[0]],
        [px(r.data, r.width, 0, 2, 3)[0], px(r.data, r.width, 1, 2, 3)[0]]
    ];
    check(r.width === H && r.height === W && JSON.stringify(got) === JSON.stringify([[4, 1], [5, 2], [6, 3]]),
        '顺时针 90°：3×2 → 2×3，坐标逐点对上', JSON.stringify(got));
}

// ── 180°：源 (x,y) → 目标 (W-1-x, H-1-y) ──
{
    const r = tm.cropRotate(rgb, W, H, 3, null, 2);
    const got = [
        [px(r.data, 3, 0, 0, 3)[0], px(r.data, 3, 1, 0, 3)[0], px(r.data, 3, 2, 0, 3)[0]],
        [px(r.data, 3, 0, 1, 3)[0], px(r.data, 3, 1, 1, 3)[0], px(r.data, 3, 2, 1, 3)[0]]
    ];
    check(r.width === W && r.height === H && JSON.stringify(got) === JSON.stringify([[6, 5, 4], [3, 2, 1]]),
        '180°：宽高不变，画面倒过来', JSON.stringify(got));
}

// ── 逆时针 90°（turns=3）：源 (x,y) → 目标 (y, W-1-x) ──
{
    const r = tm.cropRotate(rgb, W, H, 3, null, 3);
    const got = [
        [px(r.data, r.width, 0, 0, 3)[0], px(r.data, r.width, 1, 0, 3)[0]],
        [px(r.data, r.width, 0, 1, 3)[0], px(r.data, r.width, 1, 1, 3)[0]],
        [px(r.data, r.width, 0, 2, 3)[0], px(r.data, r.width, 1, 2, 3)[0]]
    ];
    check(r.width === H && r.height === W && JSON.stringify(got) === JSON.stringify([[3, 6], [2, 5], [1, 4]]),
        '逆时针 90°（turns=3）：方向与顺时针相反', JSON.stringify(got));
}

// ── 单通道灰度：旋转后复制成 RGB，后面的 LUT/BGRA 不用再分情况 ──
{
    const r = tm.cropRotate(base, W, H, 1, null, 1);
    check(r.colors === 3 && r.width === 2 && r.height === 3
        && JSON.stringify(px(r.data, 2, 0, 0, 3)) === JSON.stringify([4, 4, 4]),
        '单通道输入转成 RGB，暗部值不被丢', JSON.stringify(px(r.data, 2, 0, 0, 3)));
}

// ── normalizeView：越界值夹回画面内，整图当没裁，旋转取模 ──
{
    const full = tm.normalizeView({ x: 0, y: 0, w: 1, h: 1 }, 0);
    check(full.crop === null && full.rotate === 0, '整图 + 不旋转 → crop=null（少一次全图拷贝）', JSON.stringify(full));
    const over = tm.normalizeView({ x: -0.4, y: 2, w: 3, h: 0 }, 0);
    const okOver = over.crop && over.crop.x >= 0 && over.crop.y <= 1
        && over.crop.w >= 0.001 && over.crop.h >= 0.001
        && over.crop.x + over.crop.w <= 1.0000001 && over.crop.y + over.crop.h <= 1.0000001;
    check(okOver, '越界裁切框被夹回 0..1（不会算出负起点/0 像素图）', JSON.stringify(over));
    check(tm.normalizeView(null, 5).rotate === 1 && tm.normalizeView(null, -1).rotate === 3,
        '旋转次数取模到 0..3（5→1，-1→3）',
        JSON.stringify([tm.normalizeView(null, 5).rotate, tm.normalizeView(null, -1).rotate]));
    check(tm.normalizeView({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 0).crop !== null,
        '真正的裁切框原样保留', JSON.stringify(tm.normalizeView({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 0).crop));
}

// ── buildLut：解码基线（曝光 0 + 高光肩 25） ──
// 这五档已经从界面上撤掉（挪进「调色」），但解码仍按这套参数折表：
// 基线要稳定，旧草稿/工程里存过的数值也要能原样重现。
{
    const L = tm.buildLut(tm.DEFAULTS, 1);
    const at = (c, v) => L[c * 256 + v];
    check(Math.abs(at(0, 128) - 128) <= 1,
        '默认显影不动中间调（中灰还是中灰）', `128 → ${at(0, 128)}`);
    check(at(0, 255) < 250 && at(0, 255) > 200,
        '默认显影给高光留肩：纯白被压到 200–250 之间', `255 → ${at(0, 255)}`);
    check(Math.abs(at(0, 18) - 18) <= 1,
        '默认显影不抬暗部（黑还是黑）', `18 → ${at(0, 18)}`);

    const up = tm.buildLut({ exposure: 1, contrast: 0, highlights: 25, temperature: 0, tint: 0 }, 1);
    check(up[128] > 160,
        '存过的曝光 +1 仍能重现（旧草稿兼容）', `128 → ${up[128]}`);

    const warm = tm.buildLut({ exposure: 0, contrast: 0, highlights: 25, temperature: 60, tint: 0 }, 1);
    check(warm[128] > warm[512 + 128],
        '色温 + 时红通道高于蓝通道', `R=${warm[128]} B=${warm[512 + 128]}`);

    const clamped = tm.normalize({ exposure: 99, contrast: -999, highlights: 'x' });
    check(clamped.exposure === 5 && clamped.contrast === -100 && clamped.highlights === 25,
        '越界/非法参数被裁回合法区间', JSON.stringify(clamped));
}

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
