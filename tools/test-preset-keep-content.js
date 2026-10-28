// 验证「应用预设保留用户内容」的行为。
//
// 回归背景:applyPreset 旧实现是 this.template = 深拷贝(p),把用户已加的
// logo/贴纸/文字一起丢掉。现象很隐蔽 —— 画布上残留上一帧的渲染,看起来 logo 还在,
// 但 template.logoElements 已空,于是点不中、拖不动、不能放缩。
//
// 覆盖:
//  ① 预设不携带 logo(78 个预设的 logoElements 全为空数组)→ 应用后用户的 logo 必须还在
//  ② 预设自带锚点排版文字(align top/bottom/center)→ 应跟随预设替换
//  ③ 用户加的自由文字(align 'free')→ 应被保留
//  ④ 贴纸 → 应被保留(预设从不带贴纸)
//  ⑤ 保留的 logo 仍可被命中检测点到(拖拽/放缩的前提)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

const SCENARIOS = `
(async () => {
    const A = window.App;
    // 预设库必须先加载完,否则 A.presets 为空、抽不到样本
    if (typeof A.loadPresets === 'function') { try { await A.loadPresets(); } catch (e) {} }
    const mkImg = async (w, h, col) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, w, h);
        const im = new Image();
        await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
        return { el: im, name: 'p.jpg', w, h, exif: {} };
    };
    const mkLogoUrl = () => {
        const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
        const lg = lc.getContext('2d'); lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
        lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
        return lc.toDataURL('image/png');
    };
    const out = [];
    const presets = A.presets || [];

    // 覆盖四种预设:带排版文字的、带签名的、两者都有的、纯边框的
    const withText = presets.filter(p => p.decorConfig && (p.decorConfig.textLines || []).length).slice(0, 1);
    const signed = presets.filter(p => p.userSignature).slice(0, 1);
    const signedText = presets.filter(p => p.userSignature && p.decorConfig && (p.decorConfig.textLines || []).length).slice(0, 1);
    const taken = new Set([...withText, ...signed, ...signedText]);
    const plain = presets.filter(p => !taken.has(p) && !p.userSignature).slice(0, 1);
    const targets = [...new Set([...withText, ...signed, ...signedText, ...plain])];

    for (const preset of targets) {
        const im = await mkImg(1200, 900, '#5a86bb');
        A.image = im; A.images = [im]; A.imageTemplates = new Map();
        A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
        A.template = A.defaultTemplate();
        A.normalizeTemplate(); A.invalidateStyleCaches();
        A.scheduleRender(true); await new Promise(r => setTimeout(r, 800));

        const logoUrl = mkLogoUrl();
        await A.addLogoElement({ name: 'MYLOGO', dataUrl: logoUrl });
        // 用户自由文字(align free)与一条预设式锚点文字,用来验证合并规则
        A.template.decorConfig = A.template.decorConfig || {};
        A.template.decorConfig.textLines = [
            { text: '用户自由文字', align: 'free', x: 120, y: 140, fontSize: 20, colorHex: '#ff0000' },
            { text: '用户锚点文字', align: 'bottom', fontSize: 14, colorHex: '#00ff00' },
        ];
        A.template.decorConfig.stickers = [{ src: 'sticker-test', x: 300, y: 300, scale: 1, w: 200, h: 200, opacity: 100, z: 1 }];
        // 用户自己的签名文字(绑在输入框上、登录后按昵称自动填充,所以算用户内容)
        A.template.userSignature = '我的签名';
        const before = {
            logos: (A.template.logoElements || []).length,
            free: A.template.decorConfig.textLines.filter(t => t.align === 'free').length,
            stk: (A.template.decorConfig.stickers || []).length,
        };

        A.applyPreset(preset);
        await new Promise(r => setTimeout(r, 900));

        const t = A.template || {};
        const dc = t.decorConfig || {};
        const txt = dc.textLines || [];
        const after = {
            logos: (t.logoElements || []).length,
            free: txt.filter(x => x.align === 'free').length,
            stk: (dc.stickers || []).length,
            presetAnchor: txt.filter(x => x.align !== 'free').length,
        };
        const presetAnchorN = ((preset.decorConfig || {}).textLines || []).filter(x => x.align !== 'free').length;
        // 签名规则(已与用户确认):预设自带签名就用预设的,预设没带才保留用户输入的
        const presetSigN = preset.userSignature ? 1 : 0;

        // 保留的 logo 是否还能被命中检测点到。
        // 全链路偶发:整机/前序用例负载高时,applyPreset 后的渲染协商帧可能还没落定,
        // 单次采样会测到 null(实测 ~10 次链路跑出 2 次)。测不到 logo 时排干渲染 + 两帧后
        // 重测(至多 3 轮);重试仍失败才判 FAIL,并把现场几何打进 got 便于追因。
        let hit = 'n/a';
        const el0 = (t.logoElements || [])[0];
        if (el0) {
            const measure = () => {
                const cv = A.dom.canvas, rect = cv.getBoundingClientRect();
                // 按压点与命中检测(hitTestLogos)同口径:用「基准画布」取 logo 中心。
                // 引擎通道 DPR=1 时画布是基准的 2 倍,若按 cv.width 算,点击点落在命中区外一倍处 → 假 miss。
                const base = A.logoBaseForOverlay();
                const pos = A.logoPos(el0, base.w, base.h, el0.size);
                const sx = rect.left + (pos.cx / cv.width) * rect.width;
                const sy = rect.top + (pos.cy / cv.height) * rect.height;
                const pt = A.screenToCanvas({ clientX: sx, clientY: sy, screenX: sx, screenY: sy });
                const picked = A.pickElement(pt);
                return {
                    hit: picked ? picked.kind : 'null',
                    diag: ' rect=' + rect.width.toFixed(1) + 'x' + rect.height.toFixed(1) +
                        ' cv=' + cv.width + 'x' + cv.height + ' base=' + base.w + 'x' + base.h +
                        ' log=' + cv._logW + 'x' + cv._logH + ' dpr=' + window.devicePixelRatio +
                        ' pos=' + pos.cx + ',' + pos.cy + ' pt=' + pt.x + ',' + pt.y +
                        ' el=' + JSON.stringify({ rel: el0.rel, rx: el0.rx, ry: el0.ry, x: el0.x, y: el0.y, size: el0.size }),
                };
            };
            let m = measure();
            for (let k = 0; k < 3 && m.hit !== 'logo'; k++) {
                try { await A.flushRender(); } catch (e) {}
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                m = measure();
            }
            hit = m.hit;
            if (hit !== 'logo') hit += ' [稳定等待后仍 miss:' + m.diag + ' ]';
        }

        out.push({
            name: preset.templateName || '(无名)',
            isAnchorPreset: presetAnchorN > 0,
            presetAnchorN, presetStkN: ((preset.decorConfig || {}).stickers || []).length,
            presetLogoN: (preset.logoElements || []).length,
            presetSigN, presetSig: preset.userSignature || '',
            sig: t.userSignature || '',
            before, after, hit,
        });
    }
    return { out, presetCount: presets.length };
})()
`;

// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。此前本文件设了 process.exitCode,断言失败仍返回 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 180)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    // Electron 45 起隐藏窗口不做布局/绘制：几何与像素断言会拿到 0×0 / 空白。
    // 必须让窗口真正参与合成，否则整片用例静默失灵（曾把 test:drag 全判失败）。
    win.showInactive();

    for (let i = 0; i < 120; i++) {
        const ok = await win.webContents.executeJavaScript('!!(window.App && window.App.presets && window.App.dom.canvas)');
        if (ok) break;
        await new Promise(r => setTimeout(r, 250));
    }
    // 预设是异步加载的,轮询等它真正有内容
    for (let i = 0; i < 80; i++) {
        const n = await win.webContents.executeJavaScript('(window.App.presets || []).length');
        if (n > 0) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const r = await win.webContents.executeJavaScript(SCENARIOS);
    let fail = 0;
    console.log('应用预设保留用户内容  (预设库 ' + r.presetCount + ' 个,抽测 ' + r.out.length + ' 个)');
    console.log('─'.repeat(96));
    for (const c of r.out) {
        const checks = [];
        checks.push(['logo 保留', c.after.logos === c.before.logos, c.before.logos + ' → ' + c.after.logos]);
        checks.push(['自由文字保留', c.after.free === c.before.free, c.before.free + ' → ' + c.after.free]);
        checks.push(['贴纸保留', c.after.stk === c.before.stk, c.before.stk + ' → ' + c.after.stk]);
        checks.push(['预设排版文字跟随', c.after.presetAnchor === c.presetAnchorN, c.presetAnchorN + ' → ' + c.after.presetAnchor]);
        checks.push(['logo 可命中', c.hit === 'logo', c.hit]);
        // 预设自带签名 → 用预设的;预设没带 → 保留用户的
        const sigOK = c.presetSigN ? (c.sig === c.presetSig) : (c.sig === '我的签名');
        checks.push(['签名按约定处理', sigOK,
            (c.presetSigN ? '预设带签名→' + JSON.stringify(c.sig) : '预设无签名→保留') +
            (c.presetSigN ? '' : JSON.stringify(c.sig))]);

        const bad = checks.filter(x => !x[1]);
        if (bad.length) fail += bad.length;
        console.log(`  ${bad.length ? 'FAIL' : 'OK  '} ${c.name}` + (c.isAnchorPreset ? '  [含排版文字预设]' : '') +
            (c.presetSigN ? '  [自带签名预设]' : '') +
            (c.presetLogoN ? `  [预设自带 ${c.presetLogoN} 个 logo]` : ''));
        for (const [label, ok, got] of checks) {
            console.log(`       ${ok ? '✓' : '✗'} ${label.padEnd(16)} ${got}`);
        }
    }
    console.log('─'.repeat(96));
    console.log(fail ? `✖ ${fail} 项未通过` : `✓ 全部通过 (${r.out.length} 个预设)`);
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
