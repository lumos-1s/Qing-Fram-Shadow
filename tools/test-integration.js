// 主进程集成用例：真实主进程 + 真实 preload + 真实渲染页，不 mock IPC。
//
// 覆盖 opencode 那轮加固的核心承诺（每一条都曾是真实缺陷）：
//   1. sandbox 开着时 preload 仍可用（contextIsolation + sandbox）
//   2. 草稿里的大 data: 图能外置成 qfasset: 再原样还原（localStorage 超限丢图）
//   3. qflocal:// 只服务主进程登记过的图片（未登记 → 加载失败）
//   4. 文件夹导入会登记每一张（曾漏登记导致整批 403）
//   5. 没有 pick-export-location 令牌就不能写盘
//   6. 导出文件名里的 ../ 不能逃出目标目录
//   7. .qfs 流式导出（begin→add→finish）能回读，且逐张写、不整包驻留内存
//
// 注意：不依赖 shared/brandlogos（那是本机素材、不入库、CI 上没有）。
// 示例图在临时目录里现生成。
'use strict';
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-it-'));
const qfsOut = path.join(tmp, 'roundtrip.qfs');
const exportDir = path.join(tmp, 'export-out');
const folderImport = path.join(tmp, 'folder-import');
fs.mkdirSync(exportDir, { recursive: true });
fs.mkdirSync(folderImport, { recursive: true });

// 1×1 PNG：既当"导入文件夹里的照片"，也当 .qfs 里的图
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_B64;
const importedPhoto = path.join(folderImport, 'folder-photo.png');
// 这张必须放在导入目录**之外**：放进去了就会被文件夹导入一并登记，测不到"未登记"分支
const notRegisteredPhoto = path.join(tmp, 'not-registered.png');
fs.writeFileSync(importedPhoto, Buffer.from(PNG_B64, 'base64'));
fs.writeFileSync(notRegisteredPhoto, Buffer.from(PNG_B64, 'base64'));

app.setPath('userData', path.join(tmp, 'userData'));

const fmt = (p) => p.replace(/\\/g, '\\\\');
dialog.showSaveDialog = async (opts) => {
    if (opts && opts.title === '导出工程 (.qfs)') return { canceled: false, filePath: qfsOut };
    if (opts && opts.title === '导出图片') return { canceled: false, filePath: path.join(exportDir, 'one.png') };
    return { canceled: true };
};
dialog.showOpenDialog = async (opts) => {
    if (opts && opts.title === '打开工程 (.qfs)') return { canceled: false, filePaths: [qfsOut] };
    if (opts && opts.title === '选择导出目录') return { canceled: false, filePaths: [exportDir] };
    if (opts && opts.title === '选择照片文件夹（含子文件夹）') return { canceled: false, filePaths: [folderImport] };
    return { canceled: true };
};

require('../src/main/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
let total = 0;
const check = (ok, label, detail) => {
    total++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (detail) console.log(`       ${detail}`);
    if (!ok) fails.push(label);
};

(async () => {
    await app.whenReady();
    await sleep(2500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('FAIL 没有打开窗口'); app.exit(1); return; }

    console.log('主进程集成（sandbox / 草稿外置 / qflocal 白名单 / 导出令牌 / 流式 qfs）');
    console.log('─'.repeat(84));

    const prefs = win.webContents.getLastWebPreferences();
    check(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false,
        '窗口是 sandbox + contextIsolation + 无 nodeIntegration',
        `sandbox=${prefs.sandbox} contextIsolation=${prefs.contextIsolation} nodeIntegration=${prefs.nodeIntegration}`);

    const out = await win.webContents.executeJavaScript(`(async () => {
        const api = window.qingframe;
        const r = { api: !!api, sandboxProbe: typeof require, errors: [] };
        const load = (p) => new Promise((res) => {
            const img = new Image();
            img.onload = () => res(true);
            img.onerror = () => res(false);
            img.src = 'qflocal://img?p=' + encodeURIComponent(p);
        });
        try {
            // 1) 草稿附件：大 data: → qfasset: → 还原
            const big = ${JSON.stringify('data:image/png;base64,')} + 'A'.repeat(10000);
            const draft = { v: 1, template: { logoElements: [{ dataUrl: big }] } };
            const ext = await api.externalizeDraft(draft);
            r.draftMarker = !!(ext.ok && /^qfasset:/.test(ext.draft.template.logoElements[0].dataUrl));
            const hyd = await api.hydrateDraft(ext.draft);
            r.draftRoundtrip = !!(hyd.ok && hyd.draft.template.logoElements[0].dataUrl === big);
            r.sandboxProbe = typeof require;

            // 2) qflocal：登记过的能读，没登记的读不到
            const allowed = ${JSON.stringify(fmt(importedPhoto))};
            const denied = ${JSON.stringify(fmt(notRegisteredPhoto))};
            await api.readExif(allowed);          // read-exif 会登记该路径
            r.qflocalAllowed = await load(allowed);
            r.qflocalDenied = await load(denied);

            // 3) 文件夹导入：整批都要登记（曾漏登记 → 全部 403）
            const folder = await api.openImageFolder();
            r.folderItems = folder && folder.items ? folder.items.length : 0;
            r.folderLoad = r.folderItems ? await load(folder.items[0].path) : false;

            // 4) 没有令牌不能写盘
            const wr = await api.writeExportFiles({ location: { mode: 'dir', dir: ${JSON.stringify(fmt(exportDir))} },
                files: [{ data: 'AAAA', filename: 'x.png' }] });
            r.exportBlocked = !!(wr && wr.error && /未授权/.test(wr.error));

            // 5) 文件名里的 ../ 必须被夹在目录内
            const locDir = await api.pickExportLocation({ count: 2, hintName: 'x' });
            const wr2 = await api.writeExportFiles({ location: locDir,
                files: [{ data: ${JSON.stringify(PNG_DATA_URL)}, filename: '..\\\\..\\\\escape.png', subdir: '..\\\\..' }] });
            r.traversalWrite = !!(wr2 && wr2.ok === 1);

            // 6) 流式 .qfs：begin → add → finish → 回读
            const begin = await api.qfsBeginExport({ name: '集成测试', session: { currentIdx: 0 }, template: { templateName: 't' } });
            if (!begin.ok) throw new Error('begin: ' + begin.error);
            const add = await api.qfsAddImage({ id: begin.id, entry: { name: '..\\\\..\\\\evil', w: 1, h: 1, exif: {} },
                data: ${JSON.stringify(PNG_DATA_URL)} });
            if (!add.ok) throw new Error('add: ' + add.error);
            const fin = await api.qfsFinishExport(begin.id);
            if (!fin.ok) throw new Error('finish: ' + fin.error);
            const back = await api.openQfs();
            r.qfs = !!(back.ok && back.data.images && back.data.images.length === 1 && back.data.images[0].data);
            r.qfsName = back.ok && back.data.images[0] ? back.data.images[0].name : '';
        } catch (e) { r.errors.push(String(e && e.message || e)); }
        return r;
    })()`);

    check(out.api === true, 'preload 暴露 window.qingframe', null);
    check(out.sandboxProbe === 'undefined', 'sandbox 下渲染页拿不到 require', `typeof require = ${out.sandboxProbe}`);
    check(out.draftMarker === true, '草稿大图被外置为 qfasset:', null);
    check(out.draftRoundtrip === true, '草稿还原后与原 data: 完全一致', null);
    check(out.qflocalAllowed === true, 'qflocal 能读已登记的图片', null);
    check(out.qflocalDenied === false, 'qflocal 拒绝未登记的图片', null);
    check(out.folderItems === 1, '文件夹导入返回 1 张', `items=${out.folderItems}`);
    check(out.folderLoad === true, '文件夹导入的图已登记、能加载', null);
    check(out.exportBlocked === true, '没有导出令牌时拒绝写盘', null);

    const escaped = fs.existsSync(path.join(exportDir, '..', '..', 'escape.png'));
    const inDir = fs.existsSync(path.join(exportDir, 'escape.png'));
    check(out.traversalWrite === true && inDir && !escaped, '导出文件名的 ../ 被夹在目标目录内',
        `写入目录内=${inDir} 逃出目录=${escaped}`);

    check(out.qfs === true, '.qfs 流式导出后能回读（begin→add→finish）', `name=${JSON.stringify(out.qfsName)}`);
    check(fs.existsSync(qfsOut) && fs.statSync(qfsOut).size > 0, '.qfs 文件已落盘',
        fs.existsSync(qfsOut) ? `size=${fs.statSync(qfsOut).size}B` : 'missing');
    check(!out.errors.length, '渲染侧无异常', out.errors.join(' | '));

    console.log('─'.repeat(84));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Electron 仍占用 userData */ }
    app.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); app.exit(1); });
