(() => {
    'use strict';

    const DATA = window.HOME_PROTOTYPE;
    if (!DATA || !Array.isArray(DATA.items)) return;

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const pad2 = (n) => String(n).padStart(2, '0');
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`;

    const CATEGORY_EN = {
        portrait: 'PORTRAIT',
        travel: 'TRAVEL',
        film: 'FILM',
        minimal: 'MINIMAL',
        magazine: 'EDITORIAL',
        retro: 'RETRO',
        art: 'ART'
    };

    const TAGS = {
        gallery: ['展览', '作品集', '留白'],
        'torn-film': ['街头', '旅行', '纪实'],
        newspaper: ['城市', '纪实', '旧报纸'],
        polaroid: ['日常', '人像', '手写'],
        'vintage-line': ['复古', '双线', '1970s'],
        'album-corners': ['家庭', '纪念', '相册'],
        vhs: ['夜景', '派对', '录像带'],
        magazine: ['人像', '时尚', '刊头'],
        'minimal-line': ['极简', '静物', '细线'],
        cinema: ['风景', '叙事', '宽银幕'],
        cyanotype: ['植物', '建筑', '蓝晒'],
        gold: ['纪念', '礼物', '金箔']
    };

    const THEME_KEY = 'qf_home_theme';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const items = DATA.items;
    const categories = DATA.categories;

    const el = {
        app: $('#app'),
        main: $('#main'),
        brandHome: $('#brandHome'),
        workbenchBtn: $('#workbenchBtn'),
        themeBtn: $('#themeBtn'),
        settingsBtn: $('#settingsBtn'),
        aboutBtn: $('#aboutBtn'),
        heroCount: $('#heroCount'),
        pickPhotoBtn: $('#pickPhotoBtn'),
        pickFolderBtn: $('#pickFolderBtn'),
        resumeBtn: $('#resumeBtn'),
        recentPickBtn: $('#recentPickBtn'),
        styleCount: $('#styleCount'),
        chips: $('#chips'),
        modeHint: $('#modeHint'),
        viewToggle: $('#viewToggle'),
        railNav: $('#railNav'),
        toolDivider: $('#toolDivider'),
        railWrap: $('#railWrap'),
        rail: $('#rail'),
        railEmpty: $('#railEmpty'),
        progressNow: $('#progressNow'),
        progressTotal: $('#progressTotal'),
        prevBtn: $('#prevBtn'),
        nextBtn: $('#nextBtn'),
        gridWrap: $('#gridWrap'),
        grid: $('#grid'),
        gridCount: $('#gridCount'),
        detail: $('#detail'),
        detailStage: $('#detailStage'),
        detailSample: $('#detailSample'),
        detailMine: $('#detailMine'),
        detailClose: $('#detailClose'),
        detailPrev: $('#detailPrev'),
        detailNext: $('#detailNext'),
        detailIndex: $('#detailIndex'),
        detailCategory: $('#detailCategory'),
        detailTitle: $('#detailTitle'),
        detailDesc: $('#detailDesc'),
        detailTags: $('#detailTags'),
        detailPreset: $('#detailPreset'),
        detailSize: $('#detailSize'),
        detailCategoryCode: $('#detailCategoryCode'),
        detailUse: $('#detailUse'),
        detailZoom: $('#detailZoom'),
        toast: $('#toast'),
        toastText: $('#toastText'),
        filePicker: $('#filePicker')
    };

    const state = {
        mode: 'sample',
        category: 'all',
        view: 'rail',
        activeIndex: 1,
        detailIndex: 0,
        detailOpen: false,
        zoom: false,
        lastFocus: null,
        toastTimer: 0,
        suppressClick: false,
        dragActive: false
    };

    const preloaded = new Set();
    let railScrollRaf = 0;
    let drag = null;
    let resizeTimer = 0;

    const matchesCategory = (item, cat) => {
        if (cat === 'all') return true;
        if (Array.isArray(item.categories) && item.categories.length) {
            return item.categories.includes(cat);
        }
        return item.category === cat;
    };

    const getVisible = () => items.filter((item) => matchesCategory(item, state.category));

    const getItem = (id) => items.find((item) => item.id === id) || null;

    function preload(src) {
        if (!src || preloaded.has(src)) return;
        preloaded.add(src);
        const img = new Image();
        img.src = src;
    }

    function preloadNeighbors(list, index) {
        [list[index - 1], list[index + 1]].forEach((item) => {
            if (!item) return;
            preload(item.coverSample);
            preload(item.coverMine);
        });
    }

    /* ── 分类 ── */
    function renderChips() {
        el.chips.innerHTML = '';
        categories.forEach((cat) => {
            const count = cat.id === 'all'
                ? items.length
                : items.filter((item) => matchesCategory(item, cat.id)).length;
            const btn = document.createElement('button');
            const on = state.category === cat.id;
            btn.type = 'button';
            btn.className = `chip${on ? ' is-on' : ''}`;
            btn.dataset.cat = cat.id;
            btn.setAttribute('aria-pressed', String(on));
            btn.innerHTML = `<span>${esc(cat.name)}</span><span class="chip-count">${count}</span>`;
            btn.addEventListener('click', () => setCategory(cat.id));
            el.chips.append(btn);
        });
    }

    function setCategory(cat) {
        if (state.category === cat) return;
        state.category = cat;
        state.activeIndex = 0;
        renderChips();
        updateMeta();
        if (state.view === 'grid') renderGrid(getVisible());
        else renderRail(getVisible());
    }

    /* ── 卡片 ── */
    function createCard(item, index, { grid = false } = {}) {
        const article = document.createElement('article');
        article.className = 'look-card';
        article.dataset.id = item.id;
        article.dataset.mode = state.mode;
        article.setAttribute('role', 'listitem');
        article.innerHTML = `
            <div class="look-mat">
                <span class="look-index">${pad2(index + 1)}</span>
                <div class="look-media">
                    <img data-role="sample" src="${esc(item.coverSample)}" alt="示例成片：${esc(item.title)}" draggable="false" decoding="async">
                    <img data-role="mine" src="${esc(item.coverMine)}" alt="我的照片预览：${esc(item.title)}" draggable="false" decoding="async" loading="lazy">
                </div>
                <button class="look-hit" type="button" aria-label="${grid ? '查看' : '选择'}「${esc(item.title)}」${grid ? '详情' : ''}"></button>
            </div>
            <div class="look-meta">
                <div class="look-title-row">
                    <h3 class="look-title">${esc(item.title)}</h3>
                    <span class="look-cat">${esc(item.categoryName)}</span>
                </div>
                <p class="look-desc">${esc(item.desc)}</p>
                <button class="look-use" type="button">${icon('i-arrow-up-right')}<span>用我的照片试穿</span></button>
            </div>
        `;

        const hit = $('.look-hit', article);
        const use = $('.look-use', article);

        if (grid) {
            hit.addEventListener('click', () => openDetail(item.id));
            use.addEventListener('click', () => openDetail(item.id));
        } else {
            hit.addEventListener('click', () => {
                if (state.suppressClick) return;
                const idx = getVisible().findIndex((x) => x.id === item.id);
                if (idx < 0) return;
                if (idx === state.activeIndex) openDetail(item.id);
                else setActive(idx, { scroll: true });
            });
            use.addEventListener('click', () => {
                if (state.suppressClick) return;
                openDetail(item.id);
            });
        }

        return article;
    }

    /* ── 看片台 ── */
    function renderRail(list) {
        el.rail.innerHTML = '';
        const empty = list.length === 0;
        el.railEmpty.hidden = !empty;
        el.rail.hidden = empty;
        if (empty) {
            el.progressNow.textContent = '00';
            el.progressTotal.textContent = '00';
            el.prevBtn.disabled = true;
            el.nextBtn.disabled = true;
            return;
        }

        list.forEach((item, index) => el.rail.append(createCard(item, index)));
        state.activeIndex = Math.max(0, Math.min(state.activeIndex, list.length - 1));

        requestAnimationFrame(() => {
            updateRailPadding();
            setActive(state.activeIndex, { force: true });
            scrollToIndex(state.activeIndex, false);
        });
    }

    function updateRailPadding() {
        const card = $('.look-card', el.rail);
        if (!card) return;
        const pad = Math.max(0, (el.rail.clientWidth - card.offsetWidth) / 2);
        el.rail.style.setProperty('--rail-pad', `${pad}px`);
    }

    function scrollToIndex(index, smooth) {
        const cards = $$('.look-card', el.rail);
        const card = cards[index];
        if (!card) return;
        const left = card.offsetLeft - (el.rail.clientWidth - card.offsetWidth) / 2;
        el.rail.scrollTo({
            left: Math.max(0, left),
            behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto'
        });
    }

    function setActive(index, { scroll = false, force = false } = {}) {
        const list = getVisible();
        if (!list.length) return;
        const next = Math.max(0, Math.min(index, list.length - 1));
        const changed = next !== state.activeIndex;
        state.activeIndex = next;

        $$('.look-card', el.rail).forEach((card, i) => {
            const on = i === next;
            card.classList.toggle('is-active', on);
            card.setAttribute('aria-current', on ? 'true' : 'false');
        });

        el.progressNow.textContent = pad2(next + 1);
        el.progressTotal.textContent = pad2(list.length);
        el.prevBtn.disabled = next <= 0;
        el.nextBtn.disabled = next >= list.length - 1;

        if (scroll && (changed || force)) scrollToIndex(next, true);
    }

    function onRailScroll() {
        if (state.view !== 'rail' || state.dragActive) return;
        if (railScrollRaf) return;
        railScrollRaf = requestAnimationFrame(() => {
            railScrollRaf = 0;
            if (state.dragActive) return;
            const cards = $$('.look-card', el.rail);
            if (!cards.length) return;
            const center = el.rail.scrollLeft + el.rail.clientWidth / 2;
            let best = 0;
            let bestDist = Infinity;
            cards.forEach((card, i) => {
                const cardCenter = card.offsetLeft + card.offsetWidth / 2;
                const dist = Math.abs(cardCenter - center);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = i;
                }
            });
            if (best !== state.activeIndex) setActive(best);
        });
    }

    function nearestIndex() {
        const cards = $$('.look-card', el.rail);
        if (!cards.length) return 0;
        const center = el.rail.scrollLeft + el.rail.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        cards.forEach((card, i) => {
            const cardCenter = card.offsetLeft + card.offsetWidth / 2;
            const dist = Math.abs(cardCenter - center);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        });
        return best;
    }

    /* ── 网格 ── */
    function renderGrid(list) {
        el.grid.innerHTML = '';
        if (!list.length) {
            el.grid.innerHTML = `
                <div class="rail-empty" style="grid-column:1/-1">
                    ${icon('i-photo-stack')}
                    <b>这个分类还没有风格</b>
                    <span>换一个分类看看</span>
                </div>
            `;
            return;
        }
        list.forEach((item, index) => el.grid.append(createCard(item, index, { grid: true })));
    }

    function setView(view) {
        state.view = view;
        const grid = view === 'grid';
        el.railWrap.hidden = grid;
        el.gridWrap.hidden = !grid;
        el.railNav.hidden = grid;
        el.toolDivider.hidden = grid;
        el.viewToggle.setAttribute('aria-pressed', String(grid));
        el.viewToggle.innerHTML = grid
            ? `${icon('i-rail')}<span>返回看片台</span>`
            : `${icon('i-grid')}<span>查看全部</span>`;
        refreshHint();

        if (grid) renderGrid(getVisible());
        else renderRail(getVisible());
    }

    function refreshHint() {
        const browse = state.view === 'rail' ? '拖动或 ← → 浏览' : '点击成片查看详情';
        el.modeHint.textContent = `${state.mode === 'sample' ? '内置样片' : '同一张照片'} · ${browse}`;
    }

    function updateMeta() {
        const list = getVisible();
        el.styleCount.textContent = String(list.length);
        el.progressTotal.textContent = pad2(list.length);
        el.gridCount.textContent = `${list.length} 个风格`;
        el.heroCount.textContent = `${items.length} 种精选风格`;
        refreshHint();
    }

    /* ── 预览模式 ── */
    function setMode(mode) {
        state.mode = mode === 'mine' ? 'mine' : 'sample';
        $$('.seg-btn[data-mode]').forEach((btn) => {
            const on = btn.dataset.mode === state.mode;
            btn.classList.toggle('is-on', on);
            btn.setAttribute('aria-pressed', String(on));
        });
        $$('.look-card').forEach((card) => {
            card.dataset.mode = state.mode;
        });
        el.detailStage.dataset.mode = state.mode;
        refreshHint();
        if (state.detailOpen) updateDetailSize();
    }

    function updateDetailSize() {
        const list = getVisible();
        const item = list[state.detailIndex];
        if (!item) return;
        const w = state.mode === 'mine' ? item.mineW : item.sampleW;
        const h = state.mode === 'mine' ? item.mineH : item.sampleH;
        el.detailSize.textContent = `${w} × ${h}`;
    }

    /* ── 详情 ── */
    function updateDetail() {
        const list = getVisible();
        const item = list[state.detailIndex];
        if (!item) return;

        el.detailStage.dataset.mode = state.mode;
        el.detailSample.src = item.coverSample;
        el.detailSample.alt = `示例成片：${item.title}`;
        el.detailMine.src = item.coverMine;
        el.detailMine.alt = `我的照片预览：${item.title}`;

        el.detailCategory.textContent = `${item.categoryName} · ${CATEGORY_EN[item.category] || 'STYLE'}`;
        el.detailTitle.textContent = item.title;
        el.detailDesc.textContent = `${item.desc}。`;
        el.detailTags.innerHTML = (TAGS[item.id] || [])
            .map((tag) => `<span class="detail-tag">${esc(tag)}</span>`)
            .join('');
        el.detailPreset.textContent = item.preset;
        el.detailCategoryCode.textContent = item.category;
        el.detailIndex.textContent = `${pad2(state.detailIndex + 1)} / ${pad2(list.length)}`;
        el.detailPrev.disabled = state.detailIndex <= 0;
        el.detailNext.disabled = state.detailIndex >= list.length - 1;
        updateDetailSize();
        preloadNeighbors(list, state.detailIndex);
    }

    function openDetail(id) {
        const list = getVisible();
        const index = list.findIndex((item) => item.id === id);
        if (index < 0) return;

        state.detailIndex = index;
        const active = document.activeElement;
        const scope = state.view === 'grid' ? el.grid : el.rail;
        const fallback = scope.querySelector(`.look-card[data-id="${id}"] .look-hit`);
        state.lastFocus = active && active !== document.body && active !== document.documentElement
            ? active
            : (fallback || active);
        state.detailOpen = true;
        el.detail.hidden = false;
        setZoom(false);
        el.app.setAttribute('inert', '');
        document.body.classList.add('is-locked');
        updateDetail();

        requestAnimationFrame(() => {
            el.detailClose.focus({ preventScroll: true });
        });
    }

    function closeDetail() {
        if (!state.detailOpen) return;
        state.detailOpen = false;
        setZoom(false);
        el.detail.hidden = true;
        el.app.removeAttribute('inert');
        document.body.classList.remove('is-locked');

        if (state.view === 'rail') {
            setActive(state.detailIndex, { scroll: true, force: true });
        }

        const focusTarget = state.lastFocus;
        state.lastFocus = null;
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus({ preventScroll: true });
        }
    }

    function goDetail(delta) {
        const list = getVisible();
        const next = state.detailIndex + delta;
        if (next < 0 || next >= list.length) return;
        state.detailIndex = next;
        updateDetail();
    }

    function setZoom(on) {
        state.zoom = Boolean(on);
        el.detail.classList.toggle('is-zoom', state.zoom);
        const label = el.detailZoom.querySelector('span');
        if (label) label.textContent = state.zoom ? '退出大图' : '查看大图';
    }

    function trapFocus(event) {
        const focusables = $$('button:not(:disabled), [href], input:not([hidden]), [tabindex]:not([tabindex="-1"])', el.detail)
            .filter((node) => node.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /* ── Toast ── */
    function showToast(text) {
        el.toastText.textContent = text;
        el.toast.classList.add('is-on');
        clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => {
            el.toast.classList.remove('is-on');
        }, 2800);
    }

    /* ── 主题 ── */
    function applyTheme(theme) {
        const dark = theme !== 'light';
        document.documentElement.classList.toggle('dark', dark);
        el.themeBtn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
        el.themeBtn.title = dark ? '切换到浅色主题' : '切换到深色主题';
        try {
            localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
        } catch (err) { /* 忽略本地存储不可用 */ }
    }

    /* ── 事件 ── */
    function bindEvents() {
        el.chips.addEventListener('click', (event) => {
            const chip = event.target.closest('.chip');
            if (chip) setCategory(chip.dataset.cat);
        });

        el.viewToggle.addEventListener('click', () => {
            setView(state.view === 'rail' ? 'grid' : 'rail');
        });

        el.prevBtn.addEventListener('click', () => {
            setActive(state.activeIndex - 1, { scroll: true });
        });
        el.nextBtn.addEventListener('click', () => {
            setActive(state.activeIndex + 1, { scroll: true });
        });

        el.rail.addEventListener('scroll', onRailScroll, { passive: true });

        el.rail.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const onButton = event.target.closest('button');
            if (onButton && !onButton.classList.contains('look-hit')) return;
            drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startLeft: el.rail.scrollLeft,
                moved: false
            };
            state.dragActive = true;
            el.rail.classList.add('is-dragging');
        });

        window.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const dx = event.clientX - drag.startX;
            if (Math.abs(dx) > 5) drag.moved = true;
            el.rail.scrollLeft = drag.startLeft - dx;
        });

        const endDrag = (event) => {
            if (!drag || (event && event.pointerId !== drag.pointerId)) return;
            const moved = drag.moved;
            drag = null;
            state.dragActive = false;
            el.rail.classList.remove('is-dragging');
            if (!moved) return;
            state.suppressClick = true;
            window.setTimeout(() => {
                state.suppressClick = false;
            }, 0);
            setActive(nearestIndex(), { scroll: true, force: true });
        };
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);

        el.rail.addEventListener('click', (event) => {
            if (!state.suppressClick) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);

        $$('.seg-btn[data-mode]').forEach((btn) => {
            btn.addEventListener('click', () => setMode(btn.dataset.mode));
        });

        el.detailClose.addEventListener('click', closeDetail);
        el.detail.addEventListener('click', (event) => {
            if (event.target.closest('[data-close-detail]')) closeDetail();
        });
        el.detailPrev.addEventListener('click', () => goDetail(-1));
        el.detailNext.addEventListener('click', () => goDetail(1));
        el.detailZoom.addEventListener('click', () => setZoom(!state.zoom));
        el.detailUse.addEventListener('click', () => {
            const item = getVisible()[state.detailIndex];
            if (!item) return;
            closeDetail();
            showToast(`已选择「${item.title}」— 接入后会套用到你的照片并进入编辑`);
        });

        el.themeBtn.addEventListener('click', () => {
            const dark = document.documentElement.classList.contains('dark');
            applyTheme(dark ? 'light' : 'dark');
            showToast(dark ? '已切换到浅色主题' : '已切换到深色主题');
        });

        el.pickPhotoBtn.addEventListener('click', () => el.filePicker.click());
        el.recentPickBtn.addEventListener('click', () => el.filePicker.click());
        el.pickFolderBtn.addEventListener('click', () => {
            showToast('静态原型：接入后会打开文件夹选择器');
        });
        el.filePicker.addEventListener('change', () => {
            const file = el.filePicker.files && el.filePicker.files[0];
            if (file) {
                showToast(`已选择「${file.name}」— 静态原型不会真正加框`);
            }
            el.filePicker.value = '';
        });

        el.workbenchBtn.addEventListener('click', () => {
            showToast('静态原型：接入后会返回专业工作台');
        });
        el.settingsBtn.addEventListener('click', () => {
            showToast('静态原型：设置面板尚未接入');
        });
        el.aboutBtn.addEventListener('click', () => {
            showToast('清框影 · 看片台静态原型 v0.1.21');
        });
        el.brandHome.addEventListener('click', (event) => {
            event.preventDefault();
            window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        });

        document.addEventListener('keydown', (event) => {
            if (state.detailOpen) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    if (state.zoom) setZoom(false);
                    else closeDetail();
                    return;
                }
                if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    goDetail(-1);
                    return;
                }
                if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    goDetail(1);
                    return;
                }
                if (event.key === 'Tab') {
                    trapFocus(event);
                }
                return;
            }

            if (state.view !== 'rail') return;
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setActive(state.activeIndex - 1, { scroll: true });
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                setActive(state.activeIndex + 1, { scroll: true });
            } else if (event.key === 'Home') {
                event.preventDefault();
                setActive(0, { scroll: true });
            } else if (event.key === 'End') {
                event.preventDefault();
                setActive(getVisible().length - 1, { scroll: true });
            }
        });

        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                if (state.view !== 'rail') return;
                updateRailPadding();
                scrollToIndex(state.activeIndex, false);
            }, 120);
        });
    }

    /* ── 启动 ── */
    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem(THEME_KEY);
    } catch (err) { /* 忽略 */ }
    applyTheme(savedTheme === 'light' ? 'light' : 'dark');

    renderChips();
    updateMeta();
    renderRail(getVisible());
    bindEvents();
})();
