const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 800, height: 600 });
  await w.loadURL('data:text/html,<body>x</body>');
  const out = await w.webContents.executeJavaScript(`({
    p3: matchMedia('(color-gamut: p3)').matches,
    srgb: matchMedia('(color-gamut: srgb)').matches,
    rec2020: matchMedia('(color-gamut: rec2020)').matches,
    dpr: devicePixelRatio,
    screen: [screen.width, screen.height],
    depth: screen.colorDepth
  })`);
  console.log(JSON.stringify(out));
  app.quit();
});
