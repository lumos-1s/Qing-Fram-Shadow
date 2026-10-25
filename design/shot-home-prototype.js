'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const OUT = path.join(process.env.TEMP || '.', 'qingframe-home-proto');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#0E1110',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    win.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) console.log('CONSOLE', level, message);
    });

    await win.loadFile(path.join(ROOT, 'design', 'home-prototype.html'));
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

    const exec = (expr) => win.webContents.executeJavaScript(expr);
    const resize = async (width, height) => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            win.setContentSize(width, height);
            await sleep(200);
            const [w, h] = win.getContentSize();
            if (Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2) return;
        }
    };
    const state = () => exec(`(() => ({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        mode: document.getElementById('detailStage').dataset.mode,
        detail: !document.getElementById('detail').hidden,
        active: document.querySelector('#rail .look-card.is-active')?.dataset.id,
        progress: document.getElementById('progressNow').textContent
    }))()`);
    const shot = async (name) => {
        await exec(`document.getElementById('toast').classList.remove('is-on'); true`);
        await sleep(320);
        const image = await win.webContents.capturePage();
        const file = path.join(OUT, `${name}.png`);
        fs.writeFileSync(file, image.toPNG());
        console.log('SHOT', path.basename(file), JSON.stringify(await state()));
    };

    win.showInactive();
    await resize(1400, 900);
    await sleep(900);
    await exec(`document.documentElement.classList.add('dark'); localStorage.setItem('qf_home_theme', 'dark'); true`);
    await sleep(300);

    await shot('01-dark-1400x900');

    await exec(`document.getElementById('viewToggle').click(); true`);
    await sleep(700);
    await shot('02-grid-dark-1400x900');

    await exec(`document.getElementById('viewToggle').click(); true`);
    await sleep(700);
    await exec(`document.querySelector('.look-card.is-active .look-hit').click(); true`);
    await sleep(800);
    await shot('03-detail-dark-1400x900');

    await exec(`document.getElementById('detailZoom').click(); true`);
    await sleep(700);
    await shot('04-detail-zoom-dark-1400x900');
    await exec(`document.getElementById('detailClose').click(); true`);
    await sleep(700);

    await exec(`document.querySelector('.seg-btn[data-mode="mine"]').click(); true`);
    await sleep(800);
    await shot('05-mine-dark-1400x900');

    await exec(`document.querySelector('.seg-btn[data-mode="sample"]').click(); true`);
    await sleep(500);
    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(800);
    await shot('06-light-1400x900');

    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(700);

    await resize(1000, 640);
    await sleep(500);
    await exec(`window.scrollTo(0, 0); true`);
    await sleep(400);
    await shot('07-dark-1000x640');

    await resize(1400, 900);
    await sleep(500);
    await exec(`document.querySelectorAll('.chip')[1].click(); true`);
    await sleep(700);
    await shot('08-filter-dark-1400x900');

    await exec(`document.querySelectorAll('.chip')[0].click(); true`);
    await sleep(600);
    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(800);
    await exec(`document.querySelector('#rail .look-card.is-active .look-hit').click(); true`);
    await sleep(800);
    await shot('09-detail-light-1400x900');
    await exec(`document.getElementById('detailClose').click(); true`);
    await sleep(600);

    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(700);
    await exec(`window.scrollTo(0, document.body.scrollHeight); true`);
    await sleep(600);
    await shot('10-recent-dark-1400x900');

    win.destroy();
    app.quit();
}

app.whenReady().then(main).catch((err) => {
    console.error(err);
    app.exit(1);
});
