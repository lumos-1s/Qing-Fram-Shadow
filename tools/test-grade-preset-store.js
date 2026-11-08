'use strict';
// 调色预设存储回归（纯 node，不需要 Electron）
//   node tools/test-grade-preset-store.js
//
// 覆盖：XMP 保存/读取/列表/重命名/删除、路径穿越收口、Windows 保留名、
// 旧版 .json 兼容与同名优先 .xmp、非法内容拒绝、库外收录的唯一命名。
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'main', 'grade-preset-store.js'));

let fails = 0;
function check(ok, label, extra) {
    if (ok) console.log('  OK   ' + label);
    else { fails++; console.log('  FAIL ' + label + (extra ? ' | ' + extra : '')); }
}

const xmp = (name, exp) => `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <!-- ${name} -->
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Exposure2012="${exp}" crs:Contrast2012="12">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const names = (list) => list.map((x) => x.name);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-grade-preset-'));

try {
    check(store.list(dir).length === 0, '空目录列表为空');

    let r = store.save(dir, '暖调胶片', xmp('暖调胶片', 0.35));
    check(r && r.ok, '保存中文名称 XMP 预设', JSON.stringify(r));
    check(fs.existsSync(path.join(dir, '暖调胶片.xmp')), '文件后缀是 .xmp');

    const list = store.list(dir);
    check(list.length === 1 && list[0].name === '暖调胶片' && list[0].ext === 'xmp',
        '列表返回名称与格式', JSON.stringify(list));

    const loaded = store.load(dir, '暖调胶片', 'xmp');
    check(!!loaded && loaded.kind === 'xmp' && loaded.xml.indexOf('crs:Exposure2012="0.35"') >= 0,
        '读取 XMP 内容');

    r = store.save(dir, '坏数据', '{"grade":{}}');
    check(r && r.ok === false, '不是 XMP 的内容被拒绝');

    r = store.save(dir, '空内容', '   ');
    check(r && r.ok === false, '空内容被拒绝');

    r = store.save(dir, '../escape', xmp('escape', 0.2));
    check(r && r.ok, '越界名称被收口为目录内文件名');
    check(fs.existsSync(path.join(dir, 'escape.xmp')), '实际文件仍落在预设目录内');
    check(!fs.existsSync(path.join(path.dirname(dir), 'escape.xmp')), '没有写到预设目录之外');
    check(!!store.load(dir, '../escape', 'xmp'), '用原始越界名仍能读回收口后的文件');

    r = store.save(dir, 'CON', xmp('CON', 0.1));
    check(r && r.ok && fs.existsSync(path.join(dir, '_CON.xmp')), 'Windows 保留名自动加前缀');

    // 旧版 .json 兼容：能列出、能读；同名时优先 .xmp。
    fs.writeFileSync(path.join(dir, '旧版.json'), JSON.stringify({
        v: 1, kind: 'qfs-grade-preset', name: '旧版', grade: { exp: 0.4 }
    }), 'utf-8');
    const legacyList = store.list(dir);
    check(names(legacyList).indexOf('旧版') >= 0
        && legacyList.find((x) => x.name === '旧版').ext === 'json', '旧版 .json 仍能列出');
    const legacy = store.load(dir, '旧版', 'json');
    check(!!legacy && legacy.kind === 'json' && legacy.data.grade.exp === 0.4, '旧版 .json 能读出参数');

    fs.writeFileSync(path.join(dir, '旧版.xmp'), xmp('旧版', 0.5), 'utf-8');
    const prefer = store.list(dir).find((x) => x.name === '旧版');
    check(!!prefer && prefer.ext === 'xmp', '同名时列表优先 .xmp');

    r = store.rename(dir, '暖调胶片', '冷调胶片');
    check(r && r.ok, '重命名成功');
    check(!fs.existsSync(path.join(dir, '暖调胶片.xmp')), '旧文件已删除');
    check(fs.existsSync(path.join(dir, '冷调胶片.xmp')), '新文件已生成');

    // 重名保护：已有目标名时必须拒绝
    store.save(dir, '已有', xmp('已有', 0));
    r = store.rename(dir, '冷调胶片', '已有');
    check(r && r.ok === false, '重命名到已存在名称被拒绝');
    check(!!store.load(dir, '冷调胶片', 'xmp'), '失败的重命名不破坏源预设');

    // 库外另存时的唯一命名：同名自动 (2)、(3)
    const unique1 = store.uniqueName(dir, '已有');
    check(unique1 === '已有 (2)', '库外收录重名时追加 (2)', unique1);
    store.save(dir, unique1, xmp(unique1, 0));
    const unique2 = store.uniqueName(dir, '已有');
    check(unique2 === '已有 (3)', '再重名时继续追加 (3)', unique2);

    r = store.remove(dir, '冷调胶片', 'xmp');
    check(r && r.ok && !store.load(dir, '冷调胶片', 'xmp'), '删除 XMP 预设');
    r = store.remove(dir, '旧版', 'json');
    check(r && r.ok && !fs.existsSync(path.join(dir, '旧版.json')), '删除旧版 .json');
    check(!!store.load(dir, '旧版', 'xmp'), '删除 .json 不影响同名 .xmp');

    // 非法路径同样不能读到目录外文件
    check(store.load(dir, '../etc/passwd', 'xmp') === null, '读取越界路径返回 null');
} finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响断言 */ }
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
