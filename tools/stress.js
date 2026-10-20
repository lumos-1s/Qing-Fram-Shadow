// 压测壳:在真实 renderer(index.html) 里驱动 App.exportImage() 批量导出,采集耗时/内存/结果
// 用法: npx electron tools/stress.js
// 环境变量: STRESS_IN=输入照片目录 STRESS_OUT=输出目录(可写) STRESS_MEM_CAP_MB=熔断阈值(默认2400) STRESS_MAX_CONCURRENT=导入并发(默认6)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const IN_DIR = process.env.STRESS_IN || 'C:\\Users\\lumos\\Desktop\\新建文件夹\\1';
const OUT_DIR = process.env.STRESS_OUT || 'C:\\Users\\lumos\\Desktop\\新建文件夹 (3)';
const MEM_CAP = (parseInt(process.env.STRESS_MEM_CAP_MB, 10) || 2400) * 1024 * 1024;
const CONCURRENT = parseInt(process.env.STRESS_MAX_CONCURRENT, 10) || 6;
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!fs.existsSync(IN_DIR)) { console.error('输入目录不存在: ' + IN_DIR); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ── 存储/工具 ── */
const noopJson = { ok: true };
const nullJson = null;

/* ── IPC 桥(仅压测所需;其余返回安全默认) ── */
ipcMain.handle('stress:list', () => {
    const names = fs.readdirSync(IN_DIR).filter(f => /\.(jpe?g|png|webp|bmp)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    return names.map(n => { const s = fs.statSync(path.join(IN_DIR, n)); return { name: n, size: s.size }; });
});
ipcMain.handle('stress:load-photo', (_e, name) => {
    const buf = fs.readFileSync(path.join(IN_DIR, name));
    const mime = (name.match(/\.(jpe?g)$/i)) ? 'image/jpeg' : (name.match(/\.png$/i) ? 'image/png' : (name.match(/\.webp$/i) ? 'image/webp' : 'image/bmp'));
    return { name, base64: buf.toString('base64'), mime };
});

ipcMain.handle('write-export-files', (_e, { location, files }) => {
    if (!location || !files || !files.length) return { ok: 0, fail: files ? files.length : 0 };
    let ok = 0, fail = 0, error = null;
    for (const f of files) {
        try {
            const buf = f.bytes ? Buffer.from(f.bytes) : Buffer.from(f.data || '', 'base64');
            if (location.mode === 'file') fs.writeFileSync(location.filePath, buf);
            else fs.writeFileSync(path.join(location.dir, f.filename), buf);
            ok++;
        } catch (e) { fail++; error = String(e); }
    }
    return { ok, fail, error };
});
ipcMain.handle('pick-export-location', () => {
    if (outDirTarget) return { mode: 'dir', dir: outDirTarget };
    return { canceled: true };
});
ipcMain.handle('list-presets', () => {
    if (!fs.existsSync(PRESETS_DIR)) return [];
    return fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/i, ''));
});
ipcMain.handle('load-preset', (_e, name) => {
    const p = path.join(PRESETS_DIR, name + '.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
});
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('import-template', () => ({ canceled: true }));
ipcMain.handle('open-qfs', () => ({ canceled: true }));
ipcMain.handle('export-qfs', () => noopJson);
ipcMain.handle('save-template', () => noopJson);
ipcMain.handle('load-template', () => nullJson);
ipcMain.handle('delete-template', () => noopJson);
ipcMain.handle('rename-template', () => noopJson);
ipcMain.handle('get-user', () => nullJson);
ipcMain.handle('save-user', () => noopJson);
ipcMain.handle('logout-user', () => noopJson);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => noopJson);
ipcMain.handle('read-exif', () => nullJson);
ipcMain.handle('open-image', () => ({ canceled: true }));
ipcMain.handle('open-images', () => ({ canceled: true }));
ipcMain.handle('open-sticker-image', () => ({ canceled: true }));

/* ── renderer 驱动脚本 ── */
const RUNNER = `
async (cfg) => {
    const App = window.App;
    const res = { ok: false, imported: 0, okCount: 0, failCount: 0, ms: 0, msg: '', err: null, abort: false, stack: null, statusLog: [] };
    if (!window.__stressDbg) {
        window.__stressDbg = true;
        window.addEventListener('unhandledrejection', ev => console.error('UHR', (ev.reason && ev.reason.stack) || ev.reason));
        window.addEventListener('error', ev => console.error('WINERR', (ev.error && ev.error.stack) || ev.message));
    }
    try {
        window.__stressAbort = false;
        if (window.gc) window.gc();
        App.renderToken = (App.renderToken || 0) + 1;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        App.images = [];
        App.image = null;
        App.imageTemplates = new Map();
        App.selectedIdx = [];
        App.currentIdx = 0;
        await new Promise(r => requestAnimationFrame(() => r()));

        const list = await window.__stress.list();
        const files = list.slice(0, cfg.count);
        for (let i = 0; i < files.length; i += cfg.chunk) {
            if (window.__stressAbort) throw Object.assign(new Error('memory cap reached'), { abort: true });
            const group = files.slice(i, i + cfg.chunk);
            const farr = [];
            for (const g of group) {
                const r = await window.__stress.loadPhoto(g.name);
                const bin = atob(r.base64);
                const u8 = new Uint8Array(bin.length);
                for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
                farr.push(new File([u8], r.name, { type: r.mime || 'image/jpeg' }));
            }
            await App.addImageFiles(farr);
            if (window.__stressAbort) throw Object.assign(new Error('memory cap reached'), { abort: true });
        }
        res.imported = App.images.length;
        if (!App.images.length) throw new Error('no images imported');

        let srcTpl = (cfg.style && (App.presets || []).find(p => p.photoFrameStyle === cfg.style)) || null;
        if (!srcTpl) srcTpl = App.defaultTemplate();
        const tpl = JSON.parse(JSON.stringify(srcTpl));
        tpl.templateName = 'STRESS';
        if (cfg.style === 'CARD_3D') tpl.userSignature = '压测签名';
        App.images.forEach(im => { if (!im.customSettings) im.customSettings = JSON.parse(JSON.stringify(tpl)); });

        App.dom.selFormat.value = cfg.fmt;
        App.dom.selExportSize.value = String(cfg.sizeOpt || 0);
        if (App.dom.slExportQuality) App.dom.slExportQuality.value = String(cfg.quality || 92);

        App.selectedIdx = App.images.slice().map((_, i) => i);
        App.currentIdx = 0;
        const t0 = performance.now();
        let msg = null;
        try { msg = await App.exportImage(); }
        catch (e) { res.stack = (e && e.stack) || String(e); throw e; }
        res.ms = performance.now() - t0;
        res.msg = String(msg || '');
        res.statusMsg = String(App.statusMsg || '');
        const full = res.statusMsg + ';' + (window.__statusLog || []).slice(-8).join(';');
        const m = (full).match(/成功\\s*(\\d+)/); if (m) res.okCount = parseInt(m[1], 10);
        const f = (full).match(/失败\\s*(\\d+)/); if (f) res.failCount = parseInt(f[1], 10);
        res.ok = true;
    } catch (e) {
        res.err = String(e && e.message || e);
        res.abort = !!(e && e.abort) || !!window.__stressAbort;
        if (!res.abort) console.error('RUNNER ERROR:', res.err, e);
    } finally {
        window.__stressAbort = false;
    }
    return res;
}`;

/* ── 压测用例 ── */
const ONLY = process.env.STRESS_ONLY ? String(process.env.STRESS_ONLY) : null;
const PASSES0 = [
    { label: 'A · 12张 原图尺寸 PNG 重型卡片', sub: 'A_png_orig', count: 12, fmt: 'png', sizeOpt: 0, quality: 92, style: 'CARD_3D', chunk: 4 },
    { label: 'B · 30张 原图尺寸 JPEG 重型卡片', sub: 'B_jpeg_orig', count: 30, fmt: 'jpeg', sizeOpt: 0, quality: 85, style: 'CARD_3D', chunk: CONCURRENT },
    { label: 'C · 4张 8192px WebP 重型卡片', sub: 'C_webp_8192', count: 4, fmt: 'webp', sizeOpt: 8192, quality: 85, style: 'CARD_3D', chunk: 2 }
];
const PASSES = ONLY ? PASSES0.filter(p => p.sub.startsWith(ONLY)) : PASSES0;

/* ── 主流程 ── */
let win = null;
let memTimer = null;
let outDirTarget = null;
const state = { peak: 0, base: 0, series: [], aborted: false };

async function rendererMemMB(wc) {
    try {
        const pid = wc.getOSProcessId();
        const metas = require('electron').app.getAppMetrics();
        const mo = metas && metas.find(x => x.pid === pid && x.memory && typeof x.memory.workingSetSize === 'number');
        if (mo) return mo.memory.workingSetSize / 1024;
    } catch (e) { }
    try {
        const info = await require('electron').process.getProcessMemoryInfo(wc.getOSProcessId());
        if (info && Number.isFinite(info.resident)) return info.resident / 1024;
    } catch (e) { }
    return null;
}

async function startSampling(wc) {
    state.peak = 0; state.base = 0; state.series = []; state.aborted = false; state.prevLog = null;
    state.base = await rendererMemMB(wc) || 0;
    state.peak = state.base;
    memTimer = setInterval(async () => {
        try {
            const mb0 = await rendererMemMB(wc);
            if (mb0 == null) return;
            const mb = mb0;
            state.series.push(mb);
            if (!state.base) state.base = mb;
            if (mb > state.peak) state.peak = mb;
            if (state.prevLog == null || mb > state.prevLog + 100) {
                state.prevLog = mb;
                console.log('  [mem] renderer working set ' + mb.toFixed(0) + ' MB');
            }
            if (!state.aborted && mb > MEM_CAP) {
                state.aborted = true;
                console.log('  [mem] 超过熔断阈值,中止当前用例');
                // 必须用 executeJavaScript 在主世界置位:
                //   · contextBridge 暴露的函数,函数体跑在 preload 的**隔离世界**,
                //     写 window.__stressAbort 只写到隔离世界,主世界的 RUNNER 读不到(setAbort 因此形同虚设);
                //   · executeJavaScript 默认在主世界求值,这里写的两个标记才是 RUNNER 与导出循环真正读的:
                //     window.__stressAbort  → RUNNER 的导入循环(107/118)与收尾判定(149)
                //     App._exportAbort      → in-flight 的 exportImage 逐张循环(app-export.js:86)
                try { await wc.executeJavaScript('window.__stressAbort = true; if (window.App) window.App._exportAbort = true;'); } catch (e) { }
            }
        } catch (e) { }
    }, 300);
}
async function stopSampling() { if (memTimer) { clearInterval(memTimer); memTimer = null; } }

async function waitReady(wc) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
        try {
            const r = await wc.executeJavaScript(`(() => {
                const s = document.getElementById('splash');
                const app = window.App;
                return {
                    ok: !!(app && app.dom && app.dom.canvas && window.__render),
                    presets: (app && app.presets || []).length,
                    splash: s ? getComputedStyle(s).display : 'gone'
                };
            })()`);
            if (r.ok && r.presets > 0) return r;
        } catch (e) { }
        await sleep(250);
    }
    throw new Error('renderer 未就绪');
}

function dirStats(sub) {
    const d = path.join(OUT_DIR, sub);
    if (!fs.existsSync(d)) return { n: 0, bytes: 0 };
    const files = fs.readdirSync(d);
    let bytes = 0;
    files.forEach(f => { try { bytes += fs.statSync(path.join(d, f)).size; } catch (e) { } });
    return { n: files.length, bytes };
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

app.whenReady().then(async () => {
    const list = await (async () => {
        const names = fs.readdirSync(IN_DIR).filter(f => /\.(jpe?g|png|webp|bmp)$/i.test(f));
        let bytes = 0; names.forEach(n => { bytes += fs.statSync(path.join(IN_DIR, n)).size; });
        return { n: names.length, bytes };
    })();
    console.log(`输入: ${IN_DIR}`);
    console.log(`  照片 ${list.n} 张 / ${mb(list.bytes)} MB`);
    console.log(`输出: ${OUT_DIR}`);
    console.log(`内存熔断: ${MEM_CAP / 1024 / 1024} MB`);
    console.log('');

    win = new BrowserWindow({
        show: false, width: 1200, height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload-stress.js'),
            contextIsolation: true, nodeIntegration: false,
            backgroundThrottling: false, sandbox: true
        }
    });
    win.on('render-process-gone', (_e, d) => {
        console.error('!! renderer 进程退出: ' + JSON.stringify(d));
        state.peaked = true;
    });
    win.webContents.on('unresponsive', () => console.error('!! renderer 无响应'));
    win.webContents.on('console-message', (_e, level, msg) => {
        if (level >= 2) console.log('  [renderer] ' + String(msg).slice(0, 300));
    });

    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const ready = await waitReady(win.webContents);
    const initMem = await rendererMemMB(win.webContents);
    console.log(`renderer 就绪(presets=${ready.presets}) · 初始内存 ${initMem ? initMem.toFixed(0) + ' MB' : '(采样不可用)'}\n`);

    const report = { input: IN_DIR, output: OUT_DIR, memCapMB: MEM_CAP / 1024 / 1024, runs: [] };

    for (const p of PASSES) {
        const outSub = path.join(OUT_DIR, p.sub);
        fs.mkdirSync(outSub, { recursive: true });
        if (fs.existsSync(outSub)) { fs.readdirSync(outSub).forEach(f => { try { fs.unlinkSync(path.join(outSub, f)); } catch (e) { } }); }

        console.log(`▶ ${p.label}`);
        outDirTarget = outSub;
        await startSampling(win.webContents);
        const t0 = Date.now();
        let res;
        try {
            res = await win.webContents.executeJavaScript(`(${RUNNER})(${JSON.stringify({ ...p, out: outSub })})`);
        } catch (e) { res = { ok: false, err: 'executeJavaScript: ' + String(e), abort: false }; }
        const wall = Date.now() - t0;
        await stopSampling();
        try { win && win.webContents.executeJavaScript('window.gc && window.gc()'); } catch (e) { }
        const ds = dirStats(p.sub);
        const peak = state.peak;
        console.log(`  导入 ${res.imported} → 成功导出 ${res.okCount || 0} / 失败 ${res.failCount || 0}`);
        console.log(`  状态栏: ${res.statusMsg || '(空)'}`);
        if (res.err) console.log(`  异常: ${res.err}`);
        if (res.stack) console.log(`  堆栈: ${res.stack.split('\n').slice(0, 4).join('\n     ')}`);
        console.log(`  渲染耗时 ${(res.ms || -1).toFixed(0)} ms · 总耗时 ${wall.toFixed(0)} ms`);
        console.log(`  renderer 峰值内存 ${peak.toFixed(0)} MB${state.aborted ? ' (已熔断)' : ''}`);
        console.log(`  输出文件 ${ds.n} 个 / ${mb(ds.bytes)} MB (目录 ${p.sub})`);
        if (res.err) console.log(`  异常: ${res.err}`);
        console.log('');
        report.runs.push({
            label: p.label, sub: p.sub, count: p.count, fmt: p.fmt, sizeOpt: p.sizeOpt,
            imported: res.imported, okCount: res.okCount, failCount: res.failCount,
            renderMs: Math.round(res.ms || -1), wallMs: wall, peakMemMB: Math.round(peak),
            memCapped: !!state.aborted, outFiles: ds.n, outBytes: ds.bytes, err: res.err
        });
    }

    const outFile = path.join(OUT_DIR, 'stress-report.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
    console.log('════════ 压测报告 ════════');
    console.log(`已写入 ${outFile}\n`);
    report.runs.forEach(r => {
        console.log(`${r.label}`);
        console.log(`  导入${r.imported}/${r.count} · 导出成功${r.okCount} 失败${r.failCount} · 渲染${r.renderMs}ms(总${r.wallMs}ms) · 峰值${r.peakMemMB}MB${r.memCapped ? ' [熔断]' : ''}`);
        if (r.outFiles) console.log(`  输出 ${r.outFiles} 文件 / ${mb(r.outBytes)} MB`);
    });

    app.quit();
}).catch(err => { console.error(err); process.exit(1); });