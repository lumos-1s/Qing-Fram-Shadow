'use strict';
// 用法：node tools/run-electron.js tools/make-mobile-splash.js
// 依赖已经生成好的 iOS 1024 图标（make-mobile-icons.js）。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const ICON = 'file:///' + path.join(ROOT, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png').replace(/\\/g, '/');
const TARGETS = [
    ['mobile/android/app/src/main/res/drawable/splash.png', 480, 320, 0.36],
    ['mobile/android/app/src/main/res/drawable-land-hdpi/splash.png', 800, 480, 0.32],
    ['mobile/android/app/src/main/res/drawable-land-mdpi/splash.png', 480, 320, 0.36],
    ['mobile/android/app/src/main/res/drawable-land-xhdpi/splash.png', 1280, 720, 0.28],
    ['mobile/android/app/src/main/res/drawable-land-xxhdpi/splash.png', 1600, 960, 0.26],
    ['mobile/android/app/src/main/res/drawable-land-xxxhdpi/splash.png', 1920, 1280, 0.24],
    ['mobile/android/app/src/main/res/drawable-port-hdpi/splash.png', 480, 800, 0.36],
    ['mobile/android/app/src/main/res/drawable-port-mdpi/splash.png', 320, 480, 0.42],
    ['mobile/android/app/src/main/res/drawable-port-xhdpi/splash.png', 720, 1280, 0.30],
    ['mobile/android/app/src/main/res/drawable-port-xxhdpi/splash.png', 960, 1600, 0.28],
    ['mobile/android/app/src/main/res/drawable-port-xxxhdpi/splash.png', 1280, 1920, 0.26],
    ['mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', 2732, 2732, 0.22],
    ['mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png', 2732, 2732, 0.22],
    ['mobile/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png', 2732, 2732, 0.22]
];

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, webSecurity: false } });
    await win.loadURL('data:text/html,<meta charset="utf-8">');
    const out = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(ICON)}; });
        return ${JSON.stringify(TARGETS)}.map(([file, w, h, k]) => {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const g = c.getContext('2d');
            g.fillStyle = '#0B0C0B';
            g.fillRect(0, 0, w, h);
            const s = Math.round(Math.min(w, h) * k);
            const x = Math.round((w - s) / 2), y = Math.round((h - s) / 2);
            // 圆角 + 一点点投影：让启动图里是一块「应用图标」而不是一张硬方块
            const r = s * 0.225;
            g.save();
            g.shadowColor = 'rgba(0,0,0,.5)';
            g.shadowBlur = s * 0.07;
            g.shadowOffsetY = s * 0.02;
            g.beginPath();
            g.moveTo(x + r, y);
            g.lineTo(x + s - r, y); g.quadraticCurveTo(x + s, y, x + s, y + r);
            g.lineTo(x + s, y + s - r); g.quadraticCurveTo(x + s, y + s, x + s - r, y + s);
            g.lineTo(x + r, y + s); g.quadraticCurveTo(x, y + s, x, y + s - r);
            g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
            g.closePath();
            g.clip();
            g.drawImage(img, x, y, s, s);
            g.restore();
            return { file, data: c.toDataURL('image/png') };
        });
    })()`);
    for (const item of out) {
        const file = path.join(ROOT, item.file);
        fs.writeFileSync(file, Buffer.from(item.data.split(',')[1], 'base64'));
    }
    console.log('splash done', out.length);
    app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
