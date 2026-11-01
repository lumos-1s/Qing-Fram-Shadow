// 浅色/深色主题的 UI 文本对比度检查（纯 Node，不需要 Electron）。
// 用法：node tools/check-ui-contrast.js
//
// 背景：用户反馈「浅色主题下有些浅灰色字看不清」。实测 --text-3 只有 2.5~3.1:1，
// 语义色当文字用更低（绿 2.85 / 琥珀 2.04 / 玫红 3.03），远低于 WCAG AA 的 4.5:1。
// 这个脚本做两件事：
//   1) 逐主题、逐底色断言文字色的对比度达标（失败即退出码 1）
//   2) 扫出「把 --primary / --amber / --rose 直接当文字色」的写法 —— 那三个是填充色，
//      当文字用必然不够亮，应该改用 --primary-text / --amber-text / --rose-text
'use strict';

const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'css', 'style.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

/* ── 变量解析 ── */
// 注释里可能出现冒号（"对比度 4.5:1"），不先剥掉会把紧随其后的声明读丢
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
function readBlock(selector) {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
    const m = css.match(re);
    if (!m) return null;
    const vars = {};
    for (const decl of stripComments(m[1]).split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const name = decl.slice(0, i).trim();
        if (!name.startsWith('--')) continue;
        vars[name] = decl.slice(i + 1).trim();
    }
    return vars;
}

const lightVars = readBlock(':root');
const darkVars = readBlock('html.dark');

/* 允许 var(--x) 引用另一个变量（例如 --text-dim: var(--text-3)） */
function resolve(vars, value, depth = 0) {
    if (typeof value !== 'string' || depth > 4) return value;
    const m = value.match(/^var\((--[\w-]+)\)$/);
    return m ? resolve(vars, vars[m[1]], depth + 1) : value;
}

function toRgb(color) {
    const v = String(color || '').trim();
    let m = v.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = v.match(/^#([0-9a-f]{3})$/i);
    if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
    return null;
}

const linear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const relLum = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
function contrast(a, b) {
    const la = relLum(a), lb = relLum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

/* ── 断言表 ── */
// 主要承载正文的底色：这些上面必须 >= 4.5（WCAG AA 普通文本）
const MAIN_BGS = ['--bg', '--surface', '--surface-alt', '--bg-soft'];
// 控件/标签底色比正文底色更深一档，允许 4.0（仍高于大字号 AA 的 3.0）
const HARD_BGS = ['--surface-2'];

const RULES = [
    { token: '--text', min: 7.0, bgs: MAIN_BGS, why: '正文' },
    { token: '--text-2', min: 5.0, bgs: MAIN_BGS, why: '次级文字' },
    { token: '--text-3', min: 4.5, bgs: MAIN_BGS, why: '弱化文字/说明/占位符' },
    { token: '--text-3', min: 4.0, bgs: HARD_BGS, why: '弱化文字落在控件底色上' },
    { token: '--primary-text', min: 4.5, bgs: MAIN_BGS, why: '绿色文字' },
    { token: '--amber-text', min: 4.5, bgs: MAIN_BGS, why: '警告文字' },
    { token: '--rose-text', min: 4.5, bgs: MAIN_BGS, why: '错误文字' }
];

function auditTheme(name, vars) {
    console.log(`\n[${name}]`);
    if (!vars) { check(false, `${name}: 未找到变量块`); return; }
    for (const rule of RULES) {
        const fg = toRgb(resolve(vars, vars[rule.token]));
        if (!fg) { check(false, `${name} ${rule.token} 不是可解析的十六进制颜色`, String(vars[rule.token])); continue; }
        for (const bgToken of rule.bgs) {
            const bg = toRgb(resolve(vars, vars[bgToken]));
            if (!bg) { check(false, `${name} ${bgToken} 缺失或不可解析`); continue; }
            const r = contrast(fg, bg);
            check(r >= rule.min,
                `${name} ${rule.token}（${rule.why}）on ${bgToken}`,
                `${r.toFixed(2)}:1 需 >= ${rule.min}`);
        }
    }
}

auditTheme('浅色', lightVars);
auditTheme('深色', darkVars);

/* ── 结构检查：语义填充色不能直接当文字色 ── */
// 只认真正的 color 声明；border-color / background-color 不在此列
const RAW_TEXT_RE = /(^|[^-a-zA-Z])(color:\s*)var\(--(primary|amber|rose)\)/g;
const offenders = [];
let m;
while ((m = RAW_TEXT_RE.exec(css))) {
    const line = css.slice(0, m.index).split('\n').length;
    offenders.push(`第 ${line} 行 color: var(--${m[3]})`);
}
check(offenders.length === 0,
    '没有把填充色(--primary/--amber/--rose)直接当文字色',
    offenders.slice(0, 5).join('；'));

console.log(failures.length ? `\n${failures.length} 项不达标` : '\n全部达标');
process.exit(failures.length ? 1 : 0);
