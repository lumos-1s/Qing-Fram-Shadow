// 等效焦距换算(35mm 等效):根据 EXIF 的品牌/型号猜测画幅(裁切系数),
// 把实际焦距换算成等效焦距。纯规则表,无网络请求。
// 浏览器挂到 window.CropFactor;Node 测试环境走 module.exports。
(function (root) {
    'use strict';

    // "50mm" / "50 mm" / "50" -> 50;解析失败返回 null
    function parseFocalMm(s) {
        const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*mm/i);
        if (m) return parseFloat(m[1]);
        const n = String(s || '').trim();
        return /^\d+(?:\.\d+)?$/.test(n) ? parseFloat(n) : null;
    }

    // 画幅规则表:逐条正则匹配 make+model(小写化后)。命中即返回裁切系数。
    // 顺序敏感:先匹配小画幅特例,再匹配大画幅,避免子串误伤
    // (如 Nikon "Z50"(APS-C 1.5) vs "Z5"(全幅)、"D7000"(1.5) vs "D700"(1.0))。
    const RULES = [
        // ── 中画幅 0.79 ──
        [/\bgfx\s?\d|gfx50|gfx100/, 0.79],
        [/\b(x1d|x2d|907x|cfv|h6d|h5d)\b|\bhasselblad\b/, 0.79],
        [/\b(phase one|p\d+\+?|iq\d|ixh)\b/, 0.79],
        [/\b(mamiya|645|rz67|rb67)\b/, 0.79],
        // ── 全幅 1.0(注意排在各家 APS-C 特例之后,靠 make 分支处理)──
        // ── 手机:传感器规格五花八门,不给等效值,避免给出错误数字 ──
        [/\b(iphone|ipad)\b|ios\b/, null],
        [/\b(pixel|honor|redmi|oneplus|one\+|bbk|harmony|micromax)\b/, null],
        [/\b(huawei|xiaomi|oppo|vivo|samsung sm-|samsung galaxy|nexus)\b/, null],
        // ── Sony ──
        [/\bsony\b.*\b(a6\d{3}|zv-e10|fx30)\b|ilce-6/, 1.5],
        [/\bsony\b.*\b(zv-1|rx1|rx100|rx10)/, 2.7],
        [/\bsony\b|\bilce-\d|\ba[1-9]\b|fx2\b|fx3\b/, 1.0],
        // ── Canon(APS-C 是 1.6,别家 1.5)──
        [/\bcanon\b.*\b(r7|r10|r50|r100|m\d{1,3}|7d|\d{2,3}d|rebel|kiss|d\d{1,2})\b/, 1.6],
        [/\bcanon\b|\beos\b/, 1.0],
        // ── Nikon ──
        [/\bnikon\b.*\bz ?(30|50|fc)\b|\bnikon\b.*\bd\d{4}\b/, 1.5],
        [/\bnikon\b.*\bz ?[5-9](_2)?\b|\bnikon\b.*\b(d[3-8]\d{2}|d[3-6]|df)\b/, 1.0],
        [/\bnikon\b.*\bz\b|\bnikon\b.*\bd\d{2,4}\b/, 1.5],
        // ── Fujifilm:GFX 中画幅已在上文,X 系列 APS-C ──
        [/\b(fujifilm|fuji)\b.*\b(x-t|x-e|x-h|x-s|x-pro|x100|x-m|x ?a\d|xe-?\d|xm)\d*/, 1.5],
        [/\b(fujifilm|fuji)\b|\bx100v?\b/, 1.5],
        // ── Panasonic:全幅 S 系,其余 M4/3 按 2.0 ──
        [/\b(panasonic|lumix)\b.*\bs[159]\w*\b/, 1.0],
        [/\b(panasonic|lumix)\b|\bgh\d|\bgx\d|\bgf\d|\bgm\d/, 2.0],
        // ── Olympus / OM System:M4/3 一律 2.0 ──
        [/\b(olympus|om system|om digital|om-?\d)\b|\be-?m1|\be-?m5|\be-?m10|pen\b/, 2.0],
        // ── Pentax:645 中画幅 / K-1 全幅 / 其余 APS-C ──
        [/\bpentax\b.*\b645\b/, 0.79],
        [/\bpentax\b.*\bk-?1\b/, 1.0],
        [/\b(pentax|ricoh)\b|\bkp\b|\bk-?\d/, 1.5],
        // ── Ricoh GR(APS-C)──
        [/\bricoh\b.*\bgr\b|\bgr (ii|iii|iv)\b/, 1.5],
        // ── Leica ──
        [/\bleica\b.*\b(d-?lux|v-?lux)\b/, 2.0],
        [/\bleica\b|\b(m10|m11|q2|q3|sl2|sl3|m-e)\w*\b/, 1.0],
        // ── Sigma:fp 系全幅,其余 Foveon APS-C ──
        [/\bsigma\b.*\bfpl?\b/, 1.0],
        [/\bsigma\b/, 1.5],
        // ── 消费级小底(1 英寸)──
        [/\b(g7x|g5x|g9x|g1x|powershot|nikon 1\b|j\d\b|s\d{2}00\b|rx0)\b/, 2.7],
        [/\b(lf1|zs\d{2,3}|tz\d{2,3}|tx\d)\b/, 2.7],
        // ── 品牌 fallback:主品牌但型号没细配,按主流全幅处理避免瞎猜 ──
    ];

    // 由 make+model 猜裁切系数;认不出返回 null(调用方就不显示等效值)
    function guessCropFactor(make, model) {
        const s = (String(make || '') + ' ' + String(model || '')).toLowerCase().trim();
        if (!s || s === '|') return null;
        for (const [re, factor] of RULES) {
            if (re.test(s)) return factor; // 可能为 null(手机等,明确不换算)
        }
        return null;
    }

    // 换算并格式化:返回形如 "50mm (75mm 等效)";无法换算时原样返回
    function formatFocalWithEq(focalStr, make, model) {
        const mm = parseFocalMm(focalStr);
        if (mm == null || mm <= 0) return String(focalStr || '');
        const factor = guessCropFactor(make, model);
        if (!factor || factor === 1) return String(focalStr || '');
        const eq = Math.round(mm * factor);
        if (!eq || eq <= 0) return String(focalStr || '');
        return focalStr + ' (' + eq + 'mm 等效)';
    }

    const api = { parseFocalMm: parseFocalMm, guessCropFactor: guessCropFactor, formatFocalWithEq: formatFocalWithEq };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CropFactor = api;
})(typeof window !== 'undefined' ? window : globalThis);
