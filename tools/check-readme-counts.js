// README 数量校验:模板数来自 shared/presets,风格数来自 engine-styles 的 draw 分发表。
// 数字写错在宣传页上很显眼,所以把它放进 npm run check,改预设后忘了改 README 会直接失败。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
const ENGINE = path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js');
const README = path.join(ROOT, 'README.md');

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
    const errors = [];

    const checkAll = (re, expected, label) => {
        let m;
        let found = 0;
        while ((m = re.exec(readme))) {
            found++;
            if (Number(m[1]) !== expected) errors.push(`${label}: README 写 ${m[1]}, 实际 ${expected}`);
        }
        if (!found) errors.push(`${label}: README 里没有找到对应数字`);
    };

    checkAll(/(\d+)\s*个内置模板/g, presets, '内置模板数');
    checkAll(/(\d+)\s*个模板/g, presets, '模板数');
    checkAll(/(\d+)\s*种边框风格/g, styles, '边框风格数');
    checkAll(/(\d+)\s*built-in preset templates/g, presets, 'English built-in presets');
    checkAll(/(\d+)\s*presets/g, presets, 'English presets');
    checkAll(/(\d+)\s*frame styles/g, styles, 'English frame styles');

    // 预设库里已经没有证件照,README 不要再把它列为内置方向
    if (/证件照/.test(readme)) errors.push('README 仍提到「证件照」,但 shared/presets 里没有该预设');

    if (errors.length) {
        console.error('README 数量校验失败:');
        errors.forEach(e => console.error('  - ' + e));
        process.exit(1);
    }
    console.log(`README 数量校验通过: ${presets} 个模板 / ${styles} 种风格`);
}

main();
