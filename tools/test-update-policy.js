// 「自动检查更新」策略判定回归（纯 Node，不需要 Electron）：
// 用法：node tools/test-update-policy.js
//
// 对应行为（src/main/update-policy.js）：
//   每次启动  → 每次都查（默认，与加开关之前一致）
//   每天一次  → 距上次查完不足 24h 就跳过
//   从不      → 只有手动点「检查更新」才查
// 认不出的值（手改 state.json / 未来新增档位被旧版读到）一律回落到默认档，
// 绝不能因为读不懂就静默变成「从不」——那是用户看不出来的功能消失。
'use strict';

const { MODES, DAY_MS, normalizeAutoCheck, shouldAutoCheck } = require('../src/main/update-policy');

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const NOW = 1762000000000; // 固定基准，避免测试依赖真实时钟

check(MODES.length === 3 && MODES[0] === 'startup',
    '档位只有三档且首档是「每次启动」', JSON.stringify(MODES));

// ── A：归一化 ──
check(normalizeAutoCheck('startup') === 'startup' && normalizeAutoCheck('daily') === 'daily'
    && normalizeAutoCheck('off') === 'off', '三档原样保留');
check(normalizeAutoCheck(undefined) === 'startup' && normalizeAutoCheck(null) === 'startup'
    && normalizeAutoCheck('') === 'startup', '没设置过 → 默认每次启动（老用户升级后行为不变）');
check(normalizeAutoCheck('weekly') === 'startup' && normalizeAutoCheck('STARDARD') === 'startup'
    && normalizeAutoCheck(0) === 'startup' && normalizeAutoCheck({}) === 'startup',
    '认不出的脏值一律回落默认档（不会静默变成从不）');

// ── B：每次启动 ──
check(shouldAutoCheck({ autoCheck: 'startup' }, NOW) === true, '每次启动：查');
check(shouldAutoCheck({ autoCheck: 'startup', updateCheckedAt: NOW - 1000 }, NOW) === true,
    '每次启动：刚查过也照查');

// ── C：每天一次 ──
check(shouldAutoCheck({ autoCheck: 'daily' }, NOW) === true, '每天一次：从没查过 → 查');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: NOW - DAY_MS - 1 }, NOW) === true,
    '每天一次：距上次超过 24h → 查');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: NOW - DAY_MS + 1000 }, NOW) === false,
    '每天一次：距上次不足 24h → 跳过');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: NOW }, NOW) === false,
    '每天一次：刚查过 → 跳过');

// ── D：从不 ──
check(shouldAutoCheck({ autoCheck: 'off' }, NOW) === false, '从不：不查');
check(shouldAutoCheck({ autoCheck: 'off', updateCheckedAt: NOW - 30 * DAY_MS }, NOW) === false,
    '从不：隔再久也不查（只能手动点）');

// ── E：异常输入 ──
check(shouldAutoCheck(null, NOW) === true && shouldAutoCheck({}, NOW) === true,
    '没存过 prefs → 按默认档查');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: 'abc' }, NOW) === true,
    '时间戳是脏值 → 当没查过');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: NOW - 3600000 }, 0) === true,
    '拿不到当前时间 → 查（不因为时钟缺失就不更新）');
check(shouldAutoCheck({ autoCheck: 'daily', updateCheckedAt: NOW + 10 * DAY_MS }, NOW) === true,
    '时钟回拨（上次时间在未来）→ 照查，不能把自动更新永久卡死');

if (failures.length) {
    console.error(`\n自动检查更新策略失败: ${failures.length}`);
    failures.forEach((f) => console.error(' - ' + f));
    process.exit(1);
}
console.log('\n全部通过');
