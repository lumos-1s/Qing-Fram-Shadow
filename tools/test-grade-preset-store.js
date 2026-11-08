'use strict';
// 调色预设存储回归（纯 node，不需要 Electron）
//   node tools/test-grade-preset-store.js
//
// 覆盖：保存/读取/列表/重命名/删除、路径穿越收口、旧文件名不残留、
// 重命名时同步更新文件内显示名、非法内容拒绝。
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'main', 'grade-preset-store.js'));

let fails = 0;
function check(ok, label, extra) {
    if (ok) console.log('  OK   ' + label);
    else { fails++; console.log('  FAIL ' + label + (extra ? ' | ' + extra : '')); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-grade-preset-'));
const grade = { exp: 0.35, con: 12, curve: { rgb: [[0, 0], [255, 255]] }, masks: [] };

try {
    check(store.list(dir).length === 0, '空目录列表为空');

    let r = store.save(dir, '暖调胶片', {
        v: 1, kind: 'qfs-grade-preset', name: '暖调胶片', createdAt: '2026-01-01T00:00:00.000Z', grade
    });
    check(r && r.ok, '保存中文名称预设', JSON.stringify(r));

    const list = store.list(dir);
    check(list.length === 1 && list[0] === '暖调胶片', '列表返回预设名', JSON.stringify(list));

    const loaded = store.load(dir, '暖调胶片');
    check(!!loaded && loaded.name === '暖调胶片' && loaded.grade.exp === 0.35, '读取预设内容');

    r = store.save(dir, '坏数据', { v: 1, name: '坏数据' });
    check(r && r.ok === false, '缺少 grade 的内容被拒绝');

    r = store.save(dir, '../escape', { v: 1, name: '../escape', grade });
    check(r && r.ok, '越界名称被收口为目录内文件名');
    check(fs.existsSync(path.join(dir, 'escape.json')), '实际文件仍落在预设目录内');
    check(!fs.existsSync(path.join(path.dirname(dir), 'escape.json')), '没有写到预设目录之外');
    const escaped = store.load(dir, 'escape');
    check(!!escaped && escaped.name === 'escape', '收口后的文件名与文件内显示名一致');

    r = store.save(dir, 'CON', { v: 1, name: 'CON', grade });
    check(r && r.ok && fs.existsSync(path.join(dir, '_CON.json')), 'Windows 保留名自动加前缀');
    const reserved = store.load(dir, '_CON');
    check(!!reserved && reserved.name === '_CON', 'Windows 保留名的显示名同步实际文件名');

    r = store.rename(dir, '暖调胶片', '冷调胶片');
    check(r && r.ok, '重命名成功');
    check(!fs.existsSync(path.join(dir, '暖调胶片.json')), '旧文件已删除');
    const renamed = store.load(dir, '冷调胶片');
    check(!!renamed && renamed.name === '冷调胶片', '重命名同步更新文件内显示名');
    check(!!renamed && renamed.grade.exp === 0.35, '重命名保留调色参数');

    // 重名保护：已有目标名时必须拒绝
    store.save(dir, '已有', { v: 1, name: '已有', grade });
    r = store.rename(dir, '冷调胶片', '已有');
    check(r && r.ok === false, '重命名到已存在名称被拒绝');
    check(!!store.load(dir, '冷调胶片'), '失败的重命名不破坏源预设');

    r = store.remove(dir, '冷调胶片');
    check(r && r.ok && !store.load(dir, '冷调胶片'), '删除预设');

    // 非法路径同样不能读到目录外文件
    check(store.load(dir, '../etc/passwd') === null, '读取越界路径返回 null');
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响断言 */ }
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
