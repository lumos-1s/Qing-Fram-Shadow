// 「默认导出位置」落点判定回归（纯 Node，不需要 Electron）：
// 用法：node tools/test-export-default-dir.js
//
// 对应行为：
//   设置过默认导出文件夹 → 多张整批写进该目录；单张写进该目录里的空闲文件名；
//   目录失效（被删/权限变了）→ 返回 null，调用方回退到系统保存框；
//   文件名一律按"单个叶子名"清洗，路径穿越（../）不能跳出默认目录。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore } = require('../src/main/state');
const { safeExportName, autoExportTarget } = require('../src/main/export-path');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-export-'));
const store = createStateStore(path.join(tmp, 'state.json'));
const deps = { validDir: store.validDir, freeFilePath: store.freeFilePath };
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir);

try {
    // ── A：文件名清洗（导出链路的 filename 来自 .qfs 等不可信输入）──
    check(safeExportName('../../evil.png') === 'evil.png',
        '路径穿越被压成叶子名', safeExportName('../../evil.png'));
    check(safeExportName('photo') === 'photo.png',
        '没扩展名按默认 png 补全', safeExportName('photo'));
    check(safeExportName('a*b?.jpg') === 'a_b_.jpg',
        '非法字符被替换', safeExportName('a*b?.jpg'));
    check(safeExportName('CON.png') === '_CON.png',
        'Windows 保留名加前缀', safeExportName('CON.png'));
    check(safeExportName('', 'x.jpg') === 'x.jpg',
        '空名回退到给定默认名', safeExportName('', 'x.jpg'));

    // ── B：目录失效 → 不自动落点（回退系统保存框）──
    check(autoExportTarget(path.join(tmp, 'missing'), 1, 'a.png', deps) === null,
        '目录不存在时返回 null（调用方回退保存框）');
    check(autoExportTarget(outDir, 1, 'a.png', {}) === null,
        '缺少 validDir/freeFilePath 依赖时返回 null（不擅自决定落点）');

    // ── C：多张 → 目录模式 ──
    const many = autoExportTarget(outDir, 3, 'batch', deps);
    check(!!many && many.mode === 'dir' && many.dir === outDir,
        '多张导出落到默认目录', JSON.stringify(many));
    const manyStr = autoExportTarget(outDir, '3', 'batch', deps);
    check(!!manyStr && manyStr.mode === 'dir',
        'count 传字符串也按多张处理', JSON.stringify(manyStr));

    // ── D：单张 → 目录里的空闲文件名 ──
    const one = autoExportTarget(outDir, 1, 'leaf.png', deps);
    check(!!one && one.mode === 'file' && path.dirname(one.filePath) === outDir
        && path.basename(one.filePath) === 'leaf.png',
        '单张导出落到默认目录里的同名文件', JSON.stringify(one));

    // 重名不覆盖：写一个同名文件后再取，应变成 leaf_1.png
    fs.writeFileSync(one.filePath, 'x');
    const two = autoExportTarget(outDir, 1, 'leaf.png', deps);
    check(path.basename(two.filePath) === 'leaf_1.png',
        '同名文件已存在时自动加 _1（不覆盖）', path.basename(two.filePath));

    // 路径穿越的 hint 也只能落在默认目录里
    const evil = autoExportTarget(outDir, 1, '../../evil.png', deps);
    check(path.dirname(evil.filePath) === outDir && path.basename(evil.filePath) === 'evil.png',
        '带 ../ 的文件名仍落在默认目录内', evil.filePath);

    // 未传 hintName 也不能崩（原先单文件分支对 undefined 调 .match 会抛）
    let noHintOk = true;
    try { autoExportTarget(outDir, 1, undefined, deps); } catch (_) { noHintOk = false; }
    check(noHintOk, '未传 hintName 不抛错');
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
}

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
