// 自动检查更新的策略判定（纯逻辑，不依赖 electron，可离线单测）
//
// 三档：
//   startup 每次启动都查（默认，与加开关之前的行为一致）
//   daily   一天最多查一次（按上次查完的时间戳，不是按启动次数）
//   off     从不自动查，只能手动点「检查更新」
//
// 只决定「要不要自动查」，不决定「装不装」——下载与安装始终要用户点按钮。

const MODES = ['startup', 'daily', 'off'];
const DAY_MS = 24 * 60 * 60 * 1000;

// 脏值（旧配置/手改 state.json/未来新增档位被旧版读到）一律回落到默认档，
// 不能因为读不懂就静默变成「从不检查」——那是用户看不出来的功能消失。
function normalizeAutoCheck(v) {
    return MODES.indexOf(v) >= 0 ? v : 'startup';
}

function shouldAutoCheck(prefs, now) {
    const mode = normalizeAutoCheck(prefs && prefs.autoCheck);
    if (mode === 'off') return false;
    if (mode === 'startup') return true;
    const last = Number(prefs && prefs.updateCheckedAt) || 0;
    const t = Number(now) || 0;
    if (!last || !t) return true;
    // 时钟回拨（改系统时间 / 时区跳变）会让差值变负：按「该查」处理，
    // 否则一次回拨就能把自动更新永久卡死。
    if (t < last) return true;
    return (t - last) >= DAY_MS;
}

module.exports = { MODES, DAY_MS, normalizeAutoCheck, shouldAutoCheck };
