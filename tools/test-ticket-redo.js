// 票根家族「真票券」重做(TICKET_VINTAGE / TICKET_SCRAP / TICKET_CONCERT)的回归测试,
// 以及撕边电影票(MOVIE_TICKET)的重做回归(同一套判据,另一套几何:右侧副券 + 竖向锯齿撕线)。
//
// 背景:重做前实测出的三个根因 bug,本测试逐条防回归:
//   ① 齿孔没挖穿 —— 旧 styleTicket 的 destination-out 沿用上一步暗角径向渐变的 fillStyle
//      (只写到 0.16 透明度),实测孔心 alpha=235 而不是 0,整排齿孔等于没画。
//   ② vintage/scrap 的孔打在照片内侧(x = side+holeR,照片从 x=side 开始),等于在照片上
//      点同色点,看不见;concert 只有副券列打穿 → 导出 alpha=0 的透明洞,而它垫在票面下的
//      模糊照片被不透明纸面盖住,挖穿也露不出来。
//   ③ 纸纹 ticketPaperPattern() 的 tile 是不透明白底,source-over 直接盖掉 pal.paper,
//      实测 vintage/scrap 底色一模一样(237,235,234),concert 的深蓝票面也变白。
//
// 判定手段:喂一张「纯品红 rgb(240,30,160)」的 PNG 照片。纯色照片模糊后还是同一个颜色,
// 所以「齿孔里是不是品红」=「有没有挖穿并透出下层模糊」,与参考值无关、可直接计数。
// 画面指纹在 --hash 模式采集(写入 tools/ticket-redo-fingerprints.json,随代码一起提交),
// 冻结 window.Date,保证不随运行日期漂移。
//
// 用法: node tools/run-electron.js tools/test-ticket-redo.js --hash   (重采指纹)
//       node tools/run-electron.js tools/test-ticket-redo.js           (回归检查)
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
const preset = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8'));

// 设计配色(与 engine-styles.js 里 styleTicket 的 pal 同步;故意在测试里再写一遍:
// 断言「渲染结果符合设计配色」才是有效检查,不是抄 engine 的返回值)
const PAPER = {
    TICKET_VINTAGE: [244, 238, 221],   // #f4eedd 米黄
    TICKET_SCRAP: [236, 227, 207],     // #ece3cf 手账米
    TICKET_CONCERT: [14, 27, 48],      // #0e1b30 深蓝夜场
};

// 演唱会票根的预设文件随「新增演唱会票根预设」那个提交加入;这里直接读文件,
// 顺带把预设本身也纳入回归(photoFrameStyle 写错/漏写会被下面 30 项断言抓住)
function variants() {
    return [
        { key: 'TICKET_VINTAGE', label: '复古旅行票根 TICKET_VINTAGE', preset: preset('复古旅行票根') },
        { key: 'TICKET_SCRAP', label: '手账拼贴票根 TICKET_SCRAP', preset: preset('手账拼贴票根') },
        { key: 'TICKET_CONCERT', label: '演唱会票根 TICKET_CONCERT', preset: preset('演唱会票根') },
    ];
}

const SCAN = (presetObj, extra, paper) => `(async () => {
    const A = window.App;
    const RD = Date;
    window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(2026, 4, 4, 12, 0, 0); } };
    // 纯品红 PNG 照片(用 PNG 不用 JPEG:压缩色偏会让「孔里是不是品红」的判定失真)
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1067;
    const g0 = c.getContext('2d');
    g0.fillStyle = 'rgb(240,30,160)'; g0.fillRect(0, 0, 1600, 1067);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/png'); });
    A.image = { el: im, name: 'p.png', w: 1600, h: 1067, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
    A.template = ${JSON.stringify(presetObj)};
    ${extra || ''}
    A.normalizeTemplate();
    A.invalidateStyleCaches();
    A.displayMax = 2200;
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 180));
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 150));
    const cv = A.dom.canvas, W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;

    // ── 几何:ticketGeom()/styleDims 的公式照抄一份(改坏了任一边,下面的尺寸断言会断)──
    const iw = 1600, ih = 1067;
    const bs = Math.max(5, A.template.photoFrameBorderSize || 5);
    const size = Math.max(5, Math.floor(Math.max(5, Math.floor(bs * 2.0)) * Math.min(iw, ih) / 1000.0));
    const side = Math.max(22, Math.round(size * 1.1));
    const headH = Math.max(58, Math.round(size * 2.0));
    const footBase = Math.max(44, Math.round(size * 1.6));
    const hasSig = !!A.template.userSignature;
    const sigH = hasSig ? Math.max(50, Math.round(size * 1.9)) : 0;
    const stubH = Math.max(44, Math.round(size * 1.5));
    const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const holeR = Math.max(3, Math.round(size * 0.225));
    const fIn = Math.max(16, Math.round(holeR * 2.0));
    const tw = iw + side * 2;
    const th = headH + ih + footBase + sigH + stubH;
    const tearY = headH + ih + footBase + sigH;
    const expW = tw + gap * 2, expH = th + gap * 2;
    const s = W / expW;                       // 画布可能被 displayMax 整体缩放,坐标按比例换算
    const SX = (v) => Math.round(v * s), SY = (v) => Math.round(v * s);
    const paper = ${JSON.stringify(paper)};
    const isF = (i) => Math.abs(d[i] - 240) <= 14 && Math.abs(d[i + 1] - 30) <= 14 && Math.abs(d[i + 2] - 160) <= 14;
    const dPaper = (i) => Math.abs(d[i] - paper[0]) + Math.abs(d[i + 1] - paper[1]) + Math.abs(d[i + 2] - paper[2]);
    const count = (x0, x1, y0, y1, fn) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (fn((y * W + x) * 4)) n++; return n; };

    // ① 整幅:全不透明 / 纸色总量 / 最外圈不许有纸色(票券四周必须留出模糊照片的 gap) / 指纹
    let alphaMin = 255;
    for (let i = 3; i < d.length; i += 4) if (d[i] < alphaMin) alphaMin = d[i];
    let paperish = 0, outerPaper = 0;
    const O = 6;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (dPaper(i) > 60) continue;
        paperish++;
        if (x < O || y < O || x >= W - O || y >= H - O) outerPaper++;
    }
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 12) { h ^= d[i]; h = Math.imul(h, 16777619); h ^= d[i + 1]; h = Math.imul(h, 16777619); h ^= d[i + 2]; h = Math.imul(h, 16777619); }
    const fp = (h >>> 0).toString(16);

    // ② 外缘齿孔:顶边/左边/右边那一行必须「既有品红(孔挖穿透出模糊)又有纸色(孔间是纸)」
    const topY = SY(gap + 1);
    const rowX0 = SX(gap), rowX1 = SX(gap + tw);
    const topF = count(rowX0, rowX1, topY, topY, isF);
    const topN = count(rowX0, rowX1, topY, topY, (i) => !isF(i));
    const leftX = SX(gap + 1), rightX = SX(gap + tw - 1);
    const colY0 = SY(gap), colY1 = SY(gap + th);
    const leftF = count(leftX, leftX, colY0, colY1, isF);
    const leftN = count(leftX, leftX, colY0, colY1, (i) => !isF(i));
    const rightF = count(rightX, rightX, colY0, colY1, isF);
    const rightN = count(rightX, rightX, colY0, colY1, (i) => !isF(i));

    // ③ 撕线:孔只落在撕线上,线往上 40px 必须是干净纸面
    const tearYc = SY(gap + tearY);
    const tearF = count(rowX0, rowX1, tearYc, tearYc, isF);
    const aboveY = SY(gap + tearY - 40);
    const tearAboveF = count(rowX0, rowX1, aboveY, aboveY, isF);

    // ④ 照片中心 = 品红(照片真的画上了,且没被胶带/装饰盖住中心)
    const photoI = (SY(gap + headH + ih / 2) * W + SX(gap + side + iw / 2)) * 4;
    const photoF = isF(photoI);

    // ⑤ 存根区油墨(条码 + 左右两端文字,排除齿孔带)
    const inset = fIn + 6;
    const stubInk = count(SX(gap + inset), SX(gap + tw - inset),
        SY(gap + tearY + holeR * 1.5), SY(gap + th - holeR * 1.5), (i) => dPaper(i) > 60);

    // ⑥ 纸色取样:照片左外侧的纯纸边(避开齿孔/分区底纹/内框/文字)
    const psI = (SY(gap + headH + 60) * W + SX(gap + Math.round((fIn + side) / 2))) * 4;
    const paperSample = [d[psI], d[psI + 1], d[psI + 2]];

    window.Date = RD;
    return { W, H, expW, expH, alphaMin, outerPaper, paperish, topF, topN, leftF, leftN,
        rightF, rightN, tearF, tearAboveF, photoF, stubInk, paperSample, fp };
})()`;

function movieVariant() {
    return { key: 'MOVIE_TICKET', label: '撕边电影票 MOVIE_TICKET', preset: preset('撕边电影票') };
}

// 撕边电影票单独一套扫描:几何是「右侧副券 + 竖向锯齿撕线」,与票根家族的底部存根不同。
// 判据一样(纯品红照片 → 品红就是「挖穿透出的模糊底」),另外查:票头/票脚深色条、锯齿只咬撕线。
const SCAN_MOVIE = (presetObj) => `(async () => {
    const A = window.App;
    const RD = Date;
    window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(2026, 4, 4, 12, 0, 0); } };
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1067;
    const g0 = c.getContext('2d');
    g0.fillStyle = 'rgb(240,30,160)'; g0.fillRect(0, 0, 1600, 1067);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/png'); });
    A.image = { el: im, name: 'p.png', w: 1600, h: 1067, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
    A.template = ${JSON.stringify(presetObj)};
    A.normalizeTemplate();
    A.invalidateStyleCaches();
    A.displayMax = 2200;
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 180));
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 150));
    const cv = A.dom.canvas, W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;

    // ── movieGeom() 的公式照抄一份(改坏了任一边,下面的尺寸断言会断)──
    const iw = 1600, ih = 1067;
    const bs = Math.max(5, A.template.photoFrameBorderSize || 5);
    const size = Math.max(5, Math.floor(Math.max(5, Math.floor(bs * 2.0)) * Math.min(iw, ih) / 1000.0));
    const side = Math.max(20, Math.round(size * 0.7));
    const headH = Math.max(34, Math.round(size * 0.85));
    const infoH = Math.max(26, Math.round(size * 0.62));
    const footH = Math.max(32, Math.round(size * 0.8));
    const stubW = Math.max(150, Math.round(iw * 0.28));
    const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const holeR = Math.max(3, Math.round(size * 0.225));
    const tooth = Math.max(6, Math.round(size * 0.18));
    const tw = iw + side * 2 + stubW;
    const th = headH + infoH + ih + footH;
    const tearX = side + iw;
    const expW = tw + gap * 2, expH = th + gap * 2;
    const s = W / expW;
    const SX = (v) => Math.round(v * s), SY = (v) => Math.round(v * s);
    const paper = [247, 242, 233];     // #f7f2e9 票纸
    const band = [236, 228, 212];      // #ece4d4 信息带
    const isF = (i) => Math.abs(d[i] - 240) <= 14 && Math.abs(d[i + 1] - 30) <= 14 && Math.abs(d[i + 2] - 160) <= 14;
    const dPaper = (i) => Math.abs(d[i] - paper[0]) + Math.abs(d[i + 1] - paper[1]) + Math.abs(d[i + 2] - paper[2]);
    const dTo = (i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
    const count = (x0, x1, y0, y1, fn) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (fn((y * W + x) * 4)) n++; return n; };

    let alphaMin = 255;
    for (let i = 3; i < d.length; i += 4) if (d[i] < alphaMin) alphaMin = d[i];
    let outerPaper = 0;
    const O = 6;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (dPaper(i) > 60) continue;
        if (x < O || y < O || x >= W - O || y >= H - O) outerPaper++;
    }
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 12) { h ^= d[i]; h = Math.imul(h, 16777619); h ^= d[i + 1]; h = Math.imul(h, 16777619); h ^= d[i + 2]; h = Math.imul(h, 16777619); }
    const fp = (h >>> 0).toString(16);

    // ① 四边齿孔:每条边都要「有孔(品红)又有孔间(纸色)」
    const xA = SX(gap), xB = SX(gap + tw), yT = SY(gap + 1), yB = SY(gap + th - 1);
    const topF = count(xA, xB, yT, yT, isF), topN = count(xA, xB, yT, yT, (i) => !isF(i));
    const botF = count(xA, xB, yB, yB, isF), botN = count(xA, xB, yB, yB, (i) => !isF(i));
    const xL = SX(gap + 1), xR = SX(gap + tw - 1), yA = SY(gap + 4), yZ = SY(gap + th - 4);
    const leftF = count(xL, xL, yA, yZ, isF), leftN = count(xL, xL, yA, yZ, (i) => !isF(i));
    const rightF = count(xR, xR, yA, yZ, isF), rightN = count(xR, xR, yA, yZ, (i) => !isF(i));

    // ② 竖向锯齿撕线:贴线右侧一列「有孔有纸」交替;副券内侧同一高度必须干净(≤ 3)
    // 扫描范围要避开上下边的齿孔带(上下边孔半径都是 holeR,不避开会把边孔当成撕线)
    const tcY0 = SY(gap + holeR * 2 + 6), tcY1 = SY(gap + th - holeR * 2 - 6);
    const tearCol = SX(gap + tearX + 3);
    const tearF = count(tearCol, tearCol, tcY0, tcY1, isF);
    const tearN = count(tearCol, tearCol, tcY0, tcY1, (i) => !isF(i));
    const stCol = SX(gap + tearX + tooth + 40);
    const stubF = count(stCol, stCol, tcY0, tcY1, isF);

    // ③ 照片中心 = 品红
    const photoI = (SY(gap + headH + infoH + ih / 2) * W + SX(gap + side + iw / 2)) * 4;
    const photoF = isF(photoI);

    // ④ 票头/票脚深色条(避开顶部齿孔咬入区)
    const dark = (i) => (d[i] + d[i + 1] + d[i + 2]) < 300;
    const bx0 = SX(gap + 30), bx1 = SX(gap + tw - 30);
    const hy0 = SY(gap + holeR + 6), hy1 = SY(gap + headH - 2);
    const headDark = count(bx0, bx1, hy0, hy1, dark), headAll = (bx1 - bx0 + 1) * (hy1 - hy0 + 1);
    const fy0 = SY(gap + th - footH + 4), fy1 = SY(gap + th - holeR - 6);
    const footDark = count(bx0, bx1, fy0, fy1, dark), footAll = (bx1 - bx0 + 1) * (fy1 - fy0 + 1);

    // ⑤ 副券油墨(文字 + 虚线票框 + 金色 ADMIT ONE),排除齿孔
    const stubInk = count(SX(gap + tearX + tooth + 10), SX(gap + tw - 20),
        SY(gap + headH + infoH), SY(gap + th - footH), (i) => dPaper(i) > 60 && !isF(i));

    // ⑥ 纸色 / 信息带取样
    const psI = (SY(gap + headH + infoH + 60) * W + SX(gap + Math.max(holeR + 6, Math.round(side * 0.5)))) * 4;
    const paperSample = [d[psI], d[psI + 1], d[psI + 2]];
    const bsI = (SY(gap + headH + Math.round(infoH * 0.5)) * W + SX(gap + tw - 6)) * 4;
    const bandSample = [d[bsI], d[bsI + 1], d[bsI + 2]];

    window.Date = RD;
    return { W, H, expW, expH, alphaMin, outerPaper, topF, topN, botF, botN, leftF, leftN, rightF, rightN,
        tearF, tearN, stubF, photoF, headDark, headAll, footDark, footAll, stubInk, paperSample, bandSample, fp,
        dPaper: 0, dBand: dTo(bsI, band) };
})()`;

function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    const mode = process.argv.includes('--hash') ? 'hash' : 'check';
    protocol.handle('qflocal', (req) => {
        try { const u = new URL(req.url); const p = u.searchParams.get('p'); if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 }); return net.fetch(pathToFileURL(p).href); }
        catch (e) { return new Response('NF', { status: 404 }); }
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
    await new Promise(r => setTimeout(r, 2200));

    const VS = variants();

    if (mode === 'hash') {
        console.log('指纹采集(冻结日期 2026-05-04, 纯品红照片):');
        const fps = {};
        for (const v of VS) {
            const r1 = await win.webContents.executeJavaScript(SCAN(v.preset, null, PAPER[v.key]));
            const r2 = await win.webContents.executeJavaScript(SCAN(v.preset, null, PAPER[v.key]));
            fps[v.key] = r1.fp;
            console.log(`  '${v.key}': '${r1.fp}',   // ${r1.W}x${r1.H} 纸色 ${JSON.stringify(r1.paperSample)}${r1.fp === r2.fp ? '' : '  ← 两次渲染不一致!'}`);
        }
        const mv = movieVariant();
        const m1 = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset));
        const m2 = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset));
        fps[mv.key] = m1.fp;
        console.log(`  '${mv.key}': '${m1.fp}',   // ${m1.W}x${m1.H} 纸色 ${JSON.stringify(m1.paperSample)}${m1.fp === m2.fp ? '' : '  ← 两次渲染不一致!'}`);
        const out = path.join(__dirname, 'ticket-redo-fingerprints.json');
        fs.writeFileSync(out, JSON.stringify(fps, null, 2) + '\n');
        console.log('已写入 ' + out);
        finish(0);
        return;
    }

    const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'ticket-redo-fingerprints.json'), 'utf8'));
    const fails = [];
    let total = 0;
    const line = (ok, label, got, expect) => {
        total++;
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };
    const dW = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

    console.log('票根家族「真票券」:重做回归');
    console.log('─'.repeat(94));

    const results = [];
    for (const v of VS) {
        const r = await win.webContents.executeJavaScript(SCAN(v.preset, null, PAPER[v.key]));
        results.push({ v, r });
        const paper = PAPER[v.key];
        console.log(`\n【${v.label}】 指纹 ${r.fp}  画布 ${r.W}x${r.H}  (按 ticketGeom 应为 ${r.expW}x${r.expH} × 缩放)`);
        const aspectOk = Math.abs(r.H - r.expH * (r.W / r.expW)) <= 1.5 && r.W <= 2200;
        line(aspectOk, '① styleDims 与 styleTicket 尺寸同源(高宽比一致,画布没有整体被压扁/撑高)',
            `实际 ${r.W}x${r.H},按 ticketGeom 应高 ${Math.round(r.expH * (r.W / r.expW))}(exp ${r.expW}x${r.expH})`, '差 ≤ 1.5px 且 W ≤ displayMax(2200)');
        line(r.alphaMin === 255, '② 整幅全不透明(导出没有透明洞/半透明边)',
            `全画布最小 alpha = ${r.alphaMin}`, '255');
        line(r.outerPaper === 0, '③ 最外圈 6px 没有纸色(票券四周留出 gap,浮在模糊照片上)',
            `外圈纸色像素 ${r.outerPaper} 个`, '0 个');
        const holes = r.topF >= 5 && r.topN >= 5 && r.leftF >= 5 && r.leftN >= 5 && r.rightF >= 5 && r.rightN >= 5;
        line(holes, '④ 外缘齿孔真打穿(顶/左/右三行都同时有孔=品红 与 孔间=纸色)',
            `顶 行孔 ${r.topF} / 纸 ${r.topN}   左列孔 ${r.leftF} / 纸 ${r.leftN}   右列孔 ${r.rightF} / 纸 ${r.rightN}`,
            '每项 ≥ 5');
        line(r.tearF >= 8 && r.tearAboveF <= 1, '⑤ 撕线齿孔成行,且只落在撕线上(线往上 40px 是干净纸面)',
            `撕线行品红 ${r.tearF} 个,线上方 40px 品红 ${r.tearAboveF} 个`, '撕线 ≥ 8 个 且 上方 ≤ 1 个');
        line(r.photoF === true, '⑥ 照片画上去了(照片中心是喂进去的品红)', `中心像素 ${r.photoF}`, 'true');
        line(r.stubInk >= 200, '⑦ 底部存根有内容(条码 + 票号 + 标语)',
            `存根油墨像素 ${r.stubInk} 个`, '≥ 200 个');
        const dPalette = dW(r.paperSample, paper), dWhite = dW(r.paperSample, [255, 255, 255]);
        line(dPalette <= 60 && dWhite >= 60, '⑧ 纸纹没盖掉配色(纸色贴着设计配色,且明显不是白纸)',
            `取样 ${JSON.stringify(r.paperSample)} → 到设计配色 ${dPalette},到纯白 ${dWhite}`, '到配色 ≤ 60 且 到白 ≥ 60');
        line(r.fp === FROZEN[v.key], '⑨ 画面指纹与冻结值一致(且冻结值是在别的进程采的 = 跨进程可复现)',
            `指纹 ${r.fp}`, FROZEN[v.key]);
    }

    // ── 跨变体:三个变体的底色必须真的不同(根因③ 的直接防回归)──
    const [rv, rs, rc] = results.map(x => x.r.paperSample);
    console.log(`\n【跨变体】 底色取样 vintage ${JSON.stringify(rv)} / scrap ${JSON.stringify(rs)} / concert ${JSON.stringify(rc)}`);
    line(dW(rv, rs) >= 10, '⑩ vintage 与 scrap 的底色不再是一模一样(旧 bug:两者都是 (237,235,234))',
        `两者相差 L1 = ${dW(rv, rs)}`, '≥ 10');
    line(dW(rc, rv) > 200 && dW(rc, rs) > 200, '⑪ concert 的深蓝票面真的显出来了(与另两个底色拉得开)',
        `concert↔vintage ${dW(rc, rv)},concert↔scrap ${dW(rc, rs)}`, '均 > 200');

    // ── 有签名时版式自动长高(信息栏多一行,不能压在存根上)──
    const sigPreset = JSON.parse(JSON.stringify(VS[0].preset));
    const rPlain = results[0].r;
    const rSig = await win.webContents.executeJavaScript(SCAN(sigPreset, 'A.template.userSignature = "— my memory —"; A.template.avatarShow = 1;', PAPER.TICKET_VINTAGE));
    line(rSig.H > rPlain.H && rSig.alphaMin === 255 && rSig.topF >= 5,
        '⑫ 带签名+头像时画布变高,且齿孔/全不透明仍然成立',
        `无签名 ${rPlain.H} → 有签名 ${rSig.H},alpha ${rSig.alphaMin},顶行孔 ${rSig.topF}`, `高度增加 且 alpha=255 且 孔 ≥ 5`);

    // ── 撕边电影票 MOVIE_TICKET:另一套几何(右侧副券 + 竖向锯齿撕线),单独一节断言 ──
    const mv = movieVariant();
    const rm = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset));
    const mvPaper = [247, 242, 233], mvBand = [236, 228, 212];
    console.log(`\n【${mv.label}】 指纹 ${rm.fp}  画布 ${rm.W}x${rm.H}  (按 movieGeom 应为 ${rm.expW}x${rm.expH} × 缩放)`);
    line(Math.abs(rm.H - rm.expH * (rm.W / rm.expW)) <= 1.5 && rm.W <= 2200,
        '⑬ styleDims 与 styleMovieTicket 尺寸同源(旧版两处各写一套,票脚整条被切掉)',
        `实际 ${rm.W}x${rm.H},按 movieGeom 应高 ${Math.round(rm.expH * (rm.W / rm.expW))}(exp ${rm.expW}x${rm.expH})`,
        '差 ≤ 1.5px 且 W ≤ displayMax(2200)');
    line(rm.alphaMin === 255, '⑭ 整幅全不透明(导出没有透明洞/半透明边)',
        `全画布最小 alpha = ${rm.alphaMin}`, '255');
    line(rm.outerPaper === 0, '⑮ 最外圈 6px 没有纸色(票券浮在模糊照片上,四周留 gap)',
        `外圈纸色像素 ${rm.outerPaper} 个`, '0 个');
    const mvHoles = rm.topF >= 5 && rm.topN >= 5 && rm.botF >= 5 && rm.botN >= 5
        && rm.leftF >= 5 && rm.leftN >= 5 && rm.rightF >= 5 && rm.rightN >= 5;
    line(mvHoles, '⑯ 四边齿孔真打穿(顶/底/左/右都同时有孔=品红 与 孔间=纸色)',
        `顶 ${rm.topF}/${rm.topN}  底 ${rm.botF}/${rm.botN}  左 ${rm.leftF}/${rm.leftN}  右 ${rm.rightF}/${rm.rightN}`,
        '每项 ≥ 5');
    line(rm.tearF >= 50 && rm.tearN >= 50 && rm.stubF <= 3,
        '⑰ 竖向锯齿撕线:贴线一列有孔有纸交替,且只咬撕线(副券内侧干净)',
        `撕线列 孔 ${rm.tearF} / 纸 ${rm.tearN}   副券内侧 ${rm.stubF} 个孔`, '撕线两项 ≥ 50 且 内侧 ≤ 3');
    line(rm.photoF === true, '⑱ 照片画上去了(照片中心是喂进去的品红)', `中心像素 ${rm.photoF}`, 'true');
    const hd = rm.headDark / rm.headAll, fd = rm.footDark / rm.footAll;
    line(hd >= 0.5 && fd >= 0.5, '⑲ 深色票头/票脚还在(影院名+日期时间 / 标语+票号的底条)',
        `票头深色占比 ${hd.toFixed(3)}   票脚 ${fd.toFixed(3)}`, '均 ≥ 0.5');
    line(rm.stubInk >= 200, '⑳ 副券有内容(副券 STUB / 虚线票框 / ROW·SEAT·SCREEN / 竖排 ADMIT ONE)',
        `副券油墨像素 ${rm.stubInk} 个`, '≥ 200 个');
    const mvDW = dW(rm.paperSample, mvPaper), mvDB = dW(rm.bandSample, mvBand);
    line(mvDW <= 30 && mvDB <= 30, '㉑ 票纸/信息带贴着设计配色(纸纹 multiply 没把票面洗白或染色)',
        `票纸 ${JSON.stringify(rm.paperSample)} → ${mvDW}   信息带 ${JSON.stringify(rm.bandSample)} → ${mvDB}`, '两者均 ≤ 30');
    line(rm.fp === FROZEN[mv.key], '㉒ 画面指纹与冻结值一致(跨进程可复现)', `指纹 ${rm.fp}`, FROZEN[mv.key]);

    console.log('\n' + '─'.repeat(94));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
