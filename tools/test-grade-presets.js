// 调色预设回归：XMP 保存 / 列表 / 应用 / 批量 / 撤销 / 悬停预览 /
// 批量导入 / 重命名 / 删除 / 纯文字列表。
// 用法：node tools/run-electron.js tools/test-grade-presets.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const FAKE_LIB = 'C:/fake/grade-presets';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 主进程 IPC：只保留 App 启动 + 本用例需要的通道 ──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) {
    ipcMain.handle(channel, EMPTY_LIST);
}
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) {
    ipcMain.handle(channel, OK);
}
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) {
    ipcMain.handle(channel, CANCEL);
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('load-acr-shadows', () => {
    try {
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin'));
        if (raw.length < 34 || raw.slice(0, 4).toString('ascii') !== 'CRS2') return null;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    } catch (_) { return null; }
});
ipcMain.handle('get-app-info', () => ({
    version: '0.1.24', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

// 内存版 XMP 预设存储（主进程磁盘存储由 test-grade-preset-store.js 覆盖）
const store = new Map();
let importFiles = null;
const presetList = () => [...store.keys()].map((name) => ({ name, ext: 'xmp' }));
const validXmp = (xml) => typeof xml === 'string' && /<(?:x:)?xmpmeta|<rdf:RDF/i.test(xml);
ipcMain.handle('list-grade-presets', presetList);
ipcMain.handle('load-grade-preset', (_e, { name, ext }) => {
    if (ext === 'json' || !store.has(name)) return null;
    return { kind: 'xmp', xml: store.get(name) };
});
ipcMain.handle('save-grade-preset', (_e, { name, xml }) => {
    if (!name || !validXmp(xml)) return { ok: false, error: 'bad' };
    store.set(name, xml);
    return { ok: true };
});
ipcMain.handle('delete-grade-preset', (_e, { name }) => { store.delete(name); return { ok: true }; });
ipcMain.handle('rename-grade-preset', (_e, { oldName, newName }) => {
    if (!store.has(oldName)) return { ok: false, error: 'missing' };
    if (store.has(newName)) return { ok: false, error: 'exists' };
    const xml = store.get(oldName);
    store.delete(oldName);
    store.set(newName, xml);
    return { ok: true };
});
ipcMain.handle('pick-grade-preset-save-path', (_e, name) => ({
    ok: true, path: FAKE_LIB + '/' + name + '.xmp', name, inLibrary: true
}));
ipcMain.handle('save-grade-preset-xmp', (_e, { path: filePath, xml }) => {
    const name = path.basename(filePath, path.extname(filePath));
    if (!validXmp(xml)) return { ok: false, error: 'bad' };
    store.set(name, xml);
    return { ok: true, path: filePath, libraryName: name, libraryPath: filePath };
});
ipcMain.handle('export-grade-preset-xmp', (_e, { path: filePath, xml }) => (
    validXmp(xml) ? { ok: true, path: filePath } : { ok: false, error: 'bad' }
));
ipcMain.handle('pick-grade-xmp-files', () => (importFiles
    ? { ok: true, files: importFiles, skipped: [] }
    : { canceled: true }));
ipcMain.handle('open-grade-presets-dir', () => ({ ok: true, path: FAKE_LIB }));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, '#8a5a3c'); grad.addColorStop(0.5, '#d9b18a'); grad.addColorStop(1, '#3f596e');
    g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

// LR / Camera Raw 风格的标准 XMP（没有清框影私有段）
const lrXmp = (name, exp, con) => `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Exposure2012="${exp}"
    crs:Contrast2012="${con}"
    crs:WhiteBalance="As Shot">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    win.showInactive();
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(900);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    const setup = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(600, 400);
        const im = { el, name: 'a', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template); A.updateEmptyState();
        A.ensureGrade(im);
        // 一套非中性调色：曝光 + 对比度 + 色温，外加一条曲线。
        A.setGrade({ exp: 0.5, con: 20, temp: 30, curve: { rgb: [[0, 0], [0.5, 0.6], [1, 1]] } });
        await new Promise((r) => setTimeout(r, 300));
        return {
            hasExport: typeof A.normalizeGrade === 'function' && typeof A.bakeGradePreview === 'function'
                && !!(window.AppXmp && typeof AppXmp.gradeToXmp === 'function'),
            grade: JSON.parse(JSON.stringify(A.image.grade)),
        };
    })()`);
    check(setup.hasExport, 'normalizeGrade / bakeGradePreview / gradeToXmp 已就绪');
    check(setup.grade.exp === 0.5 && setup.grade.con === 20, '测试照片已设置非中性调色',
        JSON.stringify({ exp: setup.grade.exp, con: setup.grade.con }));

    // ── 保存成 XMP + 列表 ──
    const saved = await exec(`(async () => {
        const A = window.App;
        const ok = await A.saveGradePresetFromCurrent('测试暖调');
        await A.refreshGradePresets();
        const data = await window.qingframe.loadGradePreset('测试暖调', 'xmp');
        const xml = (data && data.xml) || '';
        const round = xml ? window.AppXmp.mapXmp(xml) : null;
        return {
            ok,
            count: A._gradePresets.length,
            name: (A._gradePresets[0] || {}).name || '',
            rows: document.querySelectorAll('#lvGradePresets .tpl-row').length,
            badge: document.getElementById('gradePresetCount').textContent,
            isXmp: xml.indexOf('<x:xmpmeta') >= 0 && !/^\\s*\\{/.test(xml),
            hasQf: xml.indexOf('<qf:QfsGrade>') >= 0,
            hasCrs: xml.indexOf('crs:Exposure2012="0.5"') >= 0,
            round: round && round.patch ? {
                exp: round.patch.exp, temp: round.patch.temp,
                curve: !!(round.patch.curve && round.patch.curve.rgb)
            } : null,
        };
    })()`);
    check(saved.ok && saved.count === 1 && saved.name === '测试暖调', '保存当前调色后出现在「我的调色」列表',
        JSON.stringify({ ok: saved.ok, count: saved.count, name: saved.name }));
    check(saved.rows === 1 && saved.badge === '1', '列表行与计数徽标同步更新');
    check(saved.isXmp && saved.hasCrs, '保存的是带 crs: 字段的 XMP 文件');
    check(saved.hasQf && saved.round && saved.round.exp === 0.5 && saved.round.temp === 30 && saved.round.curve,
        'XMP 私有段能完整回读清框影参数（曝光/色温/曲线）', JSON.stringify(saved.round));

    // ── 应用 + 撤销 ──
    const applied = await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 80));
        const before = JSON.parse(JSON.stringify(A.image.grade));
        const ok = A.applyGradePreset(A._gradePresets[0], [0]);
        const after = JSON.parse(JSON.stringify(A.image.grade));
        const active = document.querySelector('#lvGradePresets .tpl-row.active') !== null;
        const baked = !!(A.image._grade && A.image._grade.canvas);
        A.undo();
        const undone = JSON.parse(JSON.stringify(A.image.grade));
        return { before, ok, after, active, baked, undone };
    })()`);
    check(applied.ok && applied.after.exp === 0.5 && applied.after.con === 20 && applied.after.temp === 30,
        '单击预设把全局调色套到当前照片', JSON.stringify({ exp: applied.after.exp, con: applied.after.con }));
    check(applied.active, '应用后列表标记「使用中」');
    check(applied.baked, '应用预设后立即烘焙画面（不是只改滑块）');
    check(applied.before.exp === 0 && applied.undone.exp === 0, '应用预设可 Ctrl+Z 撤销回原调色',
        JSON.stringify({ before: applied.before.exp, undone: applied.undone.exp }));

    // ── 批量：选中 / 全部 ──
    const batch = await exec(`(async () => {
        const A = window.App;
        const el2 = await window.__mk(480, 320);
        const im2 = { el: el2, name: 'b', path: null, w: 480, h: 320, exif: {}, customSettings: null, grade: null };
        A.images.push(im2); A.buildThumbnails();
        A.applyGradePreset(A._gradePresets[0], [1]);
        const onlySecond = { first: (A.images[0].grade || {}).exp, second: (A.images[1].grade || {}).exp };
        A.resetGrade();
        A.applyGradePreset(A._gradePresets[0], [0, 1]);
        return { onlySecond, all: [A.images[0].grade.exp, A.images[1].grade.exp] };
    })()`);
    check(batch.onlySecond.second === 0.5 && batch.onlySecond.first === 0, '应用到选中照片只改目标，不动当前图',
        JSON.stringify(batch.onlySecond));
    check(batch.all[0] === 0.5 && batch.all[1] === 0.5, '应用到全部照片同时更新两张', JSON.stringify(batch.all));

    // ── 左侧双模式 + 悬停预览 ──
    const hover = await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        A.setSideMode('grade', { activateTab: false });
        await new Promise((r) => setTimeout(r, 350));
        const row = document.querySelector('#lvGradePresets .tpl-row');
        const gradeBefore = A.image.grade ? A.image.grade.exp : 0;
        row.dispatchEvent(new MouseEvent('mouseenter'));
        await new Promise((r) => setTimeout(r, 500));
        const previewing = !!A._gradeHover;
        const src = window.photoSrcOf(A.image);
        const isCanvas = !!(src && src.tagName === 'CANVAS');
        const gradeDuring = A.image.grade ? A.image.grade.exp : 0;
        row.dispatchEvent(new MouseEvent('mouseleave'));
        await new Promise((r) => setTimeout(r, 80));
        const restored = !A._gradeHover && window.photoSrcOf(A.image) === A.image.el;
        // 点页签：左侧切模式，右侧顺手切到「调色」，滑块与预设同屏。
        document.getElementById('sideTabBorder').click();
        const borderOff = document.getElementById('sideGradeBody').hidden;
        document.getElementById('sideTabGrade').click();
        const rightGrade = document.getElementById('panel-grade').classList.contains('active');
        return {
            mode: A._sideMode,
            gradeBody: !document.getElementById('sideGradeBody').hidden,
            borderBody: document.getElementById('sideBorderBody').hidden,
            previewing, isCanvas, gradeBefore, gradeDuring, restored, borderOff, rightGrade,
        };
    })()`);
    check(hover.mode === 'grade' && hover.gradeBody && hover.borderBody,
        '左侧「我的调色」模式显示调色列表、隐藏边框列表', JSON.stringify(hover));
    check(hover.previewing && hover.isCanvas && hover.gradeBefore === 0 && hover.gradeDuring === 0,
        '悬停时画面立即预览，但不写入照片参数', JSON.stringify({ before: hover.gradeBefore, during: hover.gradeDuring }));
    check(hover.restored, '移开鼠标后画面与缓存还原');
    check(hover.borderOff && hover.rightGrade,
        '点页签真正切模式，并同步右侧到调色页签', JSON.stringify({ borderOff: hover.borderOff, rightGrade: hover.rightGrade }));

    // ── 批量导入：一个按钮多选 .xmp，失败文件跳过 ──
    importFiles = [
        { name: '导入冷调', path: 'C:/in/导入冷调.xmp', xml: lrXmp('导入冷调', -0.75, 18) },
        { name: '坏预设', path: 'C:/in/坏预设.xmp', xml: 'not an xmp' },
    ];
    const imported = await exec(`(async () => {
        const A = window.App;
        const ok = await A.importGradePresets();
        const names = A._gradePresets.map((r) => r.name);
        const status = (document.getElementById('stCanvas') || {}).textContent || '';
        const entry = A._gradePresets.find((r) => r.name === '导入冷调');
        return {
            ok, names, status,
            exp: entry && entry.grade ? entry.grade.exp : null,
            con: entry && entry.grade ? entry.grade.con : null,
        };
    })()`);
    check(imported.ok && imported.names.indexOf('导入冷调') >= 0, '批量导入标准 LR XMP 预设',
        JSON.stringify(imported.names));
    check(imported.exp === -0.75 && imported.con === 18, '导入后参数按 LR 语义映射',
        JSON.stringify({ exp: imported.exp, con: imported.con }));
    check(imported.status.indexOf('成功 1') >= 0 && imported.status.indexOf('跳过 1') >= 0,
        '一次导入汇总成功 / 失败数量', imported.status);

    const reimport = await exec(`(async () => {
        const A = window.App;
        await A.importGradePresets();
        return A._gradePresets.map((r) => r.name);
    })()`);
    check(reimport.indexOf('导入冷调') >= 0 && reimport.indexOf('导入冷调 (2)') < 0,
        '重复导入同一预设不产生重复条目', JSON.stringify(reimport));
    importFiles = null;

    // ── 重命名 / 删除（菜单背后的能力） ──
    const manage = await exec(`(async () => {
        const A = window.App;
        window.confirm = () => true;
        A.promptText = async () => '测试冷调';
        const target = A._gradePresets.find((r) => r.name === '测试暖调');
        const okRename = await A.renameGradePresetItem(target);
        const afterRename = A._gradePresets.map((r) => r.name);
        const renamed = A._gradePresets.find((r) => r.name === '测试冷调');
        const data = await window.qingframe.loadGradePreset('测试冷调', 'xmp');
        const round = data && data.xml ? window.AppXmp.mapXmp(data.xml) : null;
        const okDelete = await A.deleteGradePresetItem(renamed);
        return {
            okRename, afterRename, okDelete,
            left: A._gradePresets.map((r) => r.name),
            innerName: round ? round.name : '',
        };
    })()`);
    check(manage.okRename && manage.afterRename.indexOf('测试冷调') >= 0, '重命名调色预设',
        JSON.stringify(manage.afterRename));
    check(manage.innerName === '测试冷调', '重命名同步更新 XMP 内的预设名', manage.innerName);
    check(manage.okDelete && manage.left.indexOf('测试冷调') < 0, '删除调色预设', JSON.stringify(manage.left));

    // ── 纯文字列表 ──
    // 左侧栏窄，一行一个预设名更好扫；顺带省掉每张预设都跑一遍调色管线的开销。
    await exec(`(async () => {
        const A = window.App;
        A.setSideMode('grade', { activateTab: false });
        await A.refreshGradePresets();
        await new Promise((r) => setTimeout(r, 300));
        return true;
    })()`);
    const list = await exec(`(() => {
        const box = document.getElementById('lvGradePresets');
        const row = box && box.querySelector('.grade-preset-row');
        const info = row && row.querySelector('.grade-preset-info');
        const nameEl = row && row.querySelector('.tpl-name');
        // 长名字必须靠省略号收在行内：临时换长文本量一下再还原。
        let clipped = false;
        if (nameEl) {
            const old = nameEl.textContent;
            nameEl.textContent = '一个名字特别长的调色预设用来看省略号';
            clipped = nameEl.scrollWidth > nameEl.clientWidth + 1 && nameEl.clientWidth > 0;
            nameEl.textContent = old;
        }
        return {
            rows: box ? box.querySelectorAll('.grade-preset-row').length : 0,
            thumbs: box ? box.querySelectorAll('.tpl-thumb').length : 0,
            name: (nameEl && nameEl.textContent) || '',
            hasInfo: !!info,
            dir: info ? getComputedStyle(info).flexDirection : '',
            overflow: row ? row.scrollWidth - row.clientWidth : 0,
            clipped,
        };
    })()`);
    check(list.rows > 0 && list.thumbs === 0 && list.hasInfo && list.name,
        '列表是纯文字行（不烘缩略图），预设名可读', JSON.stringify(list));
    check(list.dir === 'row' && list.overflow <= 1 && list.clipped,
        '名称与「使用中」同排，长名字用省略号收在行内', JSON.stringify(list));

    // ── 导出 XMP（菜单能力） ──
    const exported = await exec(`(async () => {
        const A = window.App;
        const r = A._gradePresets[0];
        const ok = await A.exportGradePresetToFile(r);
        return { ok, status: (document.getElementById('stCanvas') || {}).textContent || '' };
    })()`);
    check(exported.ok && exported.status.indexOf('已导出') >= 0, '预设可另存为 XMP 文件', exported.status);

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});
