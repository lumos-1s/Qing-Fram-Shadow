// 票根家族「真票券」重做(TICKET_VINTAGE / TICKET_SCRAP / TICKET_CONCERT)的回归测试,
// 以及撕边电影票(MOVIE_TICKET)的重做回归(同一套判据,另一套几何:右侧副券 + 竖向锯齿撕线),
// 以及复古登机牌(BOARDING_PASS)的重做回归(第三套几何:票头城市码 + 信息带 + 右侧副券,
// 票面是紫蓝渐变而不是纸色 —— 判据换成「亮度分区 + 黑色渐变」,见 SCAN_BP)。
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
//
// 另有 ⑬–⑰ / ㉘–㉞:签名/头像行(四个票券共用的那一行)。能力表(style-caps.js 的 sigTicket)
// 现在会在这四个风格上露出「签名内容/字体/颜色/字号 + 头像大小/显示头像」,而能力表只登记
// 「哪些行可见」—— 行可见但引擎不读,用户看到的就是「滑块露着、拖了没反应」。所以每个控件
// 都要有实测断点:喂纯绿头像图判 avatarShow/avatarScale,数签名油墨判 signSize,数红像素判
// signColor。无签名也无头像时 sigH=0,几何与重做版逐像素一致(所以指纹不用重采)。
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

const SCAN = (presetObj, extra, paper, after) => `(async () => {
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
    // 与 ticketGeom() 同源:「有头像 或 有签名」都会多出一行;两者都没有时才没有(0)
    const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
        && window.__qfsAvatarImg.naturalWidth) && (A.template.avatarShow !== 0);
    const hasSig = !!A.template.userSignature;
    const sigH = (hasAv || hasSig) ? Math.max(50, Math.round(size * 1.9)) : 0;
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

    // ⑦ 签名/头像行(信息栏下半):行内油墨 / 头像绿 / 签名红。
    //    用来断言 signSize / avatarScale / signColor / avatarShow 这四个面板控件真的接进了引擎,
    //    而不是「滑块露着、拖了没反应」。
    //    ⚠ 油墨判据用「到纸色 L1 > 150」而不是 > 60:信息栏分区底纹(5%)+做旧暗角+纸纹颗粒
    //    叠起来就有 60~90,弱阈值会把整条带子算成油墨(实测 47% —— 于是 signSize 200% 只涨
    //    1.1 倍,判不出差异)。>150 只留笔画实心处,和字号成比例。
    //    带内 X 范围避开印刷内框, Y 范围避开撕线齿孔。
    const rowCy = gap + headH + ih + footBase + Math.round(sigH * 0.5);
    const sgY0 = SY(rowCy - Math.round(sigH * 0.30)), sgY1 = SY(rowCy + Math.round(sigH * 0.30));
    const sgX0 = SX(gap + inset + 8), sgX1 = SX(gap + tw - inset - 8);
    const isGreen = (i) => d[i] < 90 && d[i + 1] > 150 && d[i + 2] < 90;
    const isRed = (i) => d[i] > 140 && d[i + 1] < 110 && d[i + 2] < 110;
    let sigInk = 0, sigGreen = 0, sigRed = 0, sigCore = 0;
    if (sigH > 0 && sgY1 > sgY0) {
        sigInk = count(sgX0, sgX1, sgY0, sgY1, (i) => dPaper(i) > 150 && !isGreen(i));
        sigGreen = count(sgX0, sgX1, sgY0, sgY1, isGreen);
        sigRed = count(sgX0, sgX1, sgY0, sgY1, isRed);
        // 近黑核:channel 和 < 200。风格墨色 pal.ink #2c2720 的实心笔画约为 115;
        // 引擎旧默认 #555 的和恒为 255,即使与纸色(和 ~650)抗锯齿相混也化简不出 < 200
        // (650-535t < 200 需 t > 0.84,但 #555 起点就是 255) —— 所以这枚计数零误报。
        sigCore = count(sgX0, sgX1, sgY0, sgY1, (i) => (d[i] + d[i + 1] + d[i + 2]) < 200 && !isGreen(i));
    }

    // ⑧ 签名行居中基准:整组(头像+签名)居中于「照片」中线,不是整张票的中线。
    //    取行带内油墨的最左/最右列算中点。票根家族里两者重合(照片在票面里左右等宽),
    //    电影票才见真章:右侧多一条副券,参考线取错中点会右偏 stubW/2 ≈ 224px。
    let sigMid = -1;
    if (sigInk > 0) {
        const inkAt = (x) => { for (let y = sgY0; y <= sgY1; y++) { const i = (y * W + x) * 4; if (dPaper(i) > 150 || isGreen(i)) return true; } return false; };
        let l = -1, r = -1;
        for (let x = sgX0; x <= sgX1 && l < 0; x++) if (inkAt(x)) l = x;
        for (let x = sgX1; x >= sgX0 && r < 0; x--) if (inkAt(x)) r = x;
        if (l >= 0 && r >= 0) sigMid = (l + r) / 2;
    }
    const phMid = SX(gap + side + iw / 2);

    ${after || ''}
    window.Date = RD;
    return { W, H, expW, expH, alphaMin, outerPaper, paperish, topF, topN, leftF, leftN,
        rightF, rightN, tearF, tearAboveF, photoF, stubInk, paperSample, fp,
        sigH, sigInk, sigGreen, sigRed, sigCore, sigMid, phMid };
})()`;

function movieVariant() {
    return { key: 'MOVIE_TICKET', label: '撕边电影票 MOVIE_TICKET', preset: preset('撕边电影票') };
}

function boardingVariant() {
    return { key: 'BOARDING_PASS', label: '复古登机牌 BOARDING_PASS', preset: preset('复古登机牌') };
}

// 撕边电影票单独一套扫描:几何是「右侧副券 + 竖向锯齿撕线」,与票根家族的底部存根不同。
// 判据一样(纯品红照片 → 品红就是「挖穿透出的模糊底」),另外查:票头/票脚深色条、锯齿只咬撕线。
const SCAN_MOVIE = (presetObj, extra, after) => `(async () => {
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

    // ── movieGeom() 的公式照抄一份(改坏了任一边,下面的尺寸断言会断)──
    const iw = 1600, ih = 1067;
    const bs = Math.max(5, A.template.photoFrameBorderSize || 5);
    const size = Math.max(5, Math.floor(Math.max(5, Math.floor(bs * 2.0)) * Math.min(iw, ih) / 1000.0));
    const side = Math.max(20, Math.round(size * 0.7));
    const headH = Math.max(34, Math.round(size * 0.85));
    const infoH = Math.max(26, Math.round(size * 0.62));
    const footH = Math.max(32, Math.round(size * 0.8));
    // 与 movieGeom() 同源:有头像或有签名才多出签名行(sigH)
    const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
        && window.__qfsAvatarImg.naturalWidth) && (A.template.avatarShow !== 0);
    const hasSig = !!A.template.userSignature;
    const sigH = (hasAv || hasSig) ? Math.max(40, Math.round(size * 1.5)) : 0;
    const stubW = Math.max(150, Math.round(iw * 0.28));
    const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const holeR = Math.max(3, Math.round(size * 0.225));
    const tooth = Math.max(6, Math.round(size * 0.18));
    const tw = iw + side * 2 + stubW;
    const th = headH + infoH + ih + sigH + footH;
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

    // ⑦ 签名/头像行(照片与深色票脚之间):主票面内的油墨/头像绿;副券那一列必须干净(整组不越撕线)
    //    油墨判据「到纸色 L1 > 150」只留笔画实心处:副券底纹(5%)+纸纹颗粒叠起来就有 36~80,
    //    弱阈值会把副券那一列也算成油墨(实测 102 个假油墨),判不出「越没越撕线」。
    //    副券带起点离齿尖再让 12px:齿尖是尖角,反锯齿会往外洇 1~2px,而齿孔露出的模糊照片
    //    对纸色距离 290+,算进油墨里就会误报。右端同样要让开最右一列外缘齿孔(孔心在 x=tw,
    //    半径 holeR,露出的模糊照片也会被算成「副券有油墨」—— 实测就是这 68 个假油墨)。
    const rowCy = gap + headH + infoH + ih + Math.round(sigH * 0.5);
    const sgY0 = SY(rowCy - Math.round(sigH * 0.30)), sgY1 = SY(rowCy + Math.round(sigH * 0.30));
    const sgX0 = SX(gap + side + 4), sgX1 = SX(gap + tearX - tooth - 4);
    const sbX0 = SX(gap + tearX + tooth + 12), sbX1 = SX(gap + tw - holeR - 6);
    const isGreen = (i) => d[i] < 90 && d[i + 1] > 150 && d[i + 2] < 90;
    let sigInk = 0, sigGreen = 0, stubSigInk = 0;
    if (sigH > 0 && sgY1 > sgY0) {
        sigInk = count(sgX0, sgX1, sgY0, sgY1, (i) => dPaper(i) > 150 && !isGreen(i));
        sigGreen = count(sgX0, sgX1, sgY0, sgY1, isGreen);
        stubSigInk = count(sbX0, sbX1, sgY0, sgY1, (i) => dPaper(i) > 150 && !isGreen(i));
    }

    // ⑧ 签名行居中基准(与票根家族同一套):取行带内油墨最左/最右列的中点,应与「照片中线」重合。
    //    电影票的照片不在整张票的正中(右边还有一条副券),所以这里能真正区分参考线:
    //    若按整张票的中线居中(常见笔误 tw/2),中点会右偏 stubW/2 ≈ 224px,远超 40px 容差。
    let sigMid = -1;
    if (sigInk > 0) {
        const inkAt = (x) => { for (let y = sgY0; y <= sgY1; y++) { const i = (y * W + x) * 4; if (dPaper(i) > 150 || isGreen(i)) return true; } return false; };
        let l = -1, r = -1;
        for (let x = sgX0; x <= sgX1 && l < 0; x++) if (inkAt(x)) l = x;
        for (let x = sgX1; x >= sgX0 && r < 0; x--) if (inkAt(x)) r = x;
        if (l >= 0 && r >= 0) sigMid = (l + r) / 2;
    }
    const phMid = SX(gap + side + iw / 2);
    const tkMid = SX(gap + tw / 2);

    window.Date = RD;
    return { W, H, expW, expH, alphaMin, outerPaper, topF, topN, botF, botN, leftF, leftN, rightF, rightN,
        tearF, tearN, stubF, photoF, headDark, headAll, footDark, footAll, stubInk, paperSample, bandSample, fp,
        sigH, sigInk, sigGreen, stubSigInk, sigMid, phMid, tkMid,
        dPaper: 0, dBand: dTo(bsI, band) };
})()`;

// 复古登机牌单独一套扫描:几何是「票头(城市码+航班号) + 信息带 + 主照片 + 浅色姓名条 + 票脚
// + 右侧竖向锯齿撕线切出的副券」,票面是紫蓝渐变而不是纸色 —— 所以判据不用「到纸色距离」:
//   · 品红  = 模糊照片透出(齿孔挖穿 / 锯齿咬开 / 票外 gap)
//   · 亮度  = 票面分区(票头/票脚压暗 → lum<100;姓名条提亮 → lum>200;渐变自上而下由浅入深)
// 纯品红 PNG 照片模糊后还是品红,「孔里是不是品红」就是「有没有挖穿」,与参考色无关、可直接计数。
const SCAN_BP = (presetObj, extra, after) => `(async () => {
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

    // ── boardingGeom() 的公式照抄一份(改坏了任一边,下面的尺寸断言会断)──
    const iw = 1600, ih = 1067;
    const bs = Math.max(5, A.template.photoFrameBorderSize || 5);
    const size = Math.max(5, Math.floor(Math.max(5, Math.floor(bs * 2.0)) * Math.min(iw, ih) / 1000.0));
    const side = Math.max(22, Math.round(size * 1.0));
    const headH = Math.max(64, Math.round(size * 2.3));
    const infoH = Math.max(30, Math.round(size * 1.05));
    const footH = Math.max(30, Math.round(size * 0.95));
    const hasAv = !!(window.__qfsAvatarImg && window.__qfsAvatarImg.complete
        && window.__qfsAvatarImg.naturalWidth) && (A.template.avatarShow !== 0);
    const hasSig = !!A.template.userSignature;
    const sigH = (hasAv || hasSig) ? Math.max(44, Math.round(size * 1.6)) : 0;
    const stubW = Math.max(150, Math.round(iw * 0.30));
    const gap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const holeR = Math.max(3, Math.round(size * 0.225));
    const tooth = Math.max(6, Math.round(size * 0.18));
    const tw = iw + side * 2 + stubW;
    const th = headH + infoH + ih + sigH + footH;
    const tearX = side + iw;
    const expW = tw + gap * 2, expH = th + gap * 2;
    const s = W / expW;
    const SX = (v) => Math.round(v * s), SY = (v) => Math.round(v * s);
    const isF = (i) => Math.abs(d[i] - 240) <= 14 && Math.abs(d[i + 1] - 30) <= 14 && Math.abs(d[i + 2] - 160) <= 14;
    const lum = (i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
    const count = (x0, x1, y0, y1, fn) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (fn((y * W + x) * 4)) n++; return n; };

    // ① 整幅全不透明 / 最外圈不许出现票面(票外 gap 透出的必须是模糊照片)/ 指纹
    let alphaMin = 255;
    for (let i = 3; i < d.length; i += 4) if (d[i] < alphaMin) alphaMin = d[i];
    let outerCard = 0;
    const O = 6;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x < O || y < O || x >= W - O || y >= H - O) { if (!isF((y * W + x) * 4)) outerCard++; }
    }
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 12) { h ^= d[i]; h = Math.imul(h, 16777619); h ^= d[i + 1]; h = Math.imul(h, 16777619); h ^= d[i + 2]; h = Math.imul(h, 16777619); }
    const fp = (h >>> 0).toString(16);

    // ② 四边齿孔:每条边都要「有孔(品红)又有孔间(票面)」
    const xA = SX(gap), xB = SX(gap + tw), yT = SY(gap + 1), yB = SY(gap + th - 1);
    const topF = count(xA, xB, yT, yT, isF), topN = count(xA, xB, yT, yT, (i) => !isF(i));
    const botF = count(xA, xB, yB, yB, isF), botN = count(xA, xB, yB, yB, (i) => !isF(i));
    const xL = SX(gap + 1), xR = SX(gap + tw - 1), yA = SY(gap + 4), yZ = SY(gap + th - 4);
    const leftF = count(xL, xL, yA, yZ, isF), leftN = count(xL, xL, yA, yZ, (i) => !isF(i));
    const rightF = count(xR, xR, yA, yZ, isF), rightN = count(xR, xR, yA, yZ, (i) => !isF(i));

    // ③ 竖向锯齿撕线:贴线右侧一列「有孔有票面」交替;副券内侧同一高度必须干净(≤ 3)
    const tcY0 = SY(gap + holeR * 2 + 6), tcY1 = SY(gap + th - holeR * 2 - 6);
    const tearCol = SX(gap + tearX + 3);
    const tearF = count(tearCol, tearCol, tcY0, tcY1, isF);
    const tearN = count(tearCol, tearCol, tcY0, tcY1, (i) => !isF(i));
    const stCol = SX(gap + tearX + tooth + 40);
    const stubF = count(stCol, stCol, tcY0, tcY1, isF);

    // ④ 照片中心 = 品红
    const photoI = (SY(gap + headH + infoH + ih / 2) * W + SX(gap + side + iw / 2)) * 4;
    const photoF = isF(photoI);

    // ⑤ 票头/票脚压暗(避开顶部齿孔咬入区)
    const dark = (i) => lum(i) < 100;
    const bx0 = SX(gap + 30), bx1 = SX(gap + tearX - 30);
    const hy0 = SY(gap + holeR + 6), hy1 = SY(gap + headH - 2);
    const headDark = count(bx0, bx1, hy0, hy1, dark), headAll = (bx1 - bx0 + 1) * (hy1 - hy0 + 1);
    const fy0 = SY(gap + th - footH + 4), fy1 = SY(gap + th - holeR - 6);
    const footDark = count(bx0, bx1, fy0, fy1, dark), footAll = (bx1 - bx0 + 1) * (fy1 - fy0 + 1);

    // ⑥ 紫蓝渐变真的画在票面上:照片左侧那条纸边(纯渐变、无分区)自上而下必须明显变深
    const lumAt = (px, py) => { const i = (py * W + px) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
    const gX = SX(gap + Math.round(side * 0.5));
    const lumTop = lumAt(gX, SY(gap + headH + infoH + Math.round(ih * 0.15)));
    const lumBot = lumAt(gX, SY(gap + headH + infoH + Math.round(ih * 0.85)));

    // ⑦ 副券油墨:深色副券上的条形码 + 竖排浅色文字(亮像素)
    const stubInk = count(SX(gap + tearX + tooth + 10), SX(gap + tw - 20),
        SY(gap + headH + infoH), SY(gap + th - footH), (i) => !isF(i) && lum(i) > 150);

    // ⑧ 签名/头像行:直接印在深色票面上,不垫浅色条。预设给了米白 signColor(#f3f1fa),
    //    所以在票面上是「亮油墨」;整组只落在撕线左侧的主票面内(副券那一列在签名行高度上要干净)。
    const rowCy = gap + headH + infoH + ih + Math.round(sigH * 0.5);
    const sgY0 = SY(rowCy - Math.round(sigH * 0.30)), sgY1 = SY(rowCy + Math.round(sigH * 0.30));
    const sgX0 = SX(gap + side + 4), sgX1 = SX(gap + tearX - tooth - 4);
    const sbX0 = SX(gap + tearX + tooth + 12), sbX1 = SX(gap + tw - holeR - 6);
    const isGreen = (i) => d[i] < 90 && d[i + 1] > 150 && d[i + 2] < 90;
    const isRed = (i) => d[i] > 140 && d[i + 1] < 110 && d[i + 2] < 110;
    const isInk = (i) => lum(i) > 150;   // 深色票面上的米白签名 = 亮像素
    let sigInk = 0, sigGreen = 0, stubSigInk = 0, sigRed = 0, sigBgLum = -1;
    if (sigH > 0 && sgY1 > sgY0) {
        sigInk = count(sgX0, sgX1, sgY0, sgY1, (i) => isInk(i) && !isGreen(i));
        sigGreen = count(sgX0, sgX1, sgY0, sgY1, isGreen);
        stubSigInk = count(sbX0, sbX1, sgY0, sgY1, (i) => isInk(i) && !isGreen(i));
        sigRed = count(sgX0, sgX1, sgY0, sgY1, isRed);
        // 签名行左侧空白处必须仍是深色票面 —— 钉住「不垫浅色姓名条」
        sigBgLum = lumAt(SX(gap + side + Math.round(iw * 0.06)), SY(rowCy));
    }

    // ⑨ 签名行底色亮度(深色票面):用来断言「签名是直接印在票面上的亮油墨」而不是「垫了浅色底」
    const stripLum = (sigH > 0) ? sigBgLum : -1;

    ${after || ''}
    window.Date = RD;
    return { W, H, expW, expH, alphaMin, outerCard, topF, topN, botF, botN, leftF, leftN, rightF, rightN,
        tearF, tearN, stubF, photoF, headDark, headAll, footDark, footAll, lumTop, lumBot, stubInk, fp,
        sigH, sigInk, sigGreen, sigRed, stubSigInk, stripLum };
})()`;

// ── 「默认不带签名/头像」这条链路:模拟用户在上一款预设里填过签名/头像,再点票券预设 ──
// 引擎只照模板画,「默认关」这件事不能写进引擎(写进去就等于每个预设硬编码一次),
// 只能写进预设数据(userSignature:"" + avatarShow:0)。链路有三段,任一段失守都会把签名行复活:
//   ① applyPreset 拿上一份模板的签名把空串盖回去 → 整行回来;
//   ② 启动时 loadUserAvatar 自动填「— 昵称 —」 → 整行回来;
//   ③ 反过来,别的预设的「用户签名优先」被这一改带坏 → 用户填的签名被预设清掉。
// 所以这里连「填过签名的上一份模板」一起喂进去,量的是点完之后的模板字段 + 渲染高度。
const CHAIN = (presetObj, doLogin) => `(async () => {
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
    // 喂一张纯绿头像:让「头像本来是能画出来的」成立,这样行没出现就只能是开关/声明的原因
    const ac2 = document.createElement('canvas'); ac2.width = 96; ac2.height = 96;
    const ag2 = ac2.getContext('2d'); ag2.fillStyle = 'rgb(0,200,0)'; ag2.fillRect(0, 0, 96, 96);
    const aim2 = new Image();
    await new Promise(r => { aim2.onload = r; aim2.onerror = r; aim2.src = ac2.toDataURL('image/png'); });
    window.__qfsAvatarImg = aim2;
    // 上一款预设:用户自己填过签名、头像开着、还调过签名颜色
    A.template = Object.assign(${JSON.stringify(preset('复古旅行票根'))},
        { userSignature: '— my memory —', avatarShow: 1, signColor: '#ff0000' });
    A.normalizeTemplate();
    // 用户在面板里点一下目标预设缩略图
    A.applyPreset(${JSON.stringify(presetObj)});
    const afterPreset = { sig: A.template.userSignature || '', av: A.template.avatarShow, color: A.template.signColor || '' };
    if (${doLogin ? 'true' : 'false'}) {
        // 启动自动填充那一步(登录态 + localStorage 昵称)
        try { localStorage.setItem('qfs_nickname', '老王'); } catch (e) {}
        A.loadUserAvatar();
        try { localStorage.removeItem('qfs_nickname'); } catch (e) {}
    }
    const afterLogin = A.template.userSignature || '';
    A.invalidateStyleCaches();
    A.displayMax = 2200;
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 180));
    window.__render(A, false);
    await new Promise(r => setTimeout(r, 150));
    const cv = A.dom.canvas, W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const hasAv = !!((window.__qfsAvatarImg && window.__qfsAvatarImg.complete
        && window.__qfsAvatarImg.naturalWidth) && (A.template.avatarShow !== 0));
    let alphaMin = 255;
    for (let i = 3; i < d.length; i += 4) { if (d[i] < alphaMin) { alphaMin = d[i]; if (alphaMin === 0) break; } }
    window.Date = RD;
    return { W, H, alphaMin, hasSig: !!A.template.userSignature, hasAv, afterPreset, afterLogin, style: A.template.photoFrameStyle };
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
        const bp = boardingVariant();
        const b1 = await win.webContents.executeJavaScript(SCAN_BP(bp.preset));
        const b2 = await win.webContents.executeJavaScript(SCAN_BP(bp.preset));
        fps[bp.key] = b1.fp;
        console.log(`  '${bp.key}': '${b1.fp}',   // ${b1.W}x${b1.H}${b1.fp === b2.fp ? '' : '  ← 两次渲染不一致!'}`);
        const out = path.join(__dirname, 'ticket-redo-fingerprints.json');
        fs.writeFileSync(out, JSON.stringify(fps, null, 2) + '\n');
        console.log('已写入 ' + out);
        finish(0);
        return;
    }

    const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'ticket-redo-fingerprints.json'), 'utf8'));
    const fails = [];
    let total = 0;
    let skipped = 0;
    const line = (ok, label, got, expect) => {
        total++;
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };
    // 像素指纹是"在采样机上冻结的哈希"，换 GPU/字体就会变（CI 用的是 swiftshader +
    // runner 自带字体）。这类断言在 CI 上不比数值，只打印出来供人看，避免每天假红。
    const inCI = !!(process.env.CI && process.env.CI !== 'false');
    const fpLine = (ok, label, got, expect) => {
        if (inCI && !ok) {
            total++; skipped++;
            console.log(`  SKIP ${label}`);
            console.log(`       指纹 ${got} ≠ 冻结值 ${expect}（CI 的渲染后端/字体与采样机不同，像素指纹不可跨机比较）`);
            return;
        }
        line(ok, label, got, expect);
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
        fpLine(r.fp === FROZEN[v.key], '⑨ 画面指纹与冻结值一致(且冻结值是在别的进程采的 = 跨进程可复现)',
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

    // ── ⑬–⑰ 签名行的四个面板控件真的接进了引擎 ──
    // 这几项存在的理由:面板「签名 / 头像」组在 TICKET_*/MOVIE_TICKET 上从无到有(style-caps 的
    // sigTicket)。能力表只登记「哪些行可见」,行可见但引擎不读 = 拖了没反应,所以每个控件都要有断点。
    // 头像喂纯绿图:行内出现绿色像素 = 头像真的画上去了(比「画布高度变了」更有判别力)。
    // 「勾上」现在要显式写 avatarShow = 1:这四款预设自带 avatarShow: 0(见 ㉟),
    // 不写就等于测的是默认值,而默认值恰恰就是「不画」。
    const SIGTXT = 'A.template.userSignature = "— my memory —";';
    const NOAV = ' A.template.avatarShow = 0;';
    const AVUP = `const ac = document.createElement('canvas'); ac.width = 96; ac.height = 96;
        const ag = ac.getContext('2d'); ag.fillStyle = 'rgb(0,200,0)'; ag.fillRect(0, 0, 96, 96);
        const aim = new Image();
        await new Promise(r => { aim.onload = r; aim.onerror = r; aim.src = ac.toDataURL('image/png'); });
        window.__qfsAvatarImg = aim;`;
    const AVON = ' A.template.avatarShow = 1;';
    const AVDOWN = 'window.__qfsAvatarImg = null;';
    const vp = PAPER.TICKET_VINTAGE;
    line(rSig.sigInk >= 100 && rSig.sigGreen === 0,
        '⑬ 签名真的画在信息栏下半,且没有头像图时不画头像',
        `签名行油墨 ${rSig.sigInk} 个,头像绿 ${rSig.sigGreen} 个`, '油墨 ≥ 100 且 绿 = 0');
    const rBig = await win.webContents.executeJavaScript(SCAN(sigPreset, SIGTXT + NOAV + ' A.template.signSize = 2;', vp));
    line(rBig.sigInk > rSig.sigInk * 1.4 && rBig.H === rSig.H,
        '⑭ 「签名大小」滑块生效(200% 的签名油墨明显变多),且字号只影响行内、不改画布高度',
        `100% 油墨 ${rSig.sigInk} → 200% 油墨 ${rBig.sigInk};画布 ${rSig.H} → ${rBig.H}`,
        '油墨 > 1.4× 且 高度不变');
    const rAvOn = await win.webContents.executeJavaScript(SCAN(sigPreset, AVUP + AVON + SIGTXT, vp, AVDOWN));
    const rAvOff = await win.webContents.executeJavaScript(SCAN(sigPreset, AVUP + SIGTXT + NOAV, vp, AVDOWN));
    line(rAvOn.sigGreen >= 200 && rAvOff.sigGreen === 0 && rAvOn.H === rAvOff.H,
        '⑮ 「显示头像」勾选开关生效(勾上才画头像),且只影响画不画、不改画布高度',
        `勾选 头像绿 ${rAvOn.sigGreen} 个 / 不勾选 ${rAvOff.sigGreen} 个;画布 ${rAvOn.H} → ${rAvOff.H}`,
        '勾选 ≥ 200 且 不勾选 = 0 且 高度不变');
    const rAvBig = await win.webContents.executeJavaScript(SCAN(sigPreset, AVUP + AVON + SIGTXT + ' A.template.avatarScale = 2;', vp, AVDOWN));
    line(rAvBig.sigGreen > rAvOn.sigGreen * 1.4,
        '⑯ 「头像大小」滑块生效(200% 的头像明显更大)',
        `100%(默认 85%) 头像绿 ${rAvOn.sigGreen} → 200% ${rAvBig.sigGreen} 个`, '> 1.4×');
    const rRed = await win.webContents.executeJavaScript(SCAN(sigPreset, SIGTXT + NOAV + ' A.template.signColor = "#e74c3c";', vp));
    line(rRed.sigRed >= 100 && rSig.sigRed === 0,
        '⑰ 「签名颜色」生效(选红色后签名变红)',
        `默认色 红像素 ${rSig.sigRed} 个 → 红色 ${rRed.sigRed} 个`, '红色 ≥ 100 且 默认 = 0');
    // ⑰b 未设置 signColor 时必须回落到风格墨色(票根家族 = pal.ink #2c2720 近黑),而不是旧的
    //     引擎默认 #555;且显式设 #555 仍然生效(用户手选的灰照用,不做「看起来像默认就忽略」)。
    const r555 = await win.webContents.executeJavaScript(SCAN(sigPreset, SIGTXT + NOAV + ' A.template.signColor = "#555";', vp));
    line(rSig.sigCore >= 100 && r555.sigCore <= 20 && r555.sigInk >= 100,
        '⑰b 未设置签名色 → 风格墨色(近黑),显式 #555 仍被采用',
        `默认色近黑核 ${rSig.sigCore} 个;#555 近黑核 ${r555.sigCore} 个,油墨 ${r555.sigInk} 个`,
        '默认 ≥ 100 且 #555 ≤ 20 且 #555 油墨 ≥ 100');
    // ㉝ 签名行的居中基准:用「头像+签名」整组去量最左/最右油墨,中点应落在照片中线上。
    //    票根家族的票面没有副券,照片中线 == 整张票的中线 —— 这里钉住「必须居中」这个形状,
    //    参考线写成贴着头像起笔(即整组不再居中)会偏出容差。
    line(rAvOn.sigMid > -1 && Math.abs(rAvOn.sigMid - rAvOn.phMid) <= 40,
        '㉝ 签名/头像整组居中于照片中线(不偏左也不偏右)',
        `组中点 ${Math.round(rAvOn.sigMid)}px,照片中线 ${Math.round(rAvOn.phMid)}px,偏差 ${Math.round(Math.abs(rAvOn.sigMid - rAvOn.phMid))}px`,
        '偏差 ≤ 40px');

    // ── 撕边电影票 MOVIE_TICKET:另一套几何(右侧副券 + 竖向锯齿撕线),单独一节断言 ──
    const mv = movieVariant();
    const rm = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset));
    const mvPaper = [247, 242, 233], mvBand = [236, 228, 212];
    console.log(`\n【${mv.label}】 指纹 ${rm.fp}  画布 ${rm.W}x${rm.H}  (按 movieGeom 应为 ${rm.expW}x${rm.expH} × 缩放)`);
    line(Math.abs(rm.H - rm.expH * (rm.W / rm.expW)) <= 1.5 && rm.W <= 2200,
        '⑱ styleDims 与 styleMovieTicket 尺寸同源(旧版两处各写一套,票脚整条被切掉)',
        `实际 ${rm.W}x${rm.H},按 movieGeom 应高 ${Math.round(rm.expH * (rm.W / rm.expW))}(exp ${rm.expW}x${rm.expH})`,
        '差 ≤ 1.5px 且 W ≤ displayMax(2200)');
    line(rm.alphaMin === 255, '⑲ 整幅全不透明(导出没有透明洞/半透明边)',
        `全画布最小 alpha = ${rm.alphaMin}`, '255');
    line(rm.outerPaper === 0, '⑳ 最外圈 6px 没有纸色(票券浮在模糊照片上,四周留 gap)',
        `外圈纸色像素 ${rm.outerPaper} 个`, '0 个');
    const mvHoles = rm.topF >= 5 && rm.topN >= 5 && rm.botF >= 5 && rm.botN >= 5
        && rm.leftF >= 5 && rm.leftN >= 5 && rm.rightF >= 5 && rm.rightN >= 5;
    line(mvHoles, '㉑ 四边齿孔真打穿(顶/底/左/右都同时有孔=品红 与 孔间=纸色)',
        `顶 ${rm.topF}/${rm.topN}  底 ${rm.botF}/${rm.botN}  左 ${rm.leftF}/${rm.leftN}  右 ${rm.rightF}/${rm.rightN}`,
        '每项 ≥ 5');
    line(rm.tearF >= 50 && rm.tearN >= 50 && rm.stubF <= 3,
        '㉒ 竖向锯齿撕线:贴线一列有孔有纸交替,且只咬撕线(副券内侧干净)',
        `撕线列 孔 ${rm.tearF} / 纸 ${rm.tearN}   副券内侧 ${rm.stubF} 个孔`, '撕线两项 ≥ 50 且 内侧 ≤ 3');
    line(rm.photoF === true, '㉓ 照片画上去了(照片中心是喂进去的品红)', `中心像素 ${rm.photoF}`, 'true');
    const hd = rm.headDark / rm.headAll, fd = rm.footDark / rm.footAll;
    line(hd >= 0.5 && fd >= 0.5, '㉔ 深色票头/票脚还在(影院名+日期时间 / 标语+票号的底条)',
        `票头深色占比 ${hd.toFixed(3)}   票脚 ${fd.toFixed(3)}`, '均 ≥ 0.5');
    line(rm.stubInk >= 200, '㉕ 副券有内容(副券 STUB / 虚线票框 / ROW·SEAT·SCREEN / 竖排 ADMIT ONE)',
        `副券油墨像素 ${rm.stubInk} 个`, '≥ 200 个');
    const mvDW = dW(rm.paperSample, mvPaper), mvDB = dW(rm.bandSample, mvBand);
    line(mvDW <= 30 && mvDB <= 30, '㉖ 票纸/信息带贴着设计配色(纸纹 multiply 没把票面洗白或染色)',
        `票纸 ${JSON.stringify(rm.paperSample)} → ${mvDW}   信息带 ${JSON.stringify(rm.bandSample)} → ${mvDB}`, '两者均 ≤ 30');
    fpLine(rm.fp === FROZEN[mv.key], '㉗ 画面指纹与冻结值一致(跨进程可复现)', `指纹 ${rm.fp}`, FROZEN[mv.key]);

    // ── ㉘–㉛ 电影票的签名/头像行(照片与深色票脚之间那条票纸)──
    const rMvSig = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset, SIGTXT + NOAV));
    line(rMvSig.H > rm.H && rMvSig.alphaMin === 255
        && Math.abs(rMvSig.H - rMvSig.expH * (rMvSig.W / rMvSig.expW)) <= 1.5,
        '㉘ 电影票有签名时画布变高(与 movieGeom 同源),且齿孔/全不透明仍然成立',
        `无签名 ${rm.H} → 有签名 ${rMvSig.H}(exp ${rMvSig.expH}),alpha ${rMvSig.alphaMin}`,
        '高度增加 且 alpha=255 且 高宽比一致');
    line(rMvSig.sigInk >= 100 && rMvSig.photoF === true && (rMvSig.footDark / rMvSig.footAll) >= 0.5,
        '㉙ 签名行落在照片与深色票脚之间(行内有油墨),且照片/票脚都没被挤坏',
        `签名行油墨 ${rMvSig.sigInk} 个,照片中心品红 ${rMvSig.photoF},票脚深色占比 ${(rMvSig.footDark / rMvSig.footAll).toFixed(3)}`,
        '油墨 ≥ 100 且 照片=true 且 票脚 ≥ 0.5');
    line(rMvSig.stubSigInk <= 5,
        '㉚ 签名/头像整组不越竖向撕线(副券那一列在签名行高度上是干净纸面)',
        `副券列签名行油墨 ${rMvSig.stubSigInk} 个`, '≤ 5 个');
    // ㉞ 签名行的居中基准。这是电影票与票根家族唯一的几何差别:票头/信息带/票脚都是左右对齐
    //    (靠 inset 定位),签名行是这一版唯一的居中元素。参考线写成整张票的中线的话,画面只是
    //    悄悄右移 stubW/2 ≈ 224px —— 没有任何「画没画/在不在框里」的断言抓得到。两条线一起比:
    //    离照片中线近、离票面中线远,谁对谁错立刻分明。
    line(rMvSig.sigMid > -1
        && Math.abs(rMvSig.sigMid - rMvSig.phMid) <= 40
        && Math.abs(rMvSig.sigMid - rMvSig.tkMid) >= 100,
        '㉞ 签名行居中于「照片」中线,而不是整张票的中线(右边还挂着副券)',
        `组中点 ${Math.round(rMvSig.sigMid)},照片中线 ${Math.round(rMvSig.phMid)},票面中线 ${Math.round(rMvSig.tkMid)}`,
        '离照片中线 ≤ 40px 且 离票面中线 ≥ 100px');
    const rMvAvOn = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset, AVUP + AVON + SIGTXT, AVDOWN));
    const rMvAvOff = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset, AVUP + SIGTXT + NOAV, AVDOWN));
    line(rMvAvOn.sigGreen >= 200 && rMvAvOff.sigGreen === 0 && rMvAvOn.H === rMvAvOff.H,
        '㉛ 电影票的「显示头像」开关同样生效(勾上才画头像,且不改画布高度)',
        `勾选 头像绿 ${rMvAvOn.sigGreen} 个 / 不勾选 ${rMvAvOff.sigGreen} 个;画布 ${rMvAvOn.H} → ${rMvAvOff.H}`,
        '勾选 ≥ 200 且 不勾选 = 0 且 高度不变');
    // 电影票的签名行是另一段代码(字号系数 size*0.34,票根家族是 *0.30),所以「签名大小」要单独验一次
    const rMvBig = await win.webContents.executeJavaScript(SCAN_MOVIE(mv.preset, SIGTXT + NOAV + ' A.template.signSize = 2;'));
    line(rMvBig.sigInk > rMvSig.sigInk * 1.4 && rMvBig.H === rMvSig.H,
        '㉜ 电影票的「签名大小」滑块同样生效(200% 油墨明显变多),字号只影响行内、不改画布高度',
        `100% 油墨 ${rMvSig.sigInk} → 200% ${rMvBig.sigInk};画布 ${rMvSig.H} → ${rMvBig.H}`,
        '油墨 > 1.4× 且 高度不变');

    // ── ㊴–㊿ 复古登机牌 BOARDING_PASS:第三套几何 + 紫蓝渐变票面 ──
    const bp = boardingVariant();
    const rb = await win.webContents.executeJavaScript(SCAN_BP(bp.preset));
    console.log(`\n【${bp.label}】 指纹 ${rb.fp}  画布 ${rb.W}x${rb.H}  (按 boardingGeom 应为 ${rb.expW}x${rb.expH} × 缩放)`);
    line(Math.abs(rb.H - rb.expH * (rb.W / rb.expW)) <= 1.5 && rb.W <= 2200,
        '㊴ styleDims 与 styleBoardingPass 尺寸同源(两处各写一套会让票面与登记画布错位)',
        `实际 ${rb.W}x${rb.H},按 boardingGeom 应高 ${Math.round(rb.expH * (rb.W / rb.expW))}(exp ${rb.expW}x${rb.expH})`,
        '差 ≤ 1.5px 且 W ≤ displayMax(2200)');
    line(rb.alphaMin === 255, '㊵ 整幅全不透明(导出没有透明洞/半透明边)',
        `全画布最小 alpha = ${rb.alphaMin}`, '255');
    line(rb.outerCard === 0, '㊶ 最外圈 6px 全是模糊照片(票券四周留 gap,浮在模糊底上)',
        `外圈非品红(票面)像素 ${rb.outerCard} 个`, '0 个');
    const bpHoles = rb.topF >= 5 && rb.topN >= 5 && rb.botF >= 5 && rb.botN >= 5
        && rb.leftF >= 5 && rb.leftN >= 5 && rb.rightF >= 5 && rb.rightN >= 5;
    line(bpHoles, '㊷ 四边齿孔真打穿(顶/底/左/右都同时有孔=品红 与 孔间=票面)',
        `顶 ${rb.topF}/${rb.topN}  底 ${rb.botF}/${rb.botN}  左 ${rb.leftF}/${rb.leftN}  右 ${rb.rightF}/${rb.rightN}`,
        '每项 ≥ 5');
    line(rb.tearF >= 50 && rb.tearN >= 50 && rb.stubF <= 3,
        '㊸ 竖向锯齿撕线:贴线一列有孔有票面交替,且只咬撕线(副券内侧干净)',
        `撕线列 孔 ${rb.tearF} / 票面 ${rb.tearN}   副券内侧 ${rb.stubF} 个孔`, '撕线两项 ≥ 50 且 内侧 ≤ 3');
    line(rb.photoF === true, '㊹ 照片画上去了(照片中心是喂进去的品红)', `中心像素 ${rb.photoF}`, 'true');
    const bpHd = rb.headDark / rb.headAll, bpFd = rb.footDark / rb.footAll;
    line(bpHd >= 0.5 && bpFd >= 0.5 && (rb.lumTop - rb.lumBot) >= 20,
        '㊺ 票面分区+渐变都在:票头/票脚压暗成深色条,且紫蓝渐变真的画在票面上(票头侧亮、票脚侧暗)',
        `票头深色占比 ${bpHd.toFixed(3)}   票脚 ${bpFd.toFixed(3)}   照片带左缘 ${rb.lumTop.toFixed(1)}→${rb.lumBot.toFixed(1)}(差 ${(rb.lumTop - rb.lumBot).toFixed(1)})`,
        '深浅占比均 ≥ 0.5 且 亮度差 ≥ 20');
    line(rb.stubInk >= 200, '㊻ 副券有内容(条形码 + 竖排 BOARDING/SEAT/GATE + 票号)',
        `副券亮像素 ${rb.stubInk} 个`, '≥ 200 个');
    fpLine(rb.fp === FROZEN[bp.key], '㊼ 画面指纹与冻结值一致(跨进程可复现)', `指纹 ${rb.fp}`, FROZEN[bp.key]);

    // ㊽–㊿ 登机牌的签名/头像行(照片与票脚之间的深色票面,不垫浅底)──
    // 注意 ㊽ 同时钉住「预设的浅色 signColor 真的被用上」:这张紫蓝卡在签名行高度只有 ~58 亮度,
    // 深墨(#555/#2c2720 一族)画上去对比不到 1.5:1 等于看不见;预设显式给了米白 #f3f1fa。
    // (引擎自 2026-10 起:未设置时不再填 #555,由风格取兜底色 —— 见 buildState 与 ⑰b 的钉子。)
    const SIGTXT_B = 'A.template.userSignature = "— my memory —";';
    const rBpSig = await win.webContents.executeJavaScript(SCAN_BP(bp.preset, SIGTXT_B + NOAV));
    line(rBpSig.H > rb.H && rBpSig.alphaMin === 255 && rBpSig.stripLum >= 0 && rBpSig.stripLum < 120
        && rBpSig.sigInk >= 100 && rBpSig.sigGreen === 0 && rBpSig.stubSigInk <= 5
        && Math.abs(rBpSig.H - rBpSig.expH * (rBpSig.W / rBpSig.expW)) <= 1.5,
        '㊽ 有签名时:画布变高,签名以米白直接印在深色票面上(不垫浅色条)、无头像图时不画头像、整组不越竖向撕线',
        `无签名 ${rb.H} → 有签名 ${rBpSig.H},签名行底色亮度 ${rBpSig.stripLum.toFixed(1)}(应深),签名亮油墨 ${rBpSig.sigInk},头像绿 ${rBpSig.sigGreen},副券列油墨 ${rBpSig.stubSigInk},alpha ${rBpSig.alphaMin}`,
        '高度增加 且 底色<120 且 亮油墨≥100 且 绿=0 且 副券列≤5');
    const rBpAvOn = await win.webContents.executeJavaScript(SCAN_BP(bp.preset, AVUP + AVON + SIGTXT_B, AVDOWN));
    const rBpAvOff = await win.webContents.executeJavaScript(SCAN_BP(bp.preset, AVUP + SIGTXT_B + NOAV, AVDOWN));
    line(rBpAvOn.sigGreen >= 200 && rBpAvOff.sigGreen === 0 && rBpAvOn.H === rBpAvOff.H,
        '㊾ 登机牌的「显示头像」开关生效(勾上才画头像,且不改画布高度)',
        `勾选 头像绿 ${rBpAvOn.sigGreen} 个 / 不勾选 ${rBpAvOff.sigGreen} 个;画布 ${rBpAvOn.H} → ${rBpAvOff.H}`,
        '勾选 ≥ 200 且 不勾选 = 0 且 高度不变');
    const rBpBig = await win.webContents.executeJavaScript(SCAN_BP(bp.preset, SIGTXT_B + NOAV + ' A.template.signSize = 2;'));
    const rBpRed = await win.webContents.executeJavaScript(SCAN_BP(bp.preset, SIGTXT_B + NOAV + ' A.template.signColor = "#e74c3c";'));
    line(rBpBig.sigInk > rBpSig.sigInk * 1.4 && rBpBig.H === rBpSig.H
        && rBpRed.sigRed >= 100 && rBpSig.sigRed === 0,
        '㊿ 登机牌的「签名大小」「签名颜色」两个控件都生效(200% 油墨变多且不改高度;选红色后签名变红)',
        `100% 油墨 ${rBpSig.sigInk} → 200% ${rBpBig.sigInk}(画布 ${rBpSig.H}→${rBpBig.H});默认色红像素 ${rBpSig.sigRed} → 红色 ${rBpRed.sigRed}`,
        '油墨 > 1.4× 且 高度不变 且 红色 ≥ 100 且 默认 = 0');

    // ── ㉟–㊳ 五款票券预设「默认不带签名/头像」──
    // 引擎画不画签名行只看模板里的 avatarShow / userSignature(⑬–⑰ 已钉住控件有效),
    // 所以「默认关」这一条只能写在预设数据里,并由下面三段链路保住。
    console.log('\n【默认不带签名/头像】 五款票券预设:预设说了算,启动填充不复活它');
    const TICKETS = ['复古旅行票根', '手账拼贴票根', '演唱会票根', '撕边电影票', '复古登机牌'];
    line(TICKETS.every(n => {
        const p = preset(n);
        return p.photoFrameStyle && p.avatarShow === 0 && p.userSignature === '';
    }),
        '㉟ 五款票券预设自带「默认不带」的声明(avatarShow=0 且 userSignature 为空串)',
        TICKETS.map(n => `${n} → avatarShow ${preset(n).avatarShow},签名 ${JSON.stringify(preset(n).userSignature)}`).join('   |   '),
        '每款 avatarShow=0 且签名为空串');

    const rChainTicket = await win.webContents.executeJavaScript(CHAIN(preset('复古旅行票根'), true));
    line(rChainTicket.afterPreset.sig === '' && rChainTicket.afterPreset.av === 0
        && rChainTicket.afterPreset.color === '#ff0000',
        '㊱ 上一份预设的签名/头像没被带进票券预设(预设显式写了的才归预设管,没写的照旧沿用)',
        `签名 ${JSON.stringify(rChainTicket.afterPreset.sig)},头像开关 ${rChainTicket.afterPreset.av},签名颜色 ${JSON.stringify(rChainTicket.afterPreset.color)}(预设没声明,应沿用)`,
        '签名 "" 且 头像开关 0 且 签名颜色仍是 #ff0000');
    line(rChainTicket.afterLogin === '' && rChainTicket.hasSig === false && rChainTicket.hasAv === false
        && rChainTicket.H === rPlain.H && rChainTicket.alphaMin === 255,
        '㊲ 启动自动填充也没把空签名填成「— 昵称 —」(画布高度回到「无签名」那档,整幅仍全不透明)',
        `签名 ${JSON.stringify(rChainTicket.afterLogin)},画布高 ${rChainTicket.H}(无签名档 ${rPlain.H}),alpha ${rChainTicket.alphaMin},hasSig/hasAv ${rChainTicket.hasSig}/${rChainTicket.hasAv}`,
        '签名仍为空 且 高度 == 无签名档 且 alpha=255');

    // 反过来钉住:「预设没写签名的,仍沿用用户自己的」这条原有规则不能被上面那一改带坏
    const rChainOther = await win.webContents.executeJavaScript(CHAIN(preset('NOMO复古相机'), true));
    line(rChainOther.afterPreset.sig === '— my memory —' && rChainOther.afterPreset.av === 1,
        '㊳ 换到不带签名声明的预设时,用户自己的签名/头像开关仍然优先(原有规则没被带坏)',
        `签名 ${JSON.stringify(rChainOther.afterPreset.sig)},头像开关 ${rChainOther.afterPreset.av}`,
        '签名照旧带过来 且 头像开关照旧为 1');

    console.log('\n' + '─'.repeat(94));
    console.log(fails.length
        ? `✖ ${fails.length} 项未通过: ${fails.join('、')}`
        : `✓ 全部 ${total - skipped} 项通过${skipped ? `（跳过 ${skipped} 项像素指纹：CI 环境不比对）` : ''}`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
