/* ═══════════════════════════════════════════════════════════════
   LR XMP 调色预设导入
   解析 Lightroom / Camera Raw 导出的 .xmp，把 crs: 命名空间的调色
   参数映射到清框影的 grade 对象（对齐 app-grade.js 的
   GRADE_FIELDS / DET_FIELDS / CAL_FIELDS / MIX_BANDS / curve）。
   映射原则：只映射「一定为真」的字段，解析失败/不认识的字段进
   skipped 清单，绝不猜测数值。
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const NUM = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // ── 基础 9 档：LR 值域多为 -100~100；Exposure2012 是 EV（±5 典型） ──
    const BASE = [
        { xmp: 'Exposure2012',   key: 'exp',   scale: 60,  note: '曝光' },
        { xmp: 'Contrast2012',   key: 'con',   scale: 1,   note: '对比度' },
        { xmp: 'Saturation',     key: 'sat',   scale: 1,   note: '饱和度' },
        { xmp: 'Vibrance',       key: 'vib',   scale: 0.5, note: '自然饱和度(并入饱和度)' },
        { xmp: 'Highlights2012', key: 'hi',    scale: 1,   note: '高光' },
        { xmp: 'Shadows2012',    key: 'sh',    scale: 1,   note: '阴影' },
        { xmp: 'Whites2012',     key: 'white', scale: 1,   note: '白色' },
        { xmp: 'Blacks2012',     key: 'black', scale: 1,   note: '黑色' },
        { xmp: 'Temperature',    key: 'temp',  scale: 1,   note: '色温' },
        { xmp: 'Tint',           key: 'tint',  scale: 1,   note: '色调' }
    ];

    // ── 细节（LR 的「细节」面板） ──
    const DET = [
        { xmp: 'Clarity2012', key: 'clar', note: '清晰度' },
        { xmp: 'Texture',     key: 'tex',  note: '纹理' },
        { xmp: 'Dehaze',      key: 'dhz',  note: '去除薄雾' }
    ];

    // ── 校准（LR 相机校准，命名空间同为 crs:） ──
    const CAL = [
        { xmp: 'RedHue', key: 'rh', note: '红·色相' },
        { xmp: 'RedSaturation', key: 'rs', note: '红·饱和' },
        { xmp: 'GreenHue', key: 'gh', note: '绿·色相' },
        { xmp: 'GreenSaturation', key: 'gs', note: '绿·饱和' },
        { xmp: 'BlueHue', key: 'bh', note: '蓝·色相' },
        { xmp: 'BlueSaturation', key: 'bs', note: '蓝·饱和' }
    ];

    // ── 混色器：LR 的 8 色带与清框影 MIX_BANDS 完全对齐 ──
    const MIX_COLORS = [
        { xmp: 'Red', key: 'r', label: '红' }, { xmp: 'Orange', key: 'o', label: '橙' },
        { xmp: 'Yellow', key: 'y', label: '黄' }, { xmp: 'Green', key: 'g', label: '绿' },
        { xmp: 'Aqua', key: 'a', label: '青' }, { xmp: 'Blue', key: 'b', label: '蓝' },
        { xmp: 'Purple', key: 'p', label: '紫' }, { xmp: 'Magenta', key: 'm', label: '品红' }
    ];
    const MIX_CH = [
        { xmp: 'HueAdjustment', key: 'h' },
        { xmp: 'SaturationAdjustment', key: 's' },
        { xmp: 'LuminanceAdjustment', key: 'l' }
    ];

    // 常见但软件没有对应参数的 LR 字段（进 skipped，不硬塞）
    const SKIP = ['WhiteBalance', 'Sharpness', 'SharpenAmount', 'NoiseReductionLuminance',
        'NoiseReductionColor', 'NoiseReductionDetail', 'SplitToningHighlightHue',
        'SplitToningHighlightSaturation', 'SplitToningShadowHue', 'SplitToningShadowSaturation',
        'SplitToningBalance', 'PostCropVignetteAmount', 'PostCropVignetteMidpoint',
        'PostCropVignetteFeather', 'GrainAmount', 'LensProfileEnable', 'LensManualDistortionAmount',
        'PerspectiveUpright', 'CameraProfile', 'CameraProfileDigest', 'HasSettings', 'HasCrop',
        'AlreadyApplied', 'RawFileName', 'Version', 'ProcessVersion'];

    // ── 收集 rdf:Description 节点上的「带前缀属性」：名称(local) → 值 ──
    function collectAttrs(desc) {
        const out = {};
        if (!desc || !desc.attributes) return out;
        for (let i = 0; i < desc.attributes.length; i++) {
            const a = desc.attributes[i];
            const nm = a.name || '';
            if (nm === 'xmlns' || nm.indexOf('xmlns:') === 0) continue;
            const colon = nm.indexOf(':');
            const local = colon >= 0 ? nm.slice(colon + 1) : nm;
            if (!local) continue;
            out[local] = a.value;
        }
        return out;
    }

    // ── 解析 .xmp 文本 → { values, found } ──
    function parseXmp(text) {
        const values = {}, found = [];
        if (!text || !text.indexOf) return { values, found };
        let doc = null;
        try {
            doc = new DOMParser().parseFromString(text, 'text/xml');
        } catch (e) { doc = null; }
        // 遍历全部元素找 localName 为 Description 的节点（兼容任意前缀）
        let descs = [];
        if (doc && !doc.getElementsByTagName('parsererror').length) {
            const all = doc.getElementsByTagName('*');
            for (let i = 0; i < all.length; i++) {
                const el = all[i];
                const ln = el.localName || el.tagName || '';
                if (ln === 'Description') descs.push(el);
            }
        }
        if (descs.length) {
            descs.forEach((d) => {
                const attrs = collectAttrs(d);
                Object.keys(attrs).forEach((k) => { if (!(k in values)) { values[k] = attrs[k]; found.push(k); } });
                const kids = d.children || [];
                for (let i = 0; i < kids.length; i++) {
                    const c = kids[i];
                    let ln = c.localName || c.tagName || '';
                    if (ln.indexOf(':') >= 0) ln = ln.slice(ln.indexOf(':') + 1);
                    if (ln && !(ln in values)) {
                        const t = (c.textContent || '').trim();
                        if (t) { values[ln] = t; found.push(ln); }
                    }
                }
            });
            return { values, found };
        }
        // 正则兜底（宽松/非标准 xmp）：crs:xxx="..." 或 <crs:xxx>...</crs:xxx>
        const re = /(?:crs|cr|rdf):([\w-]+)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(text))) { if (!(m[1] in values)) { values[m[1]] = m[2]; found.push(m[1]); } }
        const re2 = /<(?:crs|cr|rdf):([\w-]+)>([^<]*)<\//g;
        while ((m = re2.exec(text))) { if (!(m[1] in values)) { values[m[1]] = m[2].trim(); found.push(m[1]); } }
        return { values, found };
    }

    // ── LR 曲线点 "0,0, 32,22, ..."（0-255 坐标）→ 清框影 [[x,y]]（0-1） ──
    function parseCurve(str) {
        const nums = String(str).split(/[,\s]+/).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n));
        if (nums.length < 4 || nums.length % 2) return null;
        const pts = [];
        for (let i = 0; i < nums.length; i += 2) {
            const x = clamp(nums[i] / 255, 0, 1), y = clamp(nums[i + 1] / 255, 0, 1);
            if (pts.length && Math.abs(x - pts[pts.length - 1][0]) < 0.005) {
                pts[pts.length - 1][1] = y;
            } else {
                pts.push([x, y]);
            }
        }
        return pts.length >= 2 ? pts : null;
    }

    // ── 主入口：文本 → { patch, applied[], skipped[], hasAdjust } ──
    function mapXmp(text) {
        const { values, found } = parseXmp(text);
        const patch = {};
        const applied = [];
        const skipped = [];
        const push = (list, s) => { if (list.indexOf(s) < 0) list.push(s); };

        // 基础档
        BASE.forEach((f) => {
            const raw = values[f.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) { push(skipped, f.note + '(' + f.xmp + ')'); return; }
            patch[f.key] = Math.round(clamp(v * f.scale, -100, 100));
            push(applied, f.note);
        });

        // 自然饱和度折入饱和度（先各自算好再合并截断）
        if (patch.vib !== undefined) {
            const sat = (patch.sat || 0) + patch.vib;
            patch.sat = Math.round(clamp(sat, -100, 100));
            delete patch.vib;
        }

        // 细节
        const det = {};
        DET.forEach((f) => {
            const raw = values[f.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) return;
            det[f.key] = Math.round(clamp(v, -100, 100));
            push(applied, f.note);
        });
        if (Object.keys(det).length) patch.det = det;

        // 校准
        const cal = {};
        CAL.forEach((f) => {
            const raw = values[f.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const v = NUM(raw, NaN);
            if (!Number.isFinite(v)) return;
            cal[f.key] = Math.round(clamp(v, -100, 100));
            push(applied, f.note);
        });
        if (Object.keys(cal).length) patch.cal = cal;

        // 混色器
        const mix = {};
        MIX_COLORS.forEach((c) => {
            let any = false;
            const cell = {};
            MIX_CH.forEach((ch) => {
                const raw = values[ch.xmp + c.xmp];
                if (raw === undefined || raw === null || raw === '') return;
                const v = NUM(raw, NaN);
                if (!Number.isFinite(v)) return;
                cell[ch.key] = Math.round(clamp(v, -100, 100));
                any = true;
            });
            if (any) { mix[c.key] = cell; push(applied, c.label + '色HSL'); }
        });
        if (Object.keys(mix).length) patch.mix = mix;

        // 曲线（主 + 分通道）
        const curve = {};
        const CURVE = [
            { xmp: 'ToneCurvePV2012', key: 'rgb' },
            { xmp: 'ToneCurvePV2012Red', key: 'r' },
            { xmp: 'ToneCurvePV2012Green', key: 'g' },
            { xmp: 'ToneCurvePV2012Blue', key: 'b' }
        ];
        CURVE.forEach((c) => {
            const raw = values[c.xmp];
            if (raw === undefined || raw === null || raw === '') return;
            const pts = parseCurve(raw);
            if (pts) { curve[c.key] = pts; push(applied, c.key === 'rgb' ? '主曲线' : c.key.toUpperCase() + '曲线'); }
            else push(skipped, c.xmp + '(曲线)');
        });
        if (Object.keys(curve).length) patch.curve = curve;

        // 出现但未映射的常见 LR 字段 → skipped
        found.forEach((k) => { if (SKIP.indexOf(k) >= 0) push(skipped, k); });

        return { patch, applied, skipped, hasAdjust: Object.keys(patch).length > 0 };
    }

    // ── UI 入口：按钮 → 选文件 → 映射 → setGrade ──
    async function importXmpPreset() {
        const app = window.App;
        const api = window.qingframe;
        if (!api || !api.importXmp) { if (app && app.setStatus) app.setStatus('当前环境不支持导入 XMP'); return; }
        let r;
        try { r = await api.importXmp(); } catch (e) { r = null; }
        if (!r || r.canceled) return;
        if (!r.ok) { if (app && app.setStatus) app.setStatus('导入失败：' + (r.error || '未知错误')); return; }
        const { patch, applied, skipped, hasAdjust } = mapXmp(r.text);
        if (!hasAdjust) {
            if (app && app.setStatus) app.setStatus('「' + r.name + '」里没有可识别的调色参数（请确认是 Lightroom/Camera Raw 导出的 .xmp）');
            return;
        }
        if (app && app.setGrade) app.setGrade(patch, { full: true });
        const msg = '已导入 LR 预设「' + r.name + '」：' + (applied.join('、') || '无')
            + (skipped.length ? '；未导入：' + skipped.join('、') : '');
        if (app && app.setStatus) app.setStatus(msg);
    }

    window.AppXmp = { mapXmp, importXmpPreset };

    function bind() {
        const btn = document.getElementById('btnGradeImportXmp');
        if (btn) btn.addEventListener('click', importXmpPreset);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
