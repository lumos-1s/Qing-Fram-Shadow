// 打包产物校验:确认发行版里没有第三方品牌 Logo
// 用法: node tools/verify-dist.js                (npm run verify:dist)  校验 app.asar 内容
//       node tools/verify-dist.js --installers   校验 latest.yml 与安装包是否同一次构建
// 退出码: 0 = 干净, 1 = 已确定的失败(Logo 泄漏 / 关键内容缺失 / 没有可读产物 /
//         更新清单与安装包对不上), 2 = 无法判定(仅产物早于源码改动这种拿不准的情况)
//
// 为什么需要这个:build.files 里的 `!shared/brandlogos/**` 是唯一的真相源,但它只影响
// 「下次打包」。一旦有人改了 files 配置、或用了旧配置打出来的产物,Logo 就会静默进包。
// 每次发布前跑一次本脚本,把「靠记得」变成「靠检查」。
//
// 为什么要有 --installers:electron-updater 是按 latest.yml 里的 size/sha512 校验下载
// 结果的。中断的构建会留下一个只含 NSIS stub 的几百 KB 残骸(正常应几十 MB),而
// latest.yml 仍指着上一次的完整包 —— 结果是「本地看着有安装包」但用户更新必失败。
// 原先这段只打印体积当作提示,不作判定,所以上面那种状态能一路溜到发布。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const LEAK_MARKER = 'brandlogos';
// 应当出现在发行版里的关键内容(缺了说明打包配置把正常文件也排除了)
const EXPECTED = [
    { label: '主进程入口', match: /src[\\/]main[\\/]index\.js$/ },
    { label: '渲染引擎', match: /src[\\/]renderer[\\/]js[\\/]engine\.js$/ },
    { label: '预设目录', match: /shared[\\/]presets$/ },
    // 调色色表：混色器/校准/饱和度/颜色分级全靠它。漏打进包的话这些档位在用户端
    // 会静默失效（拖了没反应），而且测试里因为手动 ensure 过，一样是绿的。
    { label: 'ACR 调色色表', match: /shared[\\/]acr[\\/]cr-tables\.bin$/ },
];

// 期望的预设/纹理数量从源码目录实测,不再硬编码。
// 原先写死 70,而预设已经加到 78 —— 那条断言会一直亮红,把一个「配置漂移」问题
// 稀释成噪音;更糟的是它和「产物过期」共用一个退出码,真缺失会被当成「无法判定」。
function countSource(relDir, re) {
    try {
        return fs.readdirSync(path.join(ROOT, relDir)).filter(f => re.test(f)).length;
    } catch (e) {
        return 0;
    }
}
const EXPECT_PRESETS = countSource(path.join('shared', 'presets'), /\.json$/i);
const EXPECT_TEXTURES = countSource(path.join('shared', 'textures'), /\.(png|jpe?g)$/i);

const INSTALLERS_ONLY = process.argv.includes('--installers');

// latest.yml 是 electron-updater 的更新清单:客户端拿它里面的 size/sha512 去校验下载结果,
// 对不上就报「更新失败」。手写解析即可(不引 yaml 依赖),结构就三层:
//   version / files:[- url, sha512, size] / path / sha512
function parseLatestYml(file) {
    const out = { version: '', files: [] };
    let cur = null;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        let m;
        if ((m = raw.match(/^version:\s*(.+)\s*$/))) out.version = m[1];
        else if ((m = raw.match(/^\s*-\s+url:\s*(.+)\s*$/))) { cur = { url: m[1], sha512: '', size: -1 }; out.files.push(cur); }
        else if (cur && (m = raw.match(/^\s+sha512:\s*(.+)\s*$/))) cur.sha512 = m[1];
        else if (cur && (m = raw.match(/^\s+size:\s*(\d+)\s*$/))) cur.size = Number(m[1]);
        else if ((m = raw.match(/^path:\s*(.+)\s*$/))) out.path = m[1];
        else if ((m = raw.match(/^sha512:\s*(.+)\s*$/))) out.rootSha512 = m[1];
    }
    return out;
}

function sha512Base64(file) {
    return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

// 返回 problems 数组(空 = 通过)。只对 latest.yml 里**声明过**的文件做判定 ——
// portable 版不参与自动更新、也不写进清单,不该拿它去撞清单。
function verifyInstallers() {
    const problems = [];
    const latest = path.join(DIST, 'latest.yml');
    if (!fs.existsSync(latest)) {
        console.log('· 没有 dist/latest.yml(尚未构建过可发布的安装包),跳过更新清单校验。');
        return problems;
    }
    const yml = parseLatestYml(latest);
    if (!yml.files.length) {
        problems.push('latest.yml 里没有声明任何 files,electron-updater 无从下载');
        return problems;
    }
    console.log(`\n▶ dist/latest.yml  (版本 ${yml.version || '?'})`);
    for (const f of yml.files) {
        const full = path.join(DIST, f.url);
        if (!fs.existsSync(full)) {
            console.log(`  ${f.url}        ← 清单声明了但文件不存在`);
            problems.push(`latest.yml 声明的 ${f.url} 不存在`);
            continue;
        }
        const actual = fs.statSync(full).size;
        const sizeOk = actual === f.size;
        // size 对不上就没必要算 hash 了 —— 75MB 的 hash 要几秒,而结论已经确定。
        if (!sizeOk) {
            console.log(`  ${f.url}\n      实际 ${(actual / 1024 / 1024).toFixed(1)} MB (${actual}) ≠ 清单 ${(f.size / 1024 / 1024).toFixed(1)} MB (${f.size})   ← 构建被中断或清单过期`);
            problems.push(`${f.url} 体积与 latest.yml 不一致(${actual} ≠ ${f.size})`);
            continue;
        }
        const hash = sha512Base64(full);
        if (hash !== f.sha512) {
            console.log(`  ${f.url}        ← 体积吻合但 sha512 不符`);
            problems.push(`${f.url} sha512 与 latest.yml 不一致`);
            continue;
        }
        console.log(`  ${f.url}  ${(actual / 1024 / 1024).toFixed(1)} MB  size + sha512 一致   ✓`);
    }
    return problems;
}

function findAsar(dir, out = [], depth = 0) {
    if (depth > 4) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) findAsar(full, out, depth + 1);
        else if (e.name === 'app.asar') out.push(full);
    }
    return out;
}

function listAsar(asarPath) {
    const asar = require('@electron/asar');
    const fn = asar.listPackage || asar.list;
    if (typeof fn !== 'function') throw new Error('@electron/asar 没有 listPackage/list 方法');
    return fn(asarPath);
}

console.log('清框影 · 打包产物校验' + (INSTALLERS_ONLY ? ' —— 安装包 / 更新清单' : ''));
console.log('─'.repeat(56));

if (!fs.existsSync(DIST)) {
    console.log('× dist/ 不存在 —— 还没有打包过,无法校验。');
    console.log('  先执行: npm run dist');
    process.exit(2);
}

const asars = INSTALLERS_ONLY ? [] : findAsar(DIST);

// 产物新鲜度:app.asar 若比「源码/配置」还旧,说明它是上一次构建留下的,不能代表当前配置。
// 不做这一步的话,重新打包失败时会拿旧 asar 校验并误报通过。
const SOURCE_ROOTS = ['src', 'shared', 'package.json'];
// 只把「代码与配置」算作源码时间:排除 shared/brandlogos(那 106 个素材的 mtime 会把
// 「最新源码时间」拉到未来,导致刚打好的包被误判过期),也排除 dist 之类的产物。
const SOURCE_EXT = new Set(['.js', '.html', '.css', '.json', '.svg']);
const SOURCE_SKIP = /[\\/]brandlogos[\\/]/;
let newestSource = 0;
function scanNewest(p) {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        if (SOURCE_SKIP.test(p + path.sep)) return;
        for (const e of fs.readdirSync(p)) scanNewest(path.join(p, e));
    } else if (SOURCE_EXT.has(path.extname(p).toLowerCase()) && !SOURCE_SKIP.test(p)) {
        if (st.mtimeMs > newestSource) newestSource = st.mtimeMs;
    }
}
SOURCE_ROOTS.forEach(r => scanNewest(path.join(ROOT, r)));

if (!INSTALLERS_ONLY && !asars.length) {
    console.log('× 在 dist/ 下找不到 app.asar,无法校验。');
    console.log('  dist/ 里现有: ' + (fs.readdirSync(DIST).join(', ') || '(空)'));
    console.log('  安装包(nsis/portable)内部无法直接读取,请先产出未压缩目录:');
    console.log('    node node_modules/electron-builder/out/cli/cli.js --win --dir');
    process.exit(2);
}

let leaked = 0;
let checked = 0;
let missingExpected = 0;
let stale = 0;

for (const asarPath of asars) {
    const rel = path.relative(ROOT, asarPath);
    let files;
    try {
        files = listAsar(asarPath);
    } catch (e) {
        console.log(`\n? ${rel} 读取失败: ${e.message}`);
        continue;
    }
    checked++;

    const asarMtime = fs.statSync(asarPath).mtimeMs;
    const isStale = asarMtime < newestSource;
    if (isStale) stale++;
    const ageMark = isStale
        ? `   ← 已过期(早于源码改动 ${Math.round((newestSource - asarMtime) / 60000)} 分钟)`
        : '   ✓';

    const logos = files.filter(f => f.includes(LEAK_MARKER) && !f.endsWith('brandlogos'));
    const logoDirs = files.filter(f => f.endsWith('brandlogos') || f.endsWith('brandlogos\\') || f.endsWith('brandlogos/'));
    const presets = files.filter(f => /shared[\\/]presets[\\/].+\.json$/.test(f));
    const textures = files.filter(f => /shared[\\/]textures[\\/].+\.(png|jpg|jpeg)$/i.test(f));

    console.log(`\n▶ ${rel}`);
    console.log(`  生成时间            : ${new Date(asarMtime).toLocaleString()}${ageMark}`);
    console.log(`  条目总数            : ${files.length}`);
    console.log(`  品牌 Logo 文件      : ${logos.length}${logos.length ? '   ← 泄漏!' : '   ✓'}`);
    console.log(`  brandlogos 目录条目 : ${logoDirs.length}${logoDirs.length ? '   ← 泄漏!' : '   ✓'}`);
    console.log(`  shared/presets 预设 : ${presets.length}${presets.length === EXPECT_PRESETS ? '   ✓' : `   ← 数量异常(源码现有 ${EXPECT_PRESETS})`}`);
    console.log(`  shared/textures 纹理: ${textures.length}${textures.length === EXPECT_TEXTURES ? '   ✓' : `   ← 数量异常(源码现有 ${EXPECT_TEXTURES})`}`);

    if (logos.length) {
        console.log('  泄漏样例:');
        logos.slice(0, 5).forEach(f => console.log(`    ${f}`));
    }
    if (presets.length !== EXPECT_PRESETS || textures.length !== EXPECT_TEXTURES) missingExpected++;

    for (const exp of EXPECTED) {
        if (!files.some(f => exp.match.test(f))) {
            console.log(`  ! 缺少${exp.label}`);
            missingExpected++;
        }
    }

    leaked += logos.length + logoDirs.length;
}

// 安装包:默认模式只作提示 —— 此时 exe/latest.yml 还是上一次构建留下的,release 链的
// 下一步(electron-builder --win)才会重建它们,在这里做强判定会把一个能自愈的状态判死。
// --installers 跑在重建之后,对清单里声明的每个文件做 size/sha512 实质校验。
const installers = fs.readdirSync(DIST).filter(f => /\.(exe|dmg|AppImage|zip)$/i.test(f));
let installerProblems = [];
if (INSTALLERS_ONLY) {
    installerProblems = verifyInstallers();
} else if (installers.length) {
    console.log(`\n· dist/ 下的安装包(内部无法直接读取,仅提示):`);
    installers.forEach(f => {
        const st = fs.statSync(path.join(DIST, f));
        console.log(`    ${f}  ${(st.size / 1024 / 1024).toFixed(1)} MB  ${st.mtime.toLocaleString()}`);
    });
    console.log('    若这些包打在排除规则生效之前,它们仍含 Logo —— 需重新打包后覆盖。');
}

console.log('\n' + '─'.repeat(56));
const problems = [];
if (leaked) {
    problems.push(`发现 ${leaked} 处品牌 Logo 泄漏`);
}
if (!INSTALLERS_ONLY && !checked) {
    problems.push('没有任何 app.asar 被成功读取');
}
if (stale) {
    problems.push(`${stale} 个 app.asar 早于源码改动(产物过期,不能代表当前配置)`);
}
if (missingExpected) {
    problems.push(`${missingExpected} 项内容缺失或数量异常`);
}
for (const p of installerProblems) problems.push(p);

if (problems.length) {
    console.log('✖ 校验未通过:');
    problems.forEach(p => console.log(`  - ${p}`));
    if (leaked) {
        console.log('  → 检查 package.json 的 build.files 是否仍含 "!shared/brandlogos/**"。');
    }
    if (stale && !leaked) {
        console.log('  → 删除 dist/ 后重新打包,否则校验的是旧产物。');
    }
    if (installerProblems.length && !leaked && !missingExpected) {
        console.log('  → 重新执行 npm run dist,让安装包与 latest.yml 同批生成;残骸 exe 可先删掉。');
    }
    // 1 = 已确定的失败(Logo 泄漏 / 关键内容缺失 / 没有任何产物可读 / 更新清单对不上);
    // 2 = 无法判定(仅"产物比源码旧"这种拿不准的情况)。内容缺失与清单不符都是确定结论,不能算 2。
    process.exit(leaked || (!INSTALLERS_ONLY && !checked) || missingExpected || installerProblems.length ? 1 : 2);
}
if (INSTALLERS_ONLY) {
    console.log(`✓ 通过:latest.yml 声明的安装包与磁盘文件 size/sha512 一致,可安全发布/更新。`);
} else {
    console.log(`✓ 通过:检查了 ${checked} 个 app.asar,产物新鲜、无品牌 Logo,预设与纹理齐全。`);
}
