'use strict';
// 由 design/icon.svg 生成应用图标 src/main/icon.png(512×512,圆角外透明)。
//
// 图标只保留一份矢量源:窗口图标(BrowserWindow)、安装包/快捷方式(electron-builder win.icon)
// 都读这个 PNG。改完 SVG 跑一次 `npm run gen:icon` 即可,不用手工截图。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'design', 'icon.svg');
const OUT = path.join(ROOT, 'src', 'main', 'icon.png');
const SIZE = 512;

app.whenReady().then(async () => {
    const svg = fs.readFileSync(SRC, 'utf8');
    const win = new BrowserWindow({
        width: 600, height: 600, show: false,
        webPreferences: { contextIsolation: false, backgroundThrottling: false }
    });
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = () => res();
            img.onerror = () => rej(new Error('SVG 加载失败'));
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
        });
        const cv = document.createElement('canvas');
        cv.width = ${SIZE}; cv.height = ${SIZE};
        cv.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
        return cv.toDataURL('image/png');
    })()`);

    const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w !== SIZE || h !== SIZE) throw new Error(`生成的 PNG 尺寸不对:${w}x${h}`);
    fs.writeFileSync(OUT, buf);
    console.log(`已生成 ${path.relative(ROOT, OUT)}  ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB`);
    app.exit(0);
}).catch(e => { console.error('生成失败:', e && (e.message || e)); app.exit(1); });