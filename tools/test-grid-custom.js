// 自定义切图比例:3 列 × 4 行(非方阵)的预览/导出/批量/记忆回归
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

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

const fails = [];
function finish(extra) {
    if (extra) fails.push(extra);
    console.log(fails.length ? '✗ ' + fails.length + ' 项不通过:\n  - ' + fails.join('\n  - ') : '✓ 全部通过');
    app.exit(fails.length ? 1 : 0);
}

let calls = [];
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, dir: 'TEST-DIR' }));
ipcMain.handle('write-export-files', (_e, payload) => {
    const files = (payload && payload.files) || [];
    calls.push(files.map(f => f.filename));
    for (const f of files) {
        if (!f.filename) fails.push('write-export-files 收到缺 filename 的条目');
        if (!f.data) fails.push('write-export-files 收到空 data: ' + f.filename);
    }
    return { ok: files.length, fail: 0 };
});

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await new Promise(r => setTimeout(r, 300));

    function mkImg(w, h, color, ch) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = color; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff'; g.font = 'bold 90px Arial'; g.fillText(ch, 40, 100);
        const img = new Image();
        return new Promise(r => { img.onload = () => r(img); img.src = c.toDataURL('image/png'); });
    }
    const a = await mkImg(900, 1200, '#c06030', 'A');
    const b = await mkImg(900, 1200, '#3060c0', 'B');
    App.images = [
        { el: a, name: '图A.png', w: 900, h: 1200, exif: {}, customSettings: null },
        { el: b, name: '图B.png', w: 900, h: 1200, exif: {}, customSettings: null }
    ];
    App.currentIdx = 0; App.image = App.images[0];
    App.selectedIdx = [];
    App.template = App.defaultTemplate ? App.defaultTemplate() : { style: 'NONE', exif: { brand: 'TEST' } };
    document.getElementById('cbGridSubdir').checked = false;
    document.getElementById('selGridRender').value = '3000';
    document.getElementById('slGridPad').value = '0';

    // 切到自定义 3 列 × 4 行
    const size = document.getElementById('selGridSize');
    size.value = 'custom';
    size.dispatchEvent(new Event('change'));
    document.getElementById('inpGridCols').value = '3';
    document.getElementById('inpGridRows').value = '4';
    App.normalizeGridInputs();
    const spec = App.gridSpec();
    if (spec.cols !== 3 || spec.rows !== 4) return 'FAIL 规格=' + JSON.stringify(spec) + '(期望 3 列 × 4 行)';
    if (document.getElementById('rowGridRatio').hidden) return 'FAIL 自定义控件未显示';
    const hint = document.getElementById('gridRatioHint').textContent;
    if (!/3 列 × 4 行/.test(hint) || !/12 块/.test(hint)) return 'FAIL 比例提示=' + hint;
    console.log('PASS① 自定义 3 列 × 4 行：控件与提示正确 ✓');
    console.log('STEP:1');

    // 预览 12 格，且 900×1200 的 3×4 切块应接近正方形
    await App.renderGridPreview();
    await new Promise(r => setTimeout(r, 400));
    const grid = document.getElementById('gridPreviewGrid');
    const cells = grid.querySelectorAll('.grid-preview-cell');
    if (cells.length !== 12) return 'FAIL 预览格数=' + cells.length + '(期望12)';
    if (!/repeat\\(3,/.test(grid.style.gridTemplateColumns)) return 'FAIL 预览列数=' + grid.style.gridTemplateColumns;
    const cv = cells[0]._cv;
    if (!cv || Math.abs(cv.width - cv.height) > 1) return 'FAIL 首块尺寸=' + (cv ? cv.width + '×' + cv.height : 'null') + '(900×1200 的 3×4 切块应约 1:1)';
    if (!/3 列 × 4 行/.test(document.getElementById('gridPreviewHint').textContent)) return 'FAIL 预览提示未写清行列';
    console.log('PASS② 预览：12 格、3 列布局、首块 ' + cv.width + '×' + cv.height + ' ✓');
    console.log('STEP:2');

    // 单张导出：12 张，非方阵命名用「切图」
    await App.exportGridCrop();
    await new Promise(r => setTimeout(r, 500));
    console.log('STEP:3');

    // 批量：2 张 × 12 = 24 张
    App.selectedIdx = [0, 1];
    await App.exportGridCrop();
    await new Promise(r => setTimeout(r, 700));
    console.log('STEP:4');

    // 记忆：custom + 列/行应一起回读
    App.saveGridPrefs();
    size.value = '3';
    document.getElementById('inpGridCols').value = '3';
    document.getElementById('inpGridRows').value = '3';
    App.loadGridPrefs();
    if (size.value !== 'custom') return 'FAIL 记忆未回读 custom: ' + size.value;
    if (document.getElementById('inpGridCols').value !== '3' || document.getElementById('inpGridRows').value !== '4') return 'FAIL 记忆列/行=' + document.getElementById('inpGridCols').value + '/' + document.getElementById('inpGridRows').value;
    if (document.getElementById('rowGridRatio').hidden) return 'FAIL 回读后自定义控件未显示';
    console.log('PASS⑤ 设置记忆：custom + 3 列 × 4 行 回读正确 ✓');

    // 清理同源 localStorage，别影响兄弟测试
    size.value = '3';
    document.getElementById('inpGridCols').value = '3';
    document.getElementById('inpGridRows').value = '3';
    App.saveGridPrefs();
    return 'PASS-RENDER';
}
`;

let checked = 0;
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
    win.webContents.on('console-message', (_e, level, msg) => {
        console.log('[page][' + level + ']', msg);
        if (level !== 1) return;
        if (msg === 'STEP:3') {
            checked++;
            if (!calls[0] || calls[0].length !== 12) { fails.push('单张导出张数=' + (calls[0] ? calls[0].length : 0) + '(期望12)'); return; }
            if (calls[0][0] !== '图A_切图_1.jpg' || calls[0][11] !== '图A_切图_12.jpg') { fails.push('单张命名错误: ' + calls[0][0] + '..' + calls[0][11]); return; }
            console.log('PASS③ 单张导出：12 张，命名 图A_切图_1..12 ✓');
        } else if (msg === 'STEP:4') {
            checked++;
            const batch = calls.slice(1).flat();
            if (batch.length !== 24) { fails.push('批量张数=' + batch.length + '(期望24)'); return; }
            const aN = batch.filter(n => n.indexOf('图A_切图_') === 0).length;
            const bN = batch.filter(n => n.indexOf('图B_切图_') === 0).length;
            if (aN !== 12 || bN !== 12) { fails.push('批量 图A=' + aN + ' 图B=' + bN + '(期望各12)'); return; }
            console.log('PASS④ 批量切图：2 张 × 12 = 24 张，命名正确 ✓');
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    const r = await win.webContents.executeJavaScript('(' + CHECK + ')()').catch(e => 'EXEC-ERR: ' + (e && e.message));
    if (typeof r === 'string' && r.startsWith('FAIL')) fails.push(r);
    else if (r !== 'PASS-RENDER') fails.push('渲染层未给出结论:' + String(r));
    console.log('EXEC-RESULT:', typeof r === 'string' ? r : (r || '(undefined)'));

    await new Promise(res => {
        const iv = setInterval(() => { if (checked >= 2) { clearInterval(iv); res(); } }, 100);
        setTimeout(() => { clearInterval(iv); res(); }, 12000);
    });
    if (checked < 2) fails.push('主进程侧断言未跑完(checked=' + checked + '/2)');
    finish();
});
