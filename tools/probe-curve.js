// 直接读 QfsCurve 构建的点曲线 LUT，与 XMP 的控制点对照
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// XMP 里的 ToneCurvePV2012 原始控制点
const PTS = [[0, 0], [17, 26], [34, 44], [51, 60], [68, 74], [85, 89], [102, 105], [119, 120],
    [136, 135], [153, 151], [170, 167], [187, 183], [204, 200], [221, 218], [238, 236], [255, 255]];

app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, width: 800, height: 600,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false } });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 60; i++) {
        if (await w.webContents.executeJavaScript('!!window.QfsCurve')) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    const out = await w.webContents.executeJavaScript(`(() => {
        const pts = ${JSON.stringify(PTS)};
        const curve = { rgb: pts.map((p) => [p[0] / 255, p[1] / 255]) };
        const luts = window.QfsCurve.buildCurveLuts(curve);
        const lut = luts.r;
        return Array.from(lut).map((v) => Math.round((v > 1 ? v / 255 : v) * 255));
    })()`);
    console.log('输入 → 输出（QfsCurve）          期望（控制点直读）');
    for (const [x, y] of PTS) console.log(String(x).padStart(4), '→', String(out[x]).padStart(4), '            ', y);
    app.quit();
}).catch((e) => { console.error(e); app.quit(); });
