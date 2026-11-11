// 跑 package.json 里定义的一条 `npm run a && npm run b && …` 链。
//
// 为什么需要它：以前 test:gui / check 就是一长串 &&，test:raw 曾因一句过期文案
// 断言失败，后面的 58 个脚本根本没执行 —— CI 却只报了一个红。绿灯的可信度
// 取决于「全部都跑过」，不是「第一个没挂」。这里改成逐项执行、失败继续、末尾汇总。
//
// 用法：node tools/run-script-chain.js <scripts 里的链名>
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
// QF_CHAIN_PKG 只给自测用：指向一个临时 package.json，验证「失败也继续跑」。
const pkg = process.env.QF_CHAIN_PKG
    ? require(path.resolve(process.env.QF_CHAIN_PKG))
    : require(path.join(__dirname, '..', 'package.json'));

const key = process.argv[2];
if (!key || !pkg.scripts || !pkg.scripts[key]) {
    console.error('用法: node tools/run-script-chain.js <scripts 里的链名>');
    process.exit(2);
}

const steps = pkg.scripts[key].split('&&').map((s) => s.trim()).filter(Boolean);
const failures = [];
const started = Date.now();
const pad = String(steps.length).length;
const line = '─'.repeat(72);

console.log(`\n链 ${key}：共 ${steps.length} 项，单项失败不中断\n${line}`);

steps.forEach((raw, i) => {
    const m = /^npm run ([\w:.-]+)$/.exec(raw);
    const name = m ? m[1] : raw;
    const cmd = m ? 'npm' : null;
    const args = m ? ['run', name] : null;
    const t0 = Date.now();
    process.stdout.write(`[${String(i + 1).padStart(pad)}/${steps.length}] ${name} … `);
    const r = cmd
        ? spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
        : spawnSync(raw, { stdio: 'inherit', shell: true });
    const ok = r.status === 0 && !r.error;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${ok ? 'OK' : 'FAIL'}  ${secs}s`);
    if (!ok) failures.push({ name, code: r.status, error: r.error && r.error.message });
});

console.log(line);
if (failures.length) {
    console.log(`✖ ${failures.length}/${steps.length} 项失败：`);
    failures.forEach((f) => console.log(`   - ${f.name}${f.code != null ? ` (exit ${f.code})` : ''}${f.error ? ' ' + f.error : ''}`));
} else {
    console.log(`✓ 全部 ${steps.length} 项通过`);
}
console.log(`总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failures.length ? 1 : 0);
