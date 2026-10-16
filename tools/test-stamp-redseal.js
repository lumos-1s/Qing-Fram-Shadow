// 红章纪念邮票(STAMP_REDSEAL)重做后的回归测试。
//
// 背景:原先红章的构成是「两个同心圆 + 一行 '★ 纪念 ★'」,而这一行在字号 r*0.42 下
// 宽约 260px,内圈直径只有约 178px —— 实测两个五角星被挤进内外圈之间的圈带里
// (半径 90~119 的圈带里有 1466 个红像素,角度集中在 0° 和 ±180°,即章的左右两侧),
// 看起来像"假章";票面也只有一层纯米色,没有纪念邮票的印刷质感。
//
// 本测试做三件事:
//   A) 红章几何体检 —— 把红色像素按"到章心距离 / 外圈半径"归一化后分桶,断言:
//      · 内容(「纪念」+小星)与内外圈之间有一段干净的空白(证明没有东西挤在圈带里)
//      · 圈带以外的红色只出现在两条圈线附近(证明章的图形规整)
//      · 整枚章完整落在照片内、外形是圆的
//   B) 防回归 —— 5 个邮票变体的画面指纹冻结(4 个非红章变体必须与冻结值逐像素一致,
//      红章自己的必须与重做前不同);日期用固定时间冻结,保证指纹不随运行日期漂移。
//      这里的冻结值是「邮票重做 + 模糊底不透明修复」之后重采的一版:修复把模糊底从
//      max(w/iw,h/ih) 换成「外扩一圈 + 贴自己两遍」,5 个变体的画面都变了(见 FROZEN 上方注释)。
//   C) 整幅全不透明 —— 5 个变体的全画布最小 alpha 必须是 255:模糊底四周不留半透明带
//      (修复前实测 min 131、上下各约 39 行、左右整条边),否则导出 PNG 压在深色背景上会看到一条极淡的缝。
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

// 重做前(旧实现)的红章指纹 —— 重做后必须变;其余 4 个变体必须不变
const OLD_REDSEAL = 'c459dfe8';
// 邮票家族「模糊底不透明」修复后的指纹(修复内容见 engine-styles.js 的 styleStamp:
// 模糊底原来按 max(w/iw,h/ih) 铺,模糊核会吸到画布外的透明像素,四周留出半透明带
// (实测 min alpha 131、上下各约 39 行);改成与票根/电影票同一套「外扩一圈 + 贴自己两遍」后,
// 整幅 alpha 都是 255。这一步会改变全部 5 个邮票变体的画面,所以这里的指纹比修复前整体重采了一次:
// 纪念 48a29554→6e89016 / 牛皮纸 b97461c0→109ac51 / 蓝晒 675d71af→76728d95 /
// 黑金 30107e11→570f2528 / 红章 88c98490→4709ec04(即 OLD_REDSEAL 之后又变了一次)。
const FROZEN = {
    '纪念邮票': '6e89016',
    '牛皮纸邮票': '109ac51',
    '蓝晒邮票': '76728d95',
    '黑金邮票': '570f2528',
};

const MEASURE = (presetObj, extra) => `(async () => {
    const A = window.App;
    // 冻结日期:日期是 new Date(),不冻结的话整幅指纹会随运行日期变化
    const RD = Date;
    window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(2026, 4, 4, 12, 0, 0); } };
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1067;
    const g0 = c.getContext('2d');
    const sky = g0.createLinearGradient(0, 0, 0, 1067);
    sky.addColorStop(0, '#3a6ea5'); sky.addColorStop(0.65, '#cfe0ee'); sky.addColorStop(1, '#8fae7a');
    g0.fillStyle = sky; g0.fillRect(0, 0, 1600, 1067);
    g0.fillStyle = 'rgba(255,240,190,0.9)'; g0.beginPath(); g0.arc(1200, 300, 90, 0, 6.2832); g0.fill();
    g0.fillStyle = '#5d7a63'; g0.beginPath(); g0.moveTo(0, 780); g0.lineTo(420, 470); g0.lineTo(820, 800); g0.closePath(); g0.fill();
    g0.fillStyle = '#6b8a5a'; g0.fillRect(0, 800, 1600, 267);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/jpeg', 0.92); });
    A.image = { el: im, name: 'p.jpg', w: 1600, h: 1067, exif: {} };
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
    // 整幅指纹(FNV-1a,每 3 个像素取一个,够稳且快)
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 12) { h ^= d[i]; h = Math.imul(h, 16777619); h ^= d[i + 1]; h = Math.imul(h, 16777619); h ^= d[i + 2]; h = Math.imul(h, 16777619); }
    const fp = (h >>> 0).toString(16);
    // 整幅最小 alpha:模糊底不外扩/不叠两遍时,四周会留下 alpha<255 的半透明带(修之前实测 min 131)
    let alphaMin = 255;
    for (let i = 3; i < d.length; i += 4) { if (d[i] < alphaMin) { alphaMin = d[i]; if (alphaMin === 0) break; } }
    window.Date = RD;
    return { W, H, fp, alphaMin, data: null };
})()`;

// 红章几何体检(在渲染进程里算,避免把 16MB 像素搬回来)
const SEAL_SCAN = (presetObj, extra, withAvatar) => `(async () => {
    const A = window.App;
    const RD = Date;
    window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(2026, 4, 4, 12, 0, 0); } };
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1067;
    const g0 = c.getContext('2d'); g0.fillStyle = '#7fa8c8'; g0.fillRect(0, 0, 1600, 1067);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    A.image = { el: im, name: 'p.jpg', w: 1600, h: 1067, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
    A.template = ${JSON.stringify(presetObj)};
    ${extra || ''}
    ${withAvatar ? 'const _prevAv = window.__qfsAvatarImg;' : ''}
    ${withAvatar ? 'const _ac = document.createElement("canvas"); _ac.width = 160; _ac.height = 160; const _ag = _ac.getContext("2d"); _ag.fillStyle = "#ff00ff"; _ag.fillRect(0, 0, 160, 160); _ag.fillStyle = "#00ffff"; _ag.beginPath(); _ag.arc(80, 80, 46, 0, 6.2832); _ag.fill(); const _av = new Image(); await new Promise(r => { _av.onload = r; _av.onerror = r; _av.src = _ac.toDataURL("image/png"); }); window.__qfsAvatarImg = _av;' : ''}
    A.normalizeTemplate(); A.invalidateStyleCaches(); A.displayMax = 2200;
    window.__render(A, false); await new Promise(r => setTimeout(r, 180));
    window.__render(A, false); await new Promise(r => setTimeout(r, 150));
    const cv = A.dom.canvas, W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    // 几何(与 styleStamp 一致)
    const iw = 1600, ih = 1067;
    const size = Math.max(5, Math.floor(Math.floor(50 * 2.0) * Math.min(iw, ih) / 1000));
    const side = Math.max(16, Math.round(iw * 0.025), Math.round(size * 0.8));
    const blurGap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const holeR = Math.max(3, Math.round(size * 0.225));
    const x0 = blurGap, y0 = blurGap;
    const photo = { x: x0 + side, y: y0 + side, w: iw, h: ih };
    const face = { x: x0, y: y0, w: iw + side * 2, h: ih + side * 2 + Math.max(46, Math.round(size * 1.8)) };
    const isRed = (i) => d[i] > 110 && d[i] > d[i + 1] * 1.6 && d[i] > d[i + 2] * 1.6;
    // 1) 整枚章的红色 bbox
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!isRed(i)) continue;
        n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, R = (maxX - minX + maxY - minY) / 4;
    // 2) 归一化半径直方图(0.02 一桶):内容 / 圈带 / 圈线 各自落在哪
    const buckets = new Array(56).fill(0);
    let outside = 0;
    for (let y = Math.max(0, Math.floor(cy - R * 1.3)); y <= Math.min(H - 1, Math.ceil(cy + R * 1.3)); y++) {
        for (let x = Math.max(0, Math.floor(cx - R * 1.3)); x <= Math.min(W - 1, Math.ceil(cx + R * 1.3)); x++) {
            const i = (y * W + x) * 4;
            if (!isRed(i)) continue;
            const rr = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / R;
            const b = Math.floor(rr / 0.02);
            if (b >= 0 && b < buckets.length) buckets[b]++; else outside++;
        }
    }
    // 3) 票面质感:左边距印刷带里"偏离纸色"的像素数 + 顶部/底部文字带的墨色 bbox
    //    左边距 = face 左内缘 → 照片左缘之间的整条竖带(避开齿孔行列)。
    //    >25 视为有印刷纹理(雕刻细线),>150 视为实线(内框)。
    const paper = [250, 245, 234];
    const inkDiff = (i) => Math.abs(d[i] - paper[0]) + Math.abs(d[i + 1] - paper[1]) + Math.abs(d[i + 2] - paper[2]);
    const isInk = (i) => inkDiff(i) > 60;
    let marginInk = 0, marginStrong = 0;
    const mX1 = Math.round(face.x + 3), mX2 = Math.round(photo.x - 2);
    const mY1 = Math.round(face.y + holeR * 2.2), mY2 = Math.round(face.y + face.h - holeR * 2.2);
    for (let y = mY1; y < mY2; y++) {
        for (let x = mX1; x < mX2; x++) {
            const dv = inkDiff((y * W + x) * 4);
            if (dv > 25) marginInk++;
            if (dv > 150) marginStrong++;
        }
    }
    const bandInk = (y1, y2, x1, x2) => {
        let cnt = 0, bMinX = 1e9, bMaxX = -1, bMinY = 1e9, bMaxY = -1;
        for (let y = Math.max(0, Math.round(y1)); y < Math.min(H, Math.round(y2)); y++) {
            for (let x = Math.max(0, Math.round(x1)); x < Math.min(W, Math.round(x2)); x++) {
                const i = (y * W + x) * 4;
                if (!isInk(i)) continue;
                cnt++; if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
            }
        }
        return { cnt, x: bMinX, y: bMinY, w: bMaxX - bMinX, h: bMaxY - bMinY };
    };
    const header = bandInk(face.y + holeR * 1.6, photo.y - 2, face.x + iw * 0.08, face.x + face.w - iw * 0.08);
    // 票题:只看正中一条(题签的纸色块会压掉内框横线,所以这一条上的墨色只可能来自票题文字)
    const faceC0 = face.x + face.w / 2;
    const title = bandInk(face.y + holeR * 1.2, face.y + side, faceC0 - 100, faceC0 + 100);
    // 底部安全区:照片下沿 → 票面下内缘,且左右避开齿孔(齿孔咬穿票面会露出模糊背景,会被误判为墨色)
    const safe = {
        x1: face.x + holeR * 2.2, y1: photo.y + photo.h + 2,
        x2: face.x + face.w - holeR * 2.2, y2: face.y + face.h - holeR * 2.2,
    };
    const footer = bandInk(safe.y1, safe.y2, safe.x1, safe.x2);
    // 字距诊断: 确认 g.letterSpacing 在当前 Chromium 里真的生效(数字形式会被静默忽略)
    const g2 = cv.getContext('2d');
    g2.font = '48px "SimSun", serif';
    g2.letterSpacing = '0px';
    const lsW0 = g2.measureText('2026/5/4').width;
    g2.letterSpacing = '9px';
    const lsW1 = g2.measureText('2026/5/4').width;
    g2.letterSpacing = '0px';
    g2.letterSpacing = 9;
    const lsWNum = g2.measureText('2026/5/4').width;
    g2.letterSpacing = '0px';
    // 头像圆(品红/青): 有头像时应在底栏内出现
    let avN = 0, avMinY = 1e9, avMaxY = -1;
    for (let y = Math.floor(photo.y + photo.h); y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 120) { avN++; if (y < avMinY) avMinY = y; if (y > avMaxY) avMaxY = y; }
    }
    window.Date = RD;
    ${withAvatar ? 'window.__qfsAvatarImg = _prevAv;  // 还原,别污染后面的渲染' : ''}
    return { W, H, photo, face, holeR, size, red: { n, minX, minY, maxX, maxY, cx, cy, R }, buckets, outside, marginInk, marginStrong, header, title, footer, safe,
        lsTest: { w0: Math.round(lsW0), w1: Math.round(lsW1), wn: Math.round(lsWNum) }, avatar: { n: avN, minY: avMinY, maxY: avMaxY } };
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

    const NAMES = ['纪念邮票', '牛皮纸邮票', '蓝晒邮票', '黑金邮票', '红章纪念邮票'];

    if (mode === 'hash') {
        console.log('指纹采集(冻结日期 2026-05-04):');
        for (const n of NAMES) {
            const r1 = await win.webContents.executeJavaScript(MEASURE(preset(n)));
            const r2 = await win.webContents.executeJavaScript(MEASURE(preset(n)));
            console.log(`  '${n}': '${r1.fp}',   // ${r1.W}x${r1.H}${r1.fp === r2.fp ? '' : '  ← 两次渲染不一致!'}`);
        }
        finish(0);
        return;
    }

    const fails = [];
    let total = 0;
    const line = (ok, label, got, expect) => {
        total++;
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    // ── A) 其它 4 个变体逐像素不变(冻结),且整幅全不透明(模糊底修复的防回归)──
    console.log('红章纪念邮票:重做回归');
    console.log('─'.repeat(94));
    for (const n of NAMES.slice(0, 4)) {
        const r = await win.webContents.executeJavaScript(MEASURE(preset(n)));
        line(r.fp === FROZEN[n], `① ${n}:画面与冻结指纹一致(邮票重做 + 模糊底不透明修复之后的版本)`,
            `指纹 ${r.fp} (${r.W}x${r.H})`, FROZEN[n]);
        line(r.alphaMin === 255, `①b ${n}:整幅全不透明(模糊底外扩一圈 + 贴自己两遍,四周没有半透明带)`,
            `全画布最小 alpha = ${r.alphaMin}`, '255');
    }
    const oldRed = await win.webContents.executeJavaScript(MEASURE(preset('红章纪念邮票')));
    line(oldRed.fp !== OLD_REDSEAL, '② 红章纪念邮票:画面确实被重做过(与重做前的指纹不同)',
        `指纹 ${oldRed.fp}`, `≠ ${OLD_REDSEAL}`);
    line(oldRed.alphaMin === 255, '②b 红章纪念邮票:整幅也全不透明', `全画布最小 alpha = ${oldRed.alphaMin}`, '255');

    // ── B) 红章几何体检 ──
    const s = await win.webContents.executeJavaScript(SEAL_SCAN(preset('红章纪念邮票')));
    const P = s.photo, F = s.face, red = s.red;
    line(red.n > 0, '③ 能识别到红章(红色像素数 > 0)', `${red.n} 个红像素  bbox ${red.minX},${red.minY} - ${red.maxX},${red.maxY}  章心 ${Math.round(red.cx)},${Math.round(red.cy)}  外圈半径 ${Math.round(red.R)}`,
        '红像素 > 0');
    const inPhoto = red.n > 0 && red.minX > P.x && red.maxX < P.x + P.w && red.minY > P.y && red.maxY < P.y + P.h;
    line(inPhoto, '④ 整枚章完整落在照片内(四边都在照片里)',
        `章 ${red.minX}..${red.maxX} × ${red.minY}..${red.maxY} / 照片 ${P.x}..${P.x + P.w} × ${P.y}..${P.y + P.h}`, '章 bbox ⊂ 照片 rect');
    const w = red.maxX - red.minX, hh = red.maxY - red.minY;
    const round = Math.abs(w - hh) <= Math.round(Math.max(w, hh) * 0.06);
    line(round, '⑤ 章是圆的(bbox 宽高接近)', `宽 ${w} 高 ${hh} 差 ${Math.abs(w - hh)}`, `差 ≤ ${Math.round(Math.max(w, hh) * 0.06)}`);
    // 归一化半径直方图:内容 / 留白 / 内圈 / 留白 / 外圈
    const NB = s.buckets.length;
    const sum = (a, b) => { let t = 0; for (let k = a; k < b; k++) t += s.buckets[k]; return t; };
    const B = (rr) => Math.floor(rr / 0.02);
    const content = sum(0, B(0.52));            // 「纪念」+小星
    const gap = sum(B(0.52), B(0.65));          // 内容与内圈之间的空白带
    const innerRing = sum(B(0.65), B(0.78));    // 内圈线
    const between = sum(B(0.78), B(0.87));      // 内外圈之间的空白带 ← 旧实现的 ★ 就卡在这
    const outerRing = sum(B(0.87), B(1.08));    // 外圈线
    const beyond = sum(B(1.08), NB);
    const hist = s.buckets.map((v, k) => (v ? (k * 0.02).toFixed(2) + ':' + v : null)).filter(Boolean).join(' ');
    console.log('       半径直方图(0.02 一桶, 归一化到外圈): ' + hist);
    console.log(`       内容区 ${content} / 留白 ${gap} / 内圈 ${innerRing} / 圈间留白 ${between} / 外圈 ${outerRing} / 圈外 ${beyond}`);
    line(content > 0 && innerRing > 0 && outerRing > 0 && gap === 0,
        '⑥ 「纪念」/小星 在内圈以内,且与内圈之间留白(内容没有顶到圈线)',
        `内容区 ${content} 个 / 留白(0.52~0.65) ${gap} 个 / 内圈 ${innerRing} 个`, '内容>0 且 留白=0');
    line(between === 0, '⑦ 内外圈之间完全是空的(旧实现的两个 ★ 就挤在这里)',
        `圈间留白(0.78~0.87)红像素 ${between} 个`, '0 个');
    line(beyond === 0 && s.outside === 0, '⑧ 章外没有游离红像素(没有文字/星溢出外圈)',
        `圈外(>1.08R) ${beyond} 个 / 采样窗外的 ${s.outside} 个`, '0 个');

    // ── C) 票面质感 / 顶部票题 / 底部排版 ──
    line(s.marginInk > 200 && s.marginStrong > 50, '⑨ 票面左边距有印刷质感(雕刻细线 + 双细线内框,不是纯色块)',
        `左边距印刷带(宽 ${s.face.x + 3}..${s.photo.x - 2})非纸色像素 ${s.marginInk} 个,其中实线 ${s.marginStrong} 个`, '纹理 > 200 且 实线 > 50');
    line(s.title.cnt > 40, '⑩ 票面顶部印了票题(「纪念邮票」题签 + 两侧引线)',
        `正中题签条上墨色像素 ${s.title.cnt} 个  bbox ${s.title.x},${s.title.y} ${s.title.w}×${s.title.h}`, '> 40 个');
    const headerInside = s.header.x > F.x + 2 && s.header.x + s.header.w < F.x + F.w - 2 && s.header.y > F.y + 2 && s.header.y + s.header.h < F.y + F.h - 2;
    line(headerInside, '⑪ 顶部票题完整在票面内(没被齿孔咬到 / 没出界)',
        `票题 bbox ${s.header.x}..${s.header.x + s.header.w} × ${s.header.y}..${s.header.y + s.header.h} / 票面 ${F.x}..${F.x + F.w} × ${F.y}..${F.y + F.h}`,
        '票题 bbox ⊂ 票面 rect');
    line(s.footer.cnt > 200, '⑫ 底部排版有内容(日期/地点/细线)',
        `底部墨色像素 ${s.footer.cnt} 个  bbox ${s.footer.x},${s.footer.y} ${s.footer.w}×${s.footer.h}`, '> 200 个');
    const inSafe = (b, sf) => b.x >= sf.x1 - 1 && b.x + b.w <= sf.x2 + 1 && b.y >= sf.y1 - 1 && b.y + b.h <= sf.y2 + 1;
    line(inSafe(s.footer, s.safe) && s.footer.w > s.face.w * 0.7,
        '⑬ 底部排版整体落在照片下方的票面安全区内(避开齿孔),且分隔线横贯票面',
        `底部 bbox ${s.footer.x}..${s.footer.x + s.footer.w} × ${s.footer.y}..${s.footer.y + s.footer.h} / 安全区 ${s.safe.x1}..${s.safe.x2} × ${s.safe.y1}..${s.safe.y2} / 票面宽 ${s.face.w}`,
        '底部 bbox ⊂ 安全区 且 跨宽 > 票面宽×0.7');

    // ── D) 带签名+头像时也成立 ──
    const s2 = await win.webContents.executeJavaScript(SEAL_SCAN(preset('红章纪念邮票'), 'A.template.userSignature = "— my memory —"; A.template.avatarShow = 1;', true));
    const inPhoto2 = s2.red.n > 0 && s2.red.minX > s2.photo.x && s2.red.maxX < s2.photo.x + s2.photo.w && s2.red.minY > s2.photo.y && s2.red.maxY < s2.photo.y + s2.photo.h;
    const gap2 = (() => { let t = 0; for (let k = B(0.52); k < B(0.65); k++) t += s2.buckets[k]; return t; })();
    line(inPhoto2 && gap2 === 0, '⑭ 有签名+头像时:章仍完整在照片内且圈带仍干净',
        `章 bbox ${s2.red.minX}..${s2.red.maxX} × ${s2.red.minY}..${s2.red.maxY} / 照片 ${s2.photo.x}..${s2.photo.x + s2.photo.w} × ${s2.photo.y}..${s2.photo.y + s2.photo.h}; 圈带空白区红像素 ${gap2}`,
        '章 ⊂ 照片 且 空白区 0');
    const footIn2 = inSafe(s2.footer, s2.safe);
    line(footIn2 && s2.footer.cnt > 200, '⑮ 有签名+头像时:底部一组(日期+签名+头像)仍在票面安全区内',
        `底部 bbox ${s2.footer.x}..${s2.footer.x + s2.footer.w} × ${s2.footer.y}..${s2.footer.y + s2.footer.h} / 安全区 ${s2.safe.x1}..${s2.safe.x2} × ${s2.safe.y1}..${s2.safe.y2}`,
        '底部 bbox ⊂ 安全区');
    console.log(`       [诊断] 字距 letterSpacing: '0px' 宽 ${s2.lsTest.w0}px, '9px' 宽 ${s2.lsTest.w1}px, 数字 9 宽 ${s2.lsTest.wn}px → 字符串形式${s2.lsTest.w1 > s2.lsTest.w0 ? '生效' : '未生效'}, 数字形式${s2.lsTest.wn > s2.lsTest.w0 ? '生效' : '被忽略'}`);
    line(s2.avatar.n > 0 && s2.avatar.minY > s2.photo.y + s2.photo.h - 2 && s2.avatar.maxY < s2.face.y + s2.face.h - 2,
        '⑯ 头像圆出现在底栏内(没跑到照片上/没出票面)',
        `头像像素 ${s2.avatar.n} 个  y ${s2.avatar.minY}..${s2.avatar.maxY} / 照片下沿 ${s2.photo.y + s2.photo.h} / 票面下沿 ${s2.face.y + s2.face.h}`,
        `照片下沿 < 头像 y ⊂ 票面`);

    // ── E) 稳定性:同一输入两次渲染必须逐像素一致(不许有 Math.random 造成的闪动),
    //        且必须与前面 A 段测到的同一预设指纹一致(证明中间的头像/日期冻结等状态没有残留污染) ──
    const a1 = await win.webContents.executeJavaScript(MEASURE(preset('红章纪念邮票')));
    const a2 = await win.webContents.executeJavaScript(MEASURE(preset('红章纪念邮票')));
    line(a1.fp === a2.fp && a1.fp === oldRed.fp, '⑰ 反复渲染稳定,且与 A 段同一预设指纹一致(无残留状态污染 / 颗粒不闪)',
        `第一次 ${a1.fp} / 第二次 ${a2.fp} / A 段 ${oldRed.fp}  (${a1.W}x${a1.H})`, '三者一致');

    console.log('─'.repeat(94));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 ${total} 项通过`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
