// 预设校验:把「shared/presets/*.json ↔ 引擎风格表」的一致性固化成可重复执行的检查
// 用法: node tools/validate-presets.js        (npm run validate:presets)
//       PRESETS_DIR=<目录> node tools/validate-presets.js   (校验其它目录,便于回归测试本脚本)
// 退出码: 0 = 全部通过, 1 = 存在错误
//
// 背景:engine-styles.js 用 `draw` 映射表按大写常量分发风格,并在 styleDims() 里为每个
// 风格单独算成品尺寸。两者与预设的 photoFrameStyle 一旦对不上,渲染会静默掉进
// stylePlaceholder(灰底占位图),肉眼只能靠逐个点开 70 个预设才能发现。
// 本脚本维护这份白名单,让「新增风格忘了进表」和「预设写错风格名」在提交前就报错。
//
// 关于「必填」的口径:只把全部预设实际都携带的字段当硬约束。其余字段(logoElements /
// paramFontSize / canvasRatio …)在原代码里每个消费点都有 `|| []` / `!= null` 兜底,
// 缺失是安全的,故只做提示、不算错误。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = process.env.PRESETS_DIR
    ? path.resolve(process.env.PRESETS_DIR)
    : path.join(ROOT, 'shared', 'presets');
const ENGINE_PATH = path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js');

// ── 从引擎源码提取风格白名单 ──
// 用括号配平精确截取 `const draw = { ... }`。不能按子串切:buildState 的定义出现在映射表
// 之前,按 indexOf('const S = buildState') 截断只会抓到部分键(曾因此误判 46 个预设)。
function sliceBalanced(src, startMarker, open = '{', close = '}') {
    const at = src.indexOf(startMarker);
    if (at < 0) throw new Error(`引擎源码里找不到标记: ${startMarker}`);
    const from = src.indexOf(open, at);
    if (from < 0) throw new Error(`标记后找不到 ${open}: ${startMarker}`);
    let depth = 0;
    for (let i = from; i < src.length; i++) {
        const c = src[i];
        if (c === open) depth++;
        else if (c === close && --depth === 0) return src.slice(from, i + 1);
    }
    throw new Error(`括号未配平: ${startMarker}`);
}

const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8');

// draw 映射表的键 = 引擎真正认识的风格
const drawBlock = sliceBalanced(engineSrc, 'const draw = {');
const drawKeys = new Set();
for (const m of drawBlock.matchAll(/(?:^|[\s,{])([A-Z][A-Z0-9_]*)\s*:/g)) drawKeys.add(m[1]);

// styleDims 的 case = 声明了成品尺寸的风格
const dimsBlock = sliceBalanced(engineSrc, 'function styleDims');
const dimsCases = new Set();
for (const m of dimsBlock.matchAll(/case '([A-Z0-9_]+)'/g)) dimsCases.add(m[1]);

// ── 结构约束 ──
// 硬约束:渲染管线直接读取/遍历这些字段,70 个预设全部携带。值类型必须对:
// layerList 是数组(图层栈),其余是对象。typeof [] === 'object' 不能代替数组判断。
const REQUIRED_KEYS = {
    templateName: 'string',
    baseMargin: 'object',
    layerList: 'array',
    cornerConfig: 'object',
    filmTearConfig: 'object',
    lightEffect: 'object',
    decorConfig: 'object',
};
// 软约束:消费点有兜底,缺失不影响渲染,仅提示形状不一致
const OPTIONAL_KEYS = ['logoElements', 'paramFontSize', 'paramType', 'paramPosition', 'blurIntensity'];

const ENUMS = {
    paramPosition: ['CENTER', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM'],
    canvasRatio: ['original', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5'],
};

const errors = [];
const warnings = [];
const notes = [];

function classify(data) {
    const raw = data.photoFrameStyle;
    const hasStyle = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (hasStyle) return 'style';
    if ((data.baseMargin || {}).bgBlurEnable === 1) return 'card';
    return 'layer';
}

function checkPreset(file, data) {
    const name = file.replace(/\.json$/, '');
    const where = (k) => `${name}.json → ${k}`;

    for (const [k, kind2] of Object.entries(REQUIRED_KEYS)) {
        const v = data[k];
        if (v === undefined) { errors.push(`${where(k)}: 缺失(渲染管线依赖此字段)`); continue; }
        const isArray = Array.isArray(v);
        const ok = kind2 === 'array' ? isArray
            : kind2 === 'string' ? (typeof v === 'string' && v.trim() !== '')
            : (!isArray && typeof v === 'object' && v !== null);
        if (!ok) errors.push(`${where(k)}: 类型应为 ${kind2},实际 ${isArray ? 'array' : typeof v}`);
    }

    const isStyle = classify(data) === 'style';

    if (isStyle) {
        for (const k of OPTIONAL_KEYS) {
            if (data[k] === undefined) notes.push(`${where(k)}: 未携带(代码有兜底,风格引擎管线通常应带上)`);
        }
        const style = String(data.photoFrameStyle).toUpperCase();
        if (!drawKeys.has(style)) {
            errors.push(`${where('photoFrameStyle')}: "${data.photoFrameStyle}" 不在引擎 draw 映射表中 → 会静默渲染成占位图`
                + `\n      引擎已知风格: ${[...drawKeys].sort().join(', ')}`);
        } else if (!dimsCases.has(style)) {
            // 能画但没有尺寸分支 → 会走 styleDims 的 default(iw+60/ih+60),多半不是想要的结果
            warnings.push(`${where('photoFrameStyle')}: "${data.photoFrameStyle}" 在 draw 表中但 styleDims 无对应 case,`
                + `成品尺寸会落到 default(+60px)`);
        }
    }

    // 渐变填充的色标必须 ≥2 且带颜色,否则 createLinearGradient 会抛异常(进而在引擎里被 catch 成"回退原图")
    // 注意先确认 layerList 真是数组:类型错误上面已经报过,这里不能再崩
    const layers = Array.isArray(data.layerList) ? data.layerList : [];
    layers.forEach((layer, i) => {
        const f = (layer && layer.fillConfig) || {};
        if (f.fillType !== 'gradient') return;
        const stops = f.gradientStops || [];
        if (stops.length < 2) {
            errors.push(`${name}.json → layerList[${i}].fillConfig: gradient 至少需要 2 个色标(当前 ${stops.length})`);
        }
        stops.forEach((s, si) => {
            if (!s || typeof s.color !== 'string' || !s.color.trim()) {
                errors.push(`${name}.json → layerList[${i}].fillConfig.gradientStops[${si}]: 缺少 color`);
            }
        });
    });

    for (const [key, allowed] of Object.entries(ENUMS)) {
        const v = data[key];
        if (v === undefined || v === null || v === '') continue;
        if (!allowed.includes(String(v))) {
            warnings.push(`${name}.json → ${key}: "${v}" 不在已知取值内 [${allowed.join(', ')}]`);
        }
    }

    const textLines = (data.decorConfig && Array.isArray(data.decorConfig.textLines))
        ? data.decorConfig.textLines : [];
    textLines.forEach((l, i) => {
        if (l && l.text !== undefined && typeof l.text !== 'string') {
            errors.push(`${name}.json → decorConfig.textLines[${i}].text: 必须是字符串`);
        }
    });
}

// ── 主流程 ──
if (!fs.existsSync(PRESETS_DIR)) {
    console.error(`预设目录不存在: ${PRESETS_DIR}`);
    process.exit(1);
}

const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).sort();
if (!files.length) {
    console.error(`预设目录里没有 .json: ${PRESETS_DIR}`);
    process.exit(1);
}

const byPath = { style: [], card: [], layer: [] };
const usedStyles = new Set();
// 预设实际用到的分类(templateTag,合并前的原始值),供下面的「分组顺序表」反向校验
const usedTags = new Set();

for (const file of files) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
    } catch (e) {
        errors.push(`${file}: JSON 解析失败 → ${e.message}`);
        continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        errors.push(`${file}: 顶层不是一个对象`);
        continue;
    }
    byPath[classify(data)].push(file.replace(/\.json$/, ''));
    if (data.photoFrameStyle) usedStyles.add(String(data.photoFrameStyle).toUpperCase());
    if (data.templateTag) usedTags.add(String(data.templateTag).trim());
    checkPreset(file, data);
}

// ── 反向检查:预设分类必须登记在预设面板的「大标题顺序表」里 ──
// 背景:app-templates.js 的 buildTree() 用一个显式的 DEFAULT_ORDER 数组决定预设面板分组大标题的
// 显示顺序,不在数组里的分类会被排到最末尾(99 位)。「邮票」分类新增时加了 5 个预设却忘了
// 登记,整组一直垫在最后 —— 观感上像「分类不见了」,而当时没有任何检查会报这件事。
// 这里把它固化成硬约束:新加预设分类却忘了进 order,提交前就直接报错。
// 用 PRESETS_DIR 换目录做自测时不跑这条(临时目录里的分类名当然不在真实顺序表里)。
if (!process.env.PRESETS_DIR) checkGroupOrder();

function checkGroupOrder() {
    const TEMPLATES = path.join(ROOT, 'src', 'renderer', 'js', 'app-templates.js');
    let src;
    try { src = fs.readFileSync(TEMPLATES, 'utf8'); }
    catch (e) { warnings.push(`读不到 app-templates.js,分组顺序未校验(${e.message})`); return; }

    const lines = src.split(/\r?\n/);
    // 预设面板的显式清单在 buildTree() 里叫 DEFAULT_ORDER;旧版本叫 order。
    // 两种都兼容,避免以后改个变量名就让校验静默失效。
    const orderLine = lines.filter(l => l.trim().startsWith('const DEFAULT_ORDER = [')).pop()
        || lines.filter(l => l.trim().startsWith('const order = [')).pop();
    const mergeLine = lines.filter(l => l.trim().startsWith('const merge = {')).pop();
    if (!orderLine || !mergeLine) {
        warnings.push('app-templates.js 里找不到 DEFAULT_ORDER / order 顺序表或 const merge = {...},分组顺序未校验');
        return;
    }
    const pick = (line, open, close) => {
        const a = line.indexOf(open), b = line.lastIndexOf(close);
        if (a < 0 || b <= a) return [];
        return line.slice(a + 1, b).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const order = pick(orderLine, '[', ']');
    const merge = {};
    for (const it of pick(mergeLine, '{', '}')) {
        const [k, v] = it.split(':').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        if (k) merge[k] = v;
    }
    // 一个分类都没解析出来 = 顺序表被改成了别的写法,此时报错只会误伤
    if (!order.length) { warnings.push('order 顺序表解析为空,分组顺序未校验'); return; }

    const groups = new Set();
    for (const tag of usedTags) groups.add(merge[tag] || tag || '其他');
    const missing = [...groups].filter(g => !order.includes(g)).sort();
    for (const g of missing) {
        errors.push(`预设分类「${g}」未登记在 app-templates.js 的 order 顺序表里 → 会被排到面板最末尾`
            + `\n      请把它加进 DEFAULT_ORDER / const order = [...]。当前顺序: ${order.join(', ')}`);
    }
}

// ── 输出 ──
console.log('清框影 · 预设校验');
console.log('─'.repeat(56));
console.log(`引擎风格表   draw ${drawKeys.size} 个 / styleDims ${dimsCases.size} 个 case`);
console.log(`预设         ${files.length} 个  (${PRESETS_DIR})`);
console.log(`  路线1 风格引擎 photoFrameStyle   ${byPath.style.length}`);
console.log(`  路线2 卡片管线 bgBlurEnable      ${byPath.card.length}`);
console.log(`  路线3 通用图层模板               ${byPath.layer.length}`);
console.log('─'.repeat(56));

// 反向检查:引擎实现了但当前没有被任何预设使用的风格(正常现象,仅供了解)
const unused = [...drawKeys].filter(k => !usedStyles.has(k)).sort();
if (unused.length) {
    console.log(`引擎实现但暂无预设使用(${unused.length} 个,正常):`);
    console.log(`  ${unused.join(', ')}`);
    console.log('─'.repeat(56));
}

if (notes.length) {
    console.log(`\n· 提示 ${notes.length} 条(有代码兜底,不算问题):`);
    // 同类问题合并显示,避免 30 个预设刷屏
    const grouped = new Map();
    for (const n of notes) {
        const key = n.replace(/^[^→]+→\s*/, '');
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(n.replace(/\.json.*$/, ''));
    }
    for (const [key, names] of grouped) {
        console.log(`  - ${key}  [${names.length} 个: ${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''}]`);
    }
}

if (warnings.length) {
    console.log(`\n⚠ 警告 ${warnings.length} 条:`);
    warnings.forEach(w => console.log(`  - ${w}`));
}

if (errors.length) {
    console.log(`\n✖ 错误 ${errors.length} 条:`);
    errors.forEach(e => console.log(`  - ${e}`));
    console.log('\n校验未通过。');
    process.exit(1);
}

console.log(`\n✓ 全部 ${files.length} 个预设通过校验`
    + `${warnings.length ? `(${warnings.length} 条警告)` : ''}${notes.length ? `(${notes.length} 条提示)` : ''}。`);
