// 调色预设回归：保存 / 列表 / 应用 / 批量 / 撤销 / 缩略图 / 分享码导入
// 用法：node tools/run-electron.js tools/test-grade-presets.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
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

// 内存版调色预设存储（主进程磁盘存储由 test-grade-preset-store.js 覆盖）
const store = new Map();
ipcMain.handle('list-grade-presets', () => [...store.keys()]);
ipcMain.handle('load-grade-preset', (_e, name) => store.get(name) || null);
ipcMain.handle('save-grade-preset', (_e, { name, data }) => {
    if (!name || !data || !data.grade) return { ok: false, error: 'bad' };
    store.set(name, data);
    return { ok: true };
});
ipcMain.handle('delete-grade-preset', (_e, name) => { store.delete(name); return { ok: true }; });
ipcMain.handle('rename-grade-preset', (_e, { oldName, newName }) => {
    if (!store.has(oldName)) return { ok: false, error: 'missing' };
    if (store.has(newName)) return { ok: false, error: 'exists' };
    const data = store.get(oldName);
    store.delete(oldName);
    store.set(newName, Object.assign({}, data, { name: newName }));
    return { ok: true };
});

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
            hasExport: typeof A.normalizeGrade === 'function' && typeof A.bakeGradePreview === 'function',
            grade: JSON.parse(JSON.stringify(A.image.grade)),
        };
    })()`);
    check(setup.hasExport, '调色预设依赖的 normalizeGrade / bakeGradePreview 已导出');
    check(setup.grade.exp === 0.5 && setup.grade.con === 20, '测试照片已设置非中性调色', JSON.stringify({ exp: setup.grade.exp, con: setup.grade.con }));

    // ── 保存 + 列表 ──
    const saved = await exec(`(async () => {
        const A = window.App;
        const ok = await A.saveGradePresetFromCurrent('测试暖调');
        await A.refreshGradePresets();
        return {
            ok,
            count: A._gradePresets.length,
            name: (A._gradePresets[0] || {}).disp || '',
            rows: document.querySelectorAll('#lvGradePresets .tpl-row').length,
            badge: document.getElementById('gradePresetCount').textContent,
        };
    })()`);
    check(saved.ok && saved.count === 1 && saved.name === '测试暖调', '保存当前调色后出现在「我的调色」列表', JSON.stringify(saved));
    check(saved.rows === 1 && saved.badge === '1', '列表行与计数徽标同步更新');

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
    check(batch.onlySecond.second === 0.5 && batch.onlySecond.first === 0, '应用到选中照片只改目标，不动当前图', JSON.stringify(batch.onlySecond));
    check(batch.all[0] === 0.5 && batch.all[1] === 0.5, '应用到全部照片同时更新两张', JSON.stringify(batch.all));

    // ── 重命名 / 删除（菜单背后的能力） ──
    const manage = await exec(`(async () => {
        const A = window.App;
        window.confirm = () => true; // 删除/覆盖确认在无头窗口里不能弹原生框
        A.promptText = async () => '测试冷调';
        const okRename = await A.renameGradePresetItem(A._gradePresets[0]);
        const afterRename = A._gradePresets.map((r) => r.name);
        const okDelete = await A.deleteGradePresetItem(A._gradePresets[0]);
        return { okRename, afterRename, okDelete, left: A._gradePresets.length };
    })()`);
    check(manage.okRename && manage.afterRename[0] === '测试冷调', '重命名调色预设', JSON.stringify(manage.afterRename));
    check(manage.okDelete && manage.left === 0, '删除调色预设');

    // ── 缩略图 ──
    await exec(`(async () => {
        const A = window.App;
        // 重新保存一份，列表里才有可渲染缩略图的行。
        if (!A._gradePresets.length) await A.saveGradePresetFromCurrent('缩略图测试');
        A.switchTab('grade');
        await A.refreshGradePresets();
        await new Promise((r) => setTimeout(r, 600));
        return true;
    })()`);
    const thumb = await exec(`(() => {
        const img = document.querySelector('#lvGradePresets .tpl-thumb');
        return { src: (img && img.src) || '', w: (img && img.naturalWidth) || 0 };
    })()`);
    check(/^data:image\/jpeg;base64,/.test(thumb.src) && thumb.w > 0,
        '预设缩略图用当前照片烘焙并显示', JSON.stringify({ w: thumb.w, kind: thumb.src.slice(0, 23) }));

    // ── 分享码：复制 → 改提示 → 导入 ──
    const shared = await exec(`(async () => {
        const A = window.App;
        let copied = '';
        try {
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async (t) => { copied = t; } },
                configurable: true,
            });
        } catch (_) {}
        await A.copyGradePresetShareCode(A._gradePresets[0]);
        const code = copied || '';
        let n = 0;
        // 第一次 prompt 粘贴分享码，第二次 prompt 输入保存名。
        A.promptText = async () => (n++ === 0 ? code : '分享导入的调色');
        const okImport = await A.importGradePresetShareCode();
        return {
            prefix: code.slice(0, 10),
            len: code.length,
            okImport,
            names: A._gradePresets.map((r) => r.name),
        };
    })()`);
    check(shared.prefix === 'QFSGRADE1:' && shared.len > 40, '调色分享码以 QFSGRADE1: 开头', JSON.stringify({ prefix: shared.prefix, len: shared.len }));
    check(shared.okImport && shared.names.indexOf('分享导入的调色') >= 0, '分享码可重新导入为预设', JSON.stringify(shared.names));

    console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e && e.stack || e);
    app.exit(1);
});
