'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// 用法：node tools/run-electron.js tools/make-mobile-icons.js [源图]
// 默认读仓库里的 mobile/assets/icon-source.jpg，换图标只要替换这张图重跑。
// Electron 的 argv 里混着 Chromium 开关和脚本路径，只认“像图片”的那个参数
const argSrc = process.argv.slice(2).find((a) => /\.(jpe?g|png)$/i.test(a));
const SRC = argSrc ? path.resolve(argSrc)
    : path.resolve(__dirname, '..', 'mobile', 'assets', 'icon-source.jpg');
const ROOT = path.resolve(__dirname, '..');
const ANDROID = path.join(ROOT, 'mobile/android/app/src/main/res');
const IOS = path.join(ROOT, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset');
const WEB = path.join(ROOT, 'mobile/www/img');

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

function writePng(dir, name, dataUrl) {
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(dataUrl).split(',')[1];
    fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 200, height: 200, show: false,
        webPreferences: { offscreen: true, webSecurity: false } });
    await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>');
    const exec = (x) => win.webContents.executeJavaScript(x, true);

    const out = await exec(`(async () => {
        const src = ${JSON.stringify('file:///' + SRC.replace(/\\/g, '/'))};
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
        const N = 1024;
        const base = document.createElement('canvas');
        base.width = N; base.height = N;
        const g = base.getContext('2d');
        g.drawImage(img, 0, 0, N, N);

        // 1) 量出画布里真正的图标边界（原图四周有 28px 白边）
        const px = g.getImageData(0, 0, N, N);
        const nearWhite = (k) => px.data[k] > 235 && px.data[k+1] > 235 && px.data[k+2] > 235;
        let minX = N, minY = N, maxX = -1, maxY = -1;
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                if (nearWhite((y * N + x) * 4)) continue;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
        const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        const at = (x, y) => { const k = (y * N + x) * 4; return [px.data[k], px.data[k+1], px.data[k+2]]; };
        // 2) 取图标内部的墨绿（避开四边，原图边缘有一圈高光）
        const picks = [at(160, 160), at(N - 160, 160), at(160, N - 160), at(N - 160, N - 160)];
        const green = [0, 1, 2].map((c) => Math.round(picks.reduce((s2, v) => s2 + v[c], 0) / picks.length));
        // 图标边缘自带一圈高光：自适应前景要缩到安全区，边缘和底色差一点就会露出方形接缝，
        // 所以单独采「边缘色」铺底，让缩放后的边界和背景连成一片
        const edgePicks = [
            at(512, box.y + 6), at(512, box.y + box.h - 6),
            at(box.x + 6, 512), at(box.x + box.w - 6, 512)
        ];
        const edgeGreen = [0, 1, 2].map((c) => Math.round(edgePicks.reduce((s2, v) => s2 + v[c], 0) / edgePicks.length));

        // 3) 裁到图标边界，再按「略小于原圆角」的圆角裁剪，白边和灰边一起切掉
        const flat = document.createElement('canvas');
        flat.width = N; flat.height = N;
        const fg = flat.getContext('2d');
        fg.fillStyle = 'rgb(' + green.join(',') + ')';
        fg.fillRect(0, 0, N, N);
        const r0 = N * 0.215, ins = 0;
        fg.beginPath();
        fg.moveTo(r0 + ins, ins);
        fg.lineTo(N - r0 - ins, ins);
        fg.quadraticCurveTo(N - ins, ins, N - ins, r0 + ins);
        fg.lineTo(N - ins, N - r0 - ins);
        fg.quadraticCurveTo(N - ins, N - ins, N - r0 - ins, N - ins);
        fg.lineTo(r0 + ins, N - ins);
        fg.quadraticCurveTo(ins, N - ins, ins, N - r0 - ins);
        fg.lineTo(ins, r0 + ins);
        fg.quadraticCurveTo(ins, ins, r0 + ins, ins);
        fg.closePath();
        fg.clip();
        // 再往里收 14px：原图圆角外沿有一圈 JPEG 灰边，贴着边界画会留一道白弧
        const pad = 30;
        fg.drawImage(img, box.x + pad, box.y + pad, box.w - pad * 2, box.h - pad * 2, 0, 0, N, N);
        const square = flat.toDataURL('image/png');

        // 后面各尺寸都从这张方形图缩放：先等它解码完，否则画出来是空白
        const squareImg = new Image();
        await new Promise((res, rej) => { squareImg.onload = res; squareImg.onerror = rej; squareImg.src = square; });

        const make = (size, mode) => {
            const c = document.createElement('canvas');
            c.width = size; c.height = size;
            const x = c.getContext('2d');
            if (mode === 'round') {
                x.beginPath(); x.arc(size/2, size/2, size/2, 0, Math.PI * 2); x.clip();
            } else if (mode === 'adaptive') {
                // 自适应图标：可见区只有 72/108，圆形遮罩会把金框四角切掉。
                // 背景先铺满同色墨绿，再把整块图标缩到 83% 居中，金框就落在安全圆内。
                x.fillStyle = 'rgb(' + edgeGreen.join(',') + ')';
                x.fillRect(0, 0, size, size);
                const s2 = Math.round(size * 0.77);
                x.drawImage(squareImg, Math.round((size - s2) / 2), Math.round((size - s2) / 2), s2, s2);
                return c.toDataURL('image/png');
            } else if (mode === 'rounded') {
                const r = size * 0.225;
                x.beginPath();
                x.moveTo(r, 0); x.lineTo(size - r, 0); x.quadraticCurveTo(size, 0, size, r);
                x.lineTo(size, size - r); x.quadraticCurveTo(size, size, size - r, size);
                x.lineTo(r, size); x.quadraticCurveTo(0, size, 0, size - r);
                x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0);
                x.closePath(); x.clip();
            }
            x.drawImage(squareImg, 0, 0, size, size);
            return c.toDataURL('image/png');
        };

        const shots = {};
        shots.ios1024 = square;
        shots.web512 = make(512, 'none');
        shots.fav32 = make(32, 'rounded');
        shots.touch180 = make(180, 'none');

        // 应用内品牌位：顶栏只有 28px，整张图标缩下去金框只剩 15px，
        // 这里把中间 74% 裁出来放大成一张「标记图」，细节才立得住
        const mark = document.createElement('canvas');
        mark.width = 256; mark.height = 256;
        const mg = mark.getContext('2d');
        const mc = Math.round(N * 0.74), mo = Math.round((N - mc) / 2);
        mg.drawImage(squareImg, mo, mo, mc, mc, 0, 0, 256, 256);
        shots.logomark = mark.toDataURL('image/png');

        // 应用内圆形头像：整枚图标缩到圆内，金框四角不会被圆形裁掉
        const av = document.createElement('canvas');
        av.width = 256; av.height = 256;
        const ag = av.getContext('2d');
        ag.beginPath(); ag.arc(128, 128, 128, 0, Math.PI * 2); ag.clip();
        ag.fillStyle = 'rgb(' + green.join(',') + ')';
        ag.fillRect(0, 0, 256, 256);
        const avs = Math.round(256 * 0.76), avo = Math.round((256 - avs) / 2);
        ag.drawImage(squareImg, avo, avo, avs, avs);
        shots.avatar = av.toDataURL('image/png');
        Object.keys(${JSON.stringify(DENSITIES)}).forEach((d) => {
            const k = ${JSON.stringify(DENSITIES)}[d];
            shots['legacy_' + d] = make(Math.round(48 * k), 'rounded');
            shots['round_' + d] = make(Math.round(48 * k), 'round');
            shots['fg_' + d] = make(Math.round(108 * k), 'adaptive');
        });
        return { green, shots };
    })()`);

    const greenHex = '#' + out.green.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    console.log('sampled background', greenHex);

    writePng(IOS, 'AppIcon-512@2x.png', out.shots.ios1024);
    // iOS 营销图不能带 alpha，canvas 出不了 RGB PNG，这里再转一次
    const stripAlpha = require('./png-strip-alpha');
    stripAlpha(path.join(IOS, 'AppIcon-512@2x.png'));
    writePng(WEB, 'icon-512.png', out.shots.web512);
    writePng(WEB, 'favicon-32.png', out.shots.fav32);
    writePng(WEB, 'apple-touch-icon-180.png', out.shots.touch180);
    writePng(WEB, 'logo-mark.png', out.shots.logomark);
    writePng(WEB, 'avatar.png', out.shots.avatar);
    Object.keys(DENSITIES).forEach((d) => {
        writePng(path.join(ANDROID, 'mipmap-' + d), 'ic_launcher.png', out.shots['legacy_' + d]);
        writePng(path.join(ANDROID, 'mipmap-' + d), 'ic_launcher_round.png', out.shots['round_' + d]);
        writePng(path.join(ANDROID, 'mipmap-' + d), 'ic_launcher_foreground.png', out.shots['fg_' + d]);
    });
    fs.writeFileSync(path.join(ANDROID, 'values/ic_launcher_background.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${greenHex}</color>
</resources>
`);
    console.log('done');
    app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
