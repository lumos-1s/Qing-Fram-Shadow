// 头像系列预设:签名放大后必须仍留在照片内(不能顶出照片下边沿/左右边沿)。
//
// 回归背景(头像·下中 = AV_OVERLAY_BC):
//   头像底部居中、签名在头像正下方,整块"贴照片下边沿"定位。
//   但代码把头像圆心写死成 `ay = pad + ih - avatarR - round(iw * 0.04)`,
//   而 `0.04 = 0.006(下留白) + 0.022(签名默认字号) + 0.012(间距)` —— 也就是说
//   这个式子只有在 `signSize = 1`(字号恰好 = 0.022*iw)时才成立。
//   一旦把签名放大(signSize > 1),字号变大、ay 却不动 → 签名顶出照片下边沿,
//   落到白色边框上(白字白底直接看不见,彩色字则是"跑到照片外面了")。
//
// 做法:渲染真实预设(读 shared/presets 的 JSON),按像素找
//   - 照片区域:纯色 #4a6f9c 的范围(照片是 1:1 贴上去的,不缩放)
//   - 签名区域:红色(测试里把 signColor 设成纯红,排除头像的洋红与阴影)
// 然后断言签名像素不超出照片区域。不依赖任何布局公式,改法换实现也照样有效。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
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

const preset = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', name + '.json'), 'utf8'));

// 渲染一张照片 + 指定预设,并把签名设成纯红、字号设成 signSize
const setup = (presetObj, signSize, text, avatarShow = 1) => `(async () => {
    const A = window.App;
    const c = document.createElement('canvas'); c.width = 800; c.height = 600;
    const g0 = c.getContext('2d'); g0.fillStyle = '#4a6f9c'; g0.fillRect(0, 0, 800, 600);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    A.image = { el: im, name: 'p.jpg', w: 800, h: 600, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
    A.template = ${JSON.stringify(presetObj)};
    A.template.userSignature = ${JSON.stringify(text)};
    A.template.signColor = '#ff0000';
    A.template.signSize = ${signSize};
    A.template.avatarShow = ${avatarShow};
    A.template.signBgBlur = 0;
    A.normalizeTemplate();
    // 头像图:洋红(与红色签名区分开,避免像素判定混在一起)
    const ac = document.createElement('canvas'); ac.width = 64; ac.height = 64;
    const ag = ac.getContext('2d'); ag.fillStyle = '#ff00ff'; ag.fillRect(0, 0, 64, 64);
    const av = new Image();
    await new Promise(r => { av.onload = r; av.onerror = r; av.src = ac.toDataURL('image/png'); });
    window.__qfsAvatarImg = av;
    A.invalidateStyleCaches();
    A.displayMax = 1800;
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 200));
    window.__render(A, false);   // 引擎首帧不稳定,取第二帧
    await new Promise(r => setTimeout(r, 200));
    const cv = A.dom.canvas;
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height;
    // 照片区(纯色 #4a6f9c,允许 JPEG 噪声容差)
    const isPhoto = (i) => Math.abs(d[i] - 0x4a) < 26 && Math.abs(d[i + 1] - 0x6f) < 26 && Math.abs(d[i + 2] - 0x9c) < 26;
    // 签名(纯红;洋红头像 b=255 或 g=255 都不满足)
    const isText = (i) => d[i] > 150 && d[i + 1] < 110 && d[i + 2] < 110;
    // 头像(测试画的纯洋红 #ff00ff;与红签名、照片蓝、白边都区分得开)
    const isAvatar = (i) => d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200;
    let pTop = H, pBottom = -1, pLeft = W, pRight = -1;
    let tTop = H, tBottom = -1, tLeft = W, tRight = -1, tCount = 0;
    let aTop = H, aBottom = -1, aLeft = W, aRight = -1, aCount = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (isPhoto(i)) {
                if (y < pTop) pTop = y; if (y > pBottom) pBottom = y;
                if (x < pLeft) pLeft = x; if (x > pRight) pRight = x;
            }
            if (isText(i)) {
                tCount++;
                if (y < tTop) tTop = y; if (y > tBottom) tBottom = y;
                if (x < tLeft) tLeft = x; if (x > tRight) tRight = x;
            }
            if (isAvatar(i)) {
                aCount++;
                if (y < aTop) aTop = y; if (y > aBottom) aBottom = y;
                if (x < aLeft) aLeft = x; if (x > aRight) aRight = x;
            }
        }
    }
    return { W, H, pTop, pBottom, pLeft, pRight, tTop, tBottom, tLeft, tRight, tCount,
        aTop, aBottom, aLeft, aRight, aCount, avatarShow: A.template.avatarShow,
        signSize: A.template.signSize, sigText: A.template.userSignature };
})()`;
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

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.__render)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    // 等启动期延迟任务(首帧预设选择 / 新手引导)跑完,避免它们中途改模板
    await new Promise(r => setTimeout(r, 2200));

    const fails = [];
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    console.log('头像预设:签名放大后是否仍在照片内(按像素测量)');
    console.log('─'.repeat(90));

    const SIG = 'Signature Test';
    const LONG = 'A Really Long Signature Text 2026 一条很长的签名';

    // 覆盖全部 6 个头像预设;每个都用大字号(signSize=2)+ 长签名把边界逼出来。
    // bound:'photo' = 签名是压在照片上的浮层,不能出照片;
    //       'canvas' = 头像纪念的签名在照片下方的底栏里(本来就在照片外),只要不出画布即可。
    const CASES = [
        ['头像·下中', 1, SIG, 'photo'], ['头像·下中', 1.5, SIG, 'photo'], ['头像·下中', 2, SIG, 'photo'], ['头像·下中', 2, LONG, 'photo'],
        ['头像·下排', 2, SIG, 'photo'], ['头像·下排', 2, LONG, 'photo'],
        ['头像·右上', 2, SIG, 'photo'], ['头像·右上', 2, LONG, 'photo'],
        ['头像·右下', 2, SIG, 'photo'], ['头像·右下', 2, LONG, 'photo'],
        ['头像·左下', 2, SIG, 'photo'], ['头像·左下', 2, LONG, 'photo'],
        ['头像纪念', 2, SIG, 'canvas'], ['头像纪念', 2, LONG, 'canvas'],
    ];
    let n = 0;
    for (const [pname, ss, text, bound] of CASES) {
        n++;
        const r = await win.webContents.executeJavaScript(setup(preset(pname), ss, text));
        const B = bound === 'canvas'
            ? { top: 0, bottom: r.H - 1, left: 0, right: r.W - 1 }
            : { top: r.pTop, bottom: r.pBottom, left: r.pLeft, right: r.pRight };
        const inside = r.tCount > 0 && r.tTop >= B.top && r.tBottom <= B.bottom && r.tLeft >= B.left && r.tRight <= B.right;
        const over = [];
        if (r.tBottom > B.bottom) over.push(`下边超出 ${r.tBottom - B.bottom}px`);
        if (r.tTop < B.top) over.push(`上边超出 ${B.top - r.tTop}px`);
        if (r.tRight > B.right) over.push(`右边超出 ${r.tRight - B.right}px`);
        if (r.tLeft < B.left) over.push(`左边超出 ${B.left - r.tLeft}px`);
        if (!r.tCount) over.push('签名像素为 0(未渲染?)');
        line(inside, `${String(n).padStart(2, '0')} ${pname} signSize=${ss}${text === LONG ? ' 长签名' : ''}:签名落在${bound === 'canvas' ? '画布' : '照片'}内`,
            `签名 ${r.tTop}..${r.tBottom} × ${r.tLeft}..${r.tRight}(${r.tCount}px)  ` +
            (bound === 'canvas' ? `画布 ${r.W}×${r.H}` : `照片 ${r.pTop}..${r.pBottom} × ${r.pLeft}..${r.pRight}`) +
            (over.length ? '  ← ' + over.join('、') : ''),
            '签名 bbox ⊆ ' + (bound === 'canvas' ? '画布' : '照片') + ' bbox');
    }

    // ── 「个性」预设的「显示头像」开关(avatarShow) ──
    // 背景:头像系列原先无条件画头像,面板里的「显示头像」勾选框(写 template.avatarShow)
    // 对这些风格完全无效 —— 用户勾掉也照画。这里按像素量:开=有洋红头像,关=一个都没有;
    // 并顺带确认关掉头像后签名顶回左边、仍留在照片内(布局要跟着让位,不能留空档/顶出边界)。
    console.log('');
    console.log('「个性」预设的「显示头像」开关');
    console.log('─'.repeat(90));
    const AV_PRESETS = ['头像·左下', '头像·右上', '头像·右下', '头像·下中', '头像·下排', '头像纪念', '签名+参数'];
    // 头像纪念 / 签名+参数的签名在照片下方的底栏里(本来就在照片外),边界按画布算。
    const AV_BAR = ['头像纪念', '签名+参数'];
    for (const pname of AV_PRESETS) {
        const on = await win.webContents.executeJavaScript(setup(preset(pname), 1, SIG, 1));
        const off = await win.webContents.executeJavaScript(setup(preset(pname), 1, SIG, 0));
        n++;
        line(on.aCount > 0 && off.aCount === 0,
            `${String(n).padStart(2, '0')} ${pname}:avatarShow 开关真的能开关头像`,
            `avatarShow=1 洋红 ${on.aCount}px / avatarShow=0 洋红 ${off.aCount}px`,
            '开 > 0、关 = 0');
        const isBar = AV_BAR.indexOf(pname) >= 0;
        const B = isBar
            ? { top: 0, bottom: off.H - 1, left: 0, right: off.W - 1 }
            : { top: off.pTop, bottom: off.pBottom, left: off.pLeft, right: off.pRight };
        const inside = off.tCount > 0 && off.tTop >= B.top && off.tBottom <= B.bottom && off.tLeft >= B.left && off.tRight <= B.right;
        n++;
        line(inside, `${String(n).padStart(2, '0')} ${pname}:关掉头像后签名仍落在${isBar ? '画布' : '照片'}内`,
            `签名 ${off.tTop}..${off.tBottom} × ${off.tLeft}..${off.tRight}(${off.tCount}px)`,
            '签名 bbox ⊆ ' + (isBar ? '画布' : '照片') + ' bbox');
    }
    // 预设数据必须自己声明 avatarShow:1,否则会「沿用上一份模板」——
    // 刚点过票根(avatarShow:0)再点头像预设,就会得到一个没有头像的头像预设。
    for (const pname of AV_PRESETS) {
        const j = preset(pname);
        n++;
        line(j.avatarShow === 1, `${String(n).padStart(2, '0')} ${pname} 预设自带 avatarShow:1`,
            `avatarShow=${JSON.stringify(j.avatarShow)}`, '= 1');
    }

    console.log('─'.repeat(90));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${n} 项通过`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
