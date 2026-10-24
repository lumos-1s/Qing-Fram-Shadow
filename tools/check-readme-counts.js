// README / 关于页数量校验:模板数来自 shared/presets,风格数来自 engine-styles 的 draw 分发表。
// 关于页和新手引导的数字在运行时由 App.updateStatsText() 动态生成,但首屏兜底值仍写死在 HTML,
// 所以这里也一起校验;style-caps 的 MEASURED 数量必须与引擎 draw 表一致,否则关于页会显示错数。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
const ENGINE = path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js');
const STYLE_CAPS = path.join(ROOT, 'src', 'renderer', 'js', 'style-caps.js');
const README = path.join(ROOT, 'README.md');
const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');

function countPresets() {
    return fs.readdirSync(PRESETS_DIR).filter(n => n.toLowerCase().endsWith('.json')).length;
}

function countStyles() {
    const s = fs.readFileSync(ENGINE, 'utf8');
    const start = s.indexOf('const draw = {');
    const end = s.indexOf('}[styleName];', start);
    if (start < 0 || end < 0) throw new Error('无法定位 engine-styles.js 的 draw 分发表');
    const block = s.slice(start, end);
    const keys = [...block.matchAll(/(?:^|[,{\s])([A-Z][A-Z0-9_]+)\s*:/g)].map(m => m[1]);
    return new Set(keys).size;
}

function main() {
    const presets = countPresets();
    const styles = countStyles();
    const readme = fs.readFileSync(README, 'utf8');
    const html = fs.readFileSync(INDEX, 'utf8');
    const errors = [];

    const checkAll = (text, re, expected, label) => {
        let m;
        let found = 0;
        while ((m = re.exec(text))) {
            found++;
            if (Number(m[1]) !== expected) errors.push(`${label}: 写 ${m[1]}, 实际 ${expected}`);
        }
        if (!found) errors.push(`${label}: 没有找到对应数字`);
    };

    checkAll(readme, /(\d+)\s*个内置模板/g, presets, '内置模板数');
    checkAll(readme, /(\d+)\s*个模板/g, presets, '模板数');
    checkAll(readme, /(\d+)\s*种边框风格/g, styles, '边框风格数');
    checkAll(readme, /(\d+)\s*built-in preset templates/g, presets, 'English built-in presets');
    checkAll(readme, /(\d+)\s*presets/g, presets, 'English presets');
    checkAll(readme, /(\d+)\s*frame styles/g, styles, 'English frame styles');

    // 关于弹窗 + 新手引导的首屏兜底数字
    checkAll(html, /(\d+)\s*个模板/g, presets, '关于/引导模板数');
    checkAll(html, /(\d+)\s*种边框风格/g, styles, '关于/引导边框风格数');

    // 关于页运行时用 StyleCaps.MEASURED 的数量;它必须和引擎 draw 表一致。
    try {
        const caps = require(STYLE_CAPS);
        const measured = Object.keys(caps.MEASURED || {}).length;
        if (measured !== styles) {
            errors.push(`StyleCaps.MEASURED 有 ${measured} 个风格, 引擎 draw 表有 ${styles} 个`);
        }
    } catch (e) {
        errors.push('读取 style-caps.js 失败: ' + e.message);
    }

    // 预设库里已经没有证件照,README 不要再把它列为内置方向
    if (/证件照/.test(readme)) errors.push('README 仍提到「证件照」,但 shared/presets 里没有该预设');

    if (errors.length) {
        console.error('README / 关于页数量校验失败:');
        errors.forEach(e => console.error('  - ' + e));
        process.exit(1);
    }
    console.log(`README / 关于页数量校验通过: ${presets} 个模板 / ${styles} 种风格`);
}

main();
