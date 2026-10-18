// 导出保留 EXIF(«拍摄信息»)的链路测试:真 UI + 真渲染 + 真 exif-write 移植,
// 只有「选保存位置」「写盘」两步被替换成桩 —— 桩里调用的与主进程 handler 同一个
// applyExifToExportItem(),保证测的就是真实字节路径。
//
// 覆盖 4 种组合(渲染层开关 → 条目字段 → 成品字节):
//   ① JPG + 保留 EXIF + 不带 GPS → originalPath 携带;成品 Orientation=1、机型在、GPS 无
//   ② JPG + 保留 EXIF + 带 GPS   → keepGps=true;成品 GPS 在
//   ③ JPG + 不勾保留             → 条目不带 originalPath;成品无 APP1(双保险)
//   ④ PNG + 勾选                 → 格式闸门:条目不带(暂无 eXIf 容器写入)
//
// 用法:npm run test:exif
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

// 主进程 stdout/stderr 在管道调用方关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const exifUtil = require(path.join(ROOT, 'src', 'renderer', 'js', 'exif.js'));
const exifWrite = require(path.join(ROOT, 'src', 'main', 'exif-write.js'));

const fails = [];
function check(cond, label) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails.push(label);
    console.log('  FAIL ' + label);
}
function finish() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.log(fails.length ? '✗ ' + fails.length + ' 项不通过:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
}

// ── 合成"原图":带 EXIF(Make='QFTEST', Orientation=6, GPS)的最小 JPEG ──
// 结构同 tools/test-exif-write.js:TIFF 头 + IFD0[Make, Orientation, GPSInfo] + GPS IFD(2 条)
function buildOrigJpeg() {
    const t = Buffer.alloc(86);
    t[0] = 0x49; t[1] = 0x49; t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
    t.writeUInt16LE(3, 8);                                                                   // IFD0 3 条
    t.writeUInt16LE(0x010F, 10); t.writeUInt16LE(2, 12); t.writeUInt32LE(6, 14); t.writeUInt32LE(50, 18);
    t.writeUInt16LE(0x0112, 22); t.writeUInt16LE(3, 24); t.writeUInt32LE(1, 26); t.writeUInt16LE(6, 30);
    t.writeUInt16LE(0x8825, 34); t.writeUInt16LE(4, 36); t.writeUInt32LE(1, 38); t.writeUInt32LE(56, 42);
    t.writeUInt32LE(0, 46);                                                                  // 无 IFD1
    t.write('QFTEST\0', 50, 'latin1');
    t.writeUInt16LE(2, 56);                                                                  // GPS IFD 2 条
    t.writeUInt16LE(0x0001, 58); t.writeUInt16LE(2, 60); t.writeUInt32LE(2, 62); t.write('N\0', 66, 'latin1');
    t.writeUInt16LE(0x0003, 70); t.writeUInt16LE(2, 72); t.writeUInt32LE(2, 74); t.write('E\0', 78, 'latin1');
    t.writeUInt32LE(0, 82);
    const h = Buffer.alloc(4);
    h[0] = 0xFF; h[1] = 0xE1; h.writeUInt16BE(2 + 6 + t.length, 2);
    return Buffer.concat([
        Buffer.from([0xFF, 0xD8]),
        h, Buffer.from('Exif\0\0', 'latin1'), t,
        Buffer.from([0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9])
    ]);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-exif-e2e-'));
const ORIG = path.join(tmpDir, 'orig.jpg');
fs.writeFileSync(ORIG, buildOrigJpeg());

// ── IPC 桩(与 test-grid-crop-smoke.js 同一套基础 handler,只替换导出两步) ──
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, n + '.json'), 'utf8')));
ipcMain.handle('load-all-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')) })));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}
ipcMain.handle('pick-export-location', () => ({ mode: 'file', canceled: false, filePath: path.join(tmpDir, 'out' + Date.now() + '.jpg') }));
const runs = [];
ipcMain.handle('write-export-files', async (_e, payload) => {
    const files = (payload && payload.files) || [];
    const rec = { files: [] };
    for (const f of files) {
        rec.files.push({
            originalPath: f.originalPath || null,
            keepGps: f.keepGps === true,
            ext: f.ext,
            // 与 src/main/index.js 的 write-export-files 同一函数:真移植、真字节
            buf: await exifWrite.applyExifToExportItem(f)
        });
    }
    runs.push(rec);
    console.log('[mock] writeExportFiles 收到 ' + files.length + ' 张: originalPath=' + (rec.files[0] && rec.files[0].originalPath ? '有' : '无') + ', keepGps=' + (rec.files[0] && rec.files[0].keepGps));
    return { ok: files.length, fail: 0 };
});

// ── 渲染层脚本:注入测试图 → 按 4 种组合各导出一次 ──
const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await new Promise(r => setTimeout(r, 300));

    const c = document.createElement('canvas'); c.width = 800; c.height = 1000;
    const g = c.getContext('2d');
    g.fillStyle = '#3a6ea5'; g.fillRect(0, 0, 800, 1000);
    g.fillStyle = '#fff'; g.font = 'bold 80px Arial'; g.fillText('E', 360, 520);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
    App.images = [{ el: img, name: '测试照片.png', path: ${JSON.stringify(ORIG)}, w: 800, h: 1000, exif: { brand: 'QFTEST' }, customSettings: null }];
    App.currentIdx = 0; App.image = App.images[0]; App.selectedIdx = [0];
    App.template = App.defaultTemplate ? App.defaultTemplate() : { style: 'NONE', exif: { brand: 'QFTEST' } };
    App.template = JSON.parse(JSON.stringify(App.template));

    const d = App.dom;
    if (!d.chkKeepExif || !d.chkKeepGps) return 'FAIL 缺少 chkKeepExif/chkKeepGps(接线缺失)';
    if (!App._exportExifFor) return 'FAIL 缺少 _exportExifFor';

    // ① JPG + 保留 + 不带 GPS
    d.selFormat.value = 'jpeg';
    d.chkKeepExif.checked = true; d.chkKeepGps.checked = false;
    await App.exportImage();
    // ② JPG + 保留 + 带 GPS
    d.chkKeepGps.checked = true;
    await App.exportImage();
    // ③ JPG + 不保留
    d.chkKeepExif.checked = false;
    await App.exportImage();
    // ④ PNG + 勾选(格式闸门)
    d.selFormat.value = 'png';
    d.chkKeepExif.checked = true;
    await App.exportImage();
    d.selFormat.value = 'jpeg';
    console.log('[exif-e2e] 4 次导出完成');
    return 'PASS-RENDER';
}
`;

function parseOut(buf) {
    return exifUtil.parseExif(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
function countApp1(buf) {
    let n = 0, off = 2;
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const m = buf[off + 1];
        if (m === 0xD8 || m === 0xD9 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { off += 2; continue; }
        if (m === 0xDA) break;
        const len = buf.readUInt16BE(off + 2);
        if (m === 0xE1 && len >= 10 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') n++;
        off += 2 + len;
    }
    return n;
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try {
            const u = new URL(request.url);
            const fp = u.searchParams.get('p');
            if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 });
            return net.fetch(pathToFileURL(fp).href);
        } catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => { console.log('[page:' + level + ']', msg); });
    win.webContents.on('did-fail-load', (_e, code, desc) => { console.log('[did-fail-load]', code, desc); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    const r = await win.webContents.executeJavaScript('(' + CHECK + ')()').catch(e => 'EXEC-ERR: ' + (e && e.message));
    console.log('EXEC-RESULT:', typeof r === 'string' ? r : (r || '(undefined)'));
    if (r !== 'PASS-RENDER') fails.push('渲染层未给出结论:' + String(r));

    check(runs.length === 4, '写盘调用次数 = 4(实测 ' + runs.length + ')');
    const A = runs[0] && runs[0].files[0];
    const B = runs[1] && runs[1].files[0];
    const C = runs[2] && runs[2].files[0];
    const D = runs[3] && runs[3].files[0];

    if (A) {
        check(A.originalPath === ORIG, '① originalPath 携带原图路径');
        check(A.keepGps === false, '① keepGps=false');
        check(A.ext === 'jpg', '① ext=jpg');
        const raw = parseOut(A.buf);
        check(raw[0x0112] === 1, '① 成品 Orientation 强制为 1(原图 6)');
        check(raw[0x010F] === 'QFTEST', '① 成品保留机型 QFTEST');
        check(raw[0x8825] === undefined && raw[1] === undefined, '① 成品无 GPS');
        check(countApp1(A.buf) === 1, '① 成品恰好一段 APP1');
    } else fails.push('① 没有写盘记录');

    if (B) {
        check(B.keepGps === true, '② keepGps=true');
        const raw = parseOut(B.buf);
        check(raw[0x0112] === 1, '② 成品 Orientation 仍为 1');
        check(raw[1] === 'N' && raw[0x8825] !== undefined, '② 成品保留 GPS');
    } else fails.push('② 没有写盘记录');

    if (C) {
        check(C.originalPath === null, '③ 不勾选:条目不带 originalPath');
        check(countApp1(C.buf) === 0, '③ 成品无 APP1(未注入)');
        check(C.buf[0] === 0xFF && C.buf[1] === 0xD8, '③ 成品仍是 JPEG');
    } else fails.push('③ 没有写盘记录');

    if (D) {
        check(D.originalPath === null, '④ PNG:条目不带 originalPath(格式闸门)');
        check(D.ext === 'png', '④ ext=png');
        check(D.buf[0] === 0x89 && D.buf[1] === 0x50 && D.buf[2] === 0x4E && D.buf[3] === 0x47, '④ 成品是 PNG');
        check(!D.buf.includes(Buffer.from('eXIf', 'latin1')), '④ 成品无 eXIf 块');
    } else fails.push('④ 没有写盘记录');

    finish();
});
