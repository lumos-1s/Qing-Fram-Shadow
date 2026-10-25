'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

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
    await win.loadFile(path.join(ROOT, 'design', 'home-prototype.html'));

    const exec = (expr) => win.webContents.executeJavaScript(expr);
    const click = async (selector, wait = 350) => {
        await exec(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); return true; })()`);
        await sleep(wait);
    };
    const resize = async (width, height) => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            win.setContentSize(width, height);
            await sleep(200);
            const [w, h] = win.getContentSize();
            if (Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2) return;
        }
    };

    win.showInactive();
    await resize(1400, 900);
    await sleep(700);

    await exec(`document.documentElement.classList.add('dark'); document.querySelectorAll('.chip')[0].click(); true`);
    await sleep(600);

    let state = await exec(`(() => {
        const cards = [...document.querySelectorAll('#rail .look-card')];
        const active = document.querySelector('#rail .look-card.is-active');
        const mat = active && active.querySelector('.look-mat');
        const pick = document.getElementById('pickPhotoBtn').getBoundingClientRect();
        const samples = cards.map(c => c.querySelector('img[data-role="sample"]'));
        return {
            total: cards.length,
            activeId: active && active.dataset.id,
            activeIndex: cards.indexOf(active),
            progress: document.getElementById('progressNow').textContent,
            count: document.getElementById('styleCount').textContent,
            samplesLoaded: samples.every(img => img.complete && img.naturalWidth > 0),
            noHOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            pickVisible: pick.top >= 0 && pick.bottom <= window.innerHeight,
            matVisible: !!mat && mat.getBoundingClientRect().top < window.innerHeight && mat.getBoundingClientRect().bottom <= window.innerHeight + 1,
            railNavVisible: getComputedStyle(document.getElementById('railNav')).display !== 'none',
            viewLabel: document.querySelector('#viewToggle span').textContent
        };
    })()`);
    check(state.total === 12, '初始 12 张卡片', JSON.stringify(state));
    check(state.activeId === 'torn-film', '初始选中第二张', state.activeId);
    check(state.progress === '02', '初始进度 02', state.progress);
    check(state.samplesLoaded, '示例封面全部加载');
    check(state.noHOverflow, '1400×900 无横向溢出');
    check(state.pickVisible, '选择照片按钮首屏可见');
    check(state.matVisible, '当前卡片完整可见');
    check(state.railNavVisible, '看片台导航可见');
    check(state.viewLabel === '查看全部', '视图按钮初始文案', state.viewLabel);

    await click('.chip[data-cat="portrait"]', 700);
    state = await exec(`(() => ({
        cards: document.querySelectorAll('#rail .look-card').length,
        count: document.getElementById('styleCount').textContent,
        progress: document.getElementById('progressNow').textContent,
        active: document.querySelector('#rail .look-card.is-active')?.dataset.id,
        chipOn: document.querySelector('.chip.is-on')?.dataset.cat
    }))()`);
    check(state.cards === 4 && state.count === '4', '人像筛选为 4 张', JSON.stringify(state));
    check(state.chipOn === 'portrait', '人像分类高亮', state.chipOn);
    check(state.progress === '01', '筛选后回到第一张', state.progress);

    await click('.seg-btn[data-mode="mine"]', 600);
    state = await exec(`(() => {
        const cards = [...document.querySelectorAll('#rail .look-card')];
        const active = document.querySelector('#rail .look-card.is-active');
        const mine = active.querySelector('img[data-role="mine"]');
        const sample = active.querySelector('img[data-role="sample"]');
        return {
            modes: [...new Set(cards.map(c => c.dataset.mode))],
            mineOpacity: getComputedStyle(mine).opacity,
            sampleOpacity: getComputedStyle(sample).opacity,
            pressed: document.querySelector('.seg-btn[data-mode="mine"]').getAttribute('aria-pressed'),
            hint: document.getElementById('modeHint').textContent
        };
    })()`);
    check(state.modes.length === 1 && state.modes[0] === 'mine', '全部卡片切到我的照片', JSON.stringify(state.modes));
    check(state.mineOpacity === '1' && state.sampleOpacity === '0', '照片图层切换正确', `${state.mineOpacity}/${state.sampleOpacity}`);
    check(state.pressed === 'true', '我的照片按钮 aria-pressed');
    check(state.hint.includes('同一张照片'), '模式提示更新', state.hint);

    await click('.chip[data-cat="all"]', 600);
    await click('#nextBtn', 500);
    await click('#nextBtn', 700);
    state = await exec(`(() => ({
        active: document.querySelector('#rail .look-card.is-active')?.dataset.id,
        progress: document.getElementById('progressNow').textContent
    }))()`);
    check(state.active === 'newspaper' && state.progress === '03', '右箭头切到第三张', JSON.stringify(state));

    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
    await sleep(700);
    state = await exec(`(() => ({
        active: document.querySelector('#rail .look-card.is-active')?.dataset.id,
        progress: document.getElementById('progressNow').textContent
    }))()`);
    check(state.active === 'polaroid' && state.progress === '04', '键盘右箭头切到第四张', JSON.stringify(state));

    await click('#viewToggle', 500);
    state = await exec(`(() => ({
        gridHidden: document.getElementById('gridWrap').hidden,
        railHidden: document.getElementById('railWrap').hidden,
        navHidden: document.getElementById('railNav').hidden,
        navDisplay: getComputedStyle(document.getElementById('railNav')).display,
        gridCards: document.querySelectorAll('#grid .look-card').length,
        label: document.querySelector('#viewToggle span').textContent,
        hint: document.getElementById('modeHint').textContent
    }))()`);
    check(state.gridHidden === false && state.railHidden === true, '网格视图显示', JSON.stringify(state));
    check(state.navHidden === true && state.navDisplay === 'none', '网格模式隐藏左右箭头', state.navDisplay);
    check(state.gridCards === 12, '网格渲染 12 张', String(state.gridCards));
    check(state.label === '返回看片台', '网格按钮文案', state.label);
    check(state.hint.includes('点击成片'), '网格提示更新', state.hint);

    await click('#viewToggle', 600);
    await click('#rail .look-card.is-active .look-hit', 700);
    state = await exec(`(() => ({
        hidden: document.getElementById('detail').hidden,
        inert: document.getElementById('app').hasAttribute('inert'),
        title: document.getElementById('detailTitle').textContent,
        index: document.getElementById('detailIndex').textContent,
        focus: document.activeElement.id,
        mode: document.getElementById('detailStage').dataset.mode,
        prevDisabled: document.getElementById('detailPrev').disabled,
        nextDisabled: document.getElementById('detailNext').disabled
    }))()`);
    check(state.hidden === false && state.inert === true, '详情打开且主界面 inert', JSON.stringify(state));
    check(state.title === '拍立得手写' && state.index.startsWith('04'), '详情内容匹配当前卡片', `${state.title}/${state.index}`);
    check(state.focus === 'detailClose', '焦点进入关闭按钮', state.focus);
    check(state.mode === 'mine', '详情继承我的照片模式', state.mode);

    await click('#detailNext', 500);
    state = await exec(`(() => ({
        title: document.getElementById('detailTitle').textContent,
        index: document.getElementById('detailIndex').textContent
    }))()`);
    check(state.title === '复古双线' && state.index.startsWith('05'), '详情下一张', JSON.stringify(state));

    await click('#detailZoom', 500);
    state = await exec(`(() => ({
        zoom: document.getElementById('detail').classList.contains('is-zoom'),
        infoDisplay: getComputedStyle(document.querySelector('.detail-info')).display,
        label: document.querySelector('#detailZoom span').textContent
    }))()`);
    check(state.zoom === true && state.infoDisplay === 'none', '大图模式隐藏信息栏', JSON.stringify(state));
    check(state.label === '退出大图', '大图按钮文案', state.label);

    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(400);
    state = await exec(`(() => ({
        zoom: document.getElementById('detail').classList.contains('is-zoom'),
        hidden: document.getElementById('detail').hidden
    }))()`);
    check(state.zoom === false && state.hidden === false, 'Esc 先退出大图', JSON.stringify(state));

    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(500);
    state = await exec(`(() => ({
        hidden: document.getElementById('detail').hidden,
        inert: document.getElementById('app').hasAttribute('inert'),
        focusClass: document.activeElement.className
    }))()`);
    check(state.hidden === true && state.inert === false, 'Esc 关闭详情并恢复主界面', JSON.stringify(state));
    check(String(state.focusClass).includes('look-hit'), '焦点回到触发卡片', state.focusClass);

    await click('#rail .look-card.is-active .look-hit', 600);
    state = await exec(`(() => ({
        zoomLabel: document.querySelector('#detailZoom span').textContent,
        zoomClass: document.getElementById('detail').classList.contains('is-zoom')
    }))()`);
    check(state.zoomLabel === '查看大图' && state.zoomClass === false, '重新打开详情时重置大图状态', JSON.stringify(state));
    await click('#detailUse', 500);
    state = await exec(`(() => ({
        hidden: document.getElementById('detail').hidden,
        toast: document.getElementById('toast').classList.contains('is-on'),
        toastText: document.getElementById('toastText').textContent
    }))()`);
    check(state.hidden === true, '详情使用按钮关闭详情');
    check(state.toast === true && state.toastText.includes('已选择'), '使用按钮显示提示', state.toastText);

    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(500);
    state = await exec(`(() => ({
        dark: document.documentElement.classList.contains('dark'),
        stored: localStorage.getItem('qf_home_theme'),
        label: document.getElementById('themeBtn').getAttribute('aria-label')
    }))()`);
    check(state.dark === false && state.stored === 'light', '主题切换到浅色并持久化', JSON.stringify(state));
    check(state.label.includes('深色'), '主题按钮标签更新', state.label);

    await exec(`document.getElementById('themeBtn').click(); true`);
    await sleep(500);

    await resize(1000, 640);
    await sleep(500);
    await exec(`window.scrollTo(0, 0); true`);
    await sleep(300);
    state = await exec(`(() => {
        const pick = document.getElementById('pickPhotoBtn').getBoundingClientRect();
        const active = document.querySelector('#rail .look-card.is-active');
        const mat = active && active.querySelector('.look-mat');
        const title = active && active.querySelector('.look-title');
        return {
            w: window.innerWidth,
            h: window.innerHeight,
            noHOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            pickVisible: pick.top >= 0 && pick.bottom <= window.innerHeight,
            matTop: mat && mat.getBoundingClientRect().top,
            matBottom: mat && mat.getBoundingClientRect().bottom,
            titleTop: title && title.getBoundingClientRect().top,
            cardVisible: !!mat && mat.getBoundingClientRect().top < window.innerHeight,
            matFullyVisible: !!mat && mat.getBoundingClientRect().bottom <= window.innerHeight + 1
        };
    })()`);
    check(Math.abs(state.w - 1000) <= 2 && Math.abs(state.h - 640) <= 2, '窗口内容区约为 1000×640', `${state.w}×${state.h}`);
    check(state.noHOverflow, '1000×640 无横向溢出');
    check(state.pickVisible, '1000×640 选择照片首屏可见');
    check(state.cardVisible, '1000×640 至少一张成片可见', `matTop=${state.matTop}`);
    check(state.matFullyVisible, '1000×640 成片完整可见', `matBottom=${state.matBottom}`);
    check(state.titleTop < state.h, '1000×640 卡片标题可见', `titleTop=${state.titleTop}`);

    state = await exec(`(() => {
        const active = document.querySelector('#rail .look-card.is-active');
        const side = [...document.querySelectorAll('#rail .look-card')].find((card) => card !== active);
        const meta = side && side.querySelector('.look-meta');
        return { sideVisibility: meta ? getComputedStyle(meta).visibility : 'missing' };
    })()`);
    check(state.sideVisibility === 'hidden', '1000×640 非当前卡片隐藏文字', state.sideVisibility);

    await click('#viewToggle', 700);
    state = await exec(`(() => {
        const grid = document.getElementById('grid');
        const title = grid.querySelector('.look-title');
        const meta = title && title.closest('.look-meta');
        return {
            gridCards: grid.querySelectorAll('.look-card').length,
            titleVisible: !!title && !!meta && getComputedStyle(meta).visibility !== 'hidden' && title.getBoundingClientRect().height > 0,
            noHOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1
        };
    })()`);
    check(state.gridCards === 12 && state.titleVisible, '1000×640 网格仍显示标题', JSON.stringify(state));
    check(state.noHOverflow, '1000×640 网格无横向溢出');

    win.destroy();
    console.log('');
    console.log(failures.length ? `FAILED ${failures.length}` : 'ALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
