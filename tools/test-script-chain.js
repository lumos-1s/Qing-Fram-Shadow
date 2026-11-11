// 回归：脚本链 runner 必须「单项失败不中断后续，末尾汇总并以非 0 退出」。
// 用法：node tools/test-script-chain.js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, '.tmp', 'chain-test');
fs.mkdirSync(dir, { recursive: true });

let fails = 0;
function ok(cond, label, extra) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!cond) fails++;
}

const mk = (name, body) => {
    const p = path.join(dir, name + '.js');
    fs.writeFileSync(p, body);
    return p;
};
const a = mk('a', "require('fs').writeFileSync(require('path').join(__dirname,'a.done'),'1');");
const b = mk('b', "require('fs').writeFileSync(require('path').join(__dirname,'b.done'),'1'); process.exit(3);");
const c = mk('c', "require('fs').writeFileSync(require('path').join(__dirname,'c.done'),'1');");
for (const f of ['a.done', 'b.done', 'c.done']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}
const pkgPath = path.join(dir, 'package.json');
fs.writeFileSync(pkgPath, JSON.stringify({
    scripts: { chain: `node "${a}" && node "${b}" && node "${c}"` }
}));

const r = spawnSync(process.execPath, [path.join(__dirname, 'run-script-chain.js'), 'chain'], {
    env: Object.assign({}, process.env, { QF_CHAIN_PKG: pkgPath }),
    encoding: 'utf8'
});
const out = String((r.stdout || '') + (r.stderr || ''));
const done = (f) => fs.existsSync(path.join(dir, f));

ok(r.status === 1, '有失败项时以非 0 退出', `exit=${r.status}`);
ok(done('a.done') && done('b.done') && done('c.done'),
    '中间那项失败后，第三项仍然执行了',
    `a=${done('a.done')} b=${done('b.done')} c=${done('c.done')}`);
ok(/1\/3 项失败/.test(out) && /3\/3/.test(out),
    '末尾汇总列出失败项与总数', out.trim().split('\n').slice(-4).join(' / '));

// 全绿的场景：退出码必须是 0
const goodPkg = path.join(dir, 'good.json');
fs.writeFileSync(goodPkg, JSON.stringify({
    scripts: { chain: `node "${a}" && node "${c}"` }
}));
const g = spawnSync(process.execPath, [path.join(__dirname, 'run-script-chain.js'), 'chain'], {
    env: Object.assign({}, process.env, { QF_CHAIN_PKG: goodPkg }), encoding: 'utf8'
});
ok(g.status === 0, '全部通过时以 0 退出', `exit=${g.status}`);

// test:gui 走的是 `npm run X` 分支，单独覆盖一次（链定义与脚本都在临时目录里）
fs.writeFileSync(pkgPath, JSON.stringify({
    scripts: {
        chain: 'npm run okOne && npm run badOne && npm run okTwo',
        okOne: `node "${a}"`,
        badOne: `node "${b}"`,
        okTwo: `node "${c}"`
    }
}));
for (const f of ['a.done', 'b.done', 'c.done']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}
const n = spawnSync(process.execPath, [path.join(__dirname, 'run-script-chain.js'), 'chain'], {
    cwd: dir,
    env: Object.assign({}, process.env, { QF_CHAIN_PKG: pkgPath }),
    encoding: 'utf8'
});
ok(n.status === 1 && done('a.done') && done('b.done') && done('c.done'),
    '`npm run X` 形式同样失败不中断，且退出码正确',
    `exit=${n.status} a=${done('a.done')} b=${done('b.done')} c=${done('c.done')}`);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
