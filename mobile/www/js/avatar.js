'use strict';
/* 手机版用户头像：本机存储 + 方形裁剪 + 供「签名 + 头像」系列风格叠加。
   桌面端同一套 key（qfs_user_avatar）与全局图（window.__qfsAvatarImg），
   这样导出时引擎就能在照片上画出用户头像。 */
(function () {
    const KEY = 'qfs_user_avatar';
    const AVATAR_DEFAULT = 'img/avatar.png';

    let onChange = () => {};
    let toast = () => {};
    let crop = null;          // { iw, ih, w, scale, min, max, x, y, img }
    let picking = false;

    function image() {
        return (typeof window.qfsImage === 'function') ? window.qfsImage() : new Image();
    }

    function setGlobal(dataUrl, done) {
        const im = image();
        im.onload = () => { window.__qfsAvatarImg = im; onChange(); if (done) done(im); };
        im.onerror = () => { window.__qfsAvatarImg = null; onChange(); if (done) done(null); };
        im.src = dataUrl;
    }

    // 启动时恢复：头像存在 localStorage，跨会话保留
    function load() {
        let saved = '';
        try { saved = localStorage.getItem(KEY) || ''; } catch (_) {}
        if (!saved) { window.__qfsAvatarImg = null; updateUI(); return; }
        // 图片解码是异步的，先让引擎用默认头像占位也没关系，解码完会重绘一次。
        setGlobal(saved, updateUI);
    }

    function hasAvatar() { return !!window.__qfsAvatarImg; }

    function displayName() {
        try { return localStorage.getItem('qfm_user_name') || ''; } catch (_) { return ''; }
    }

    function updateUI() {
        const img = document.getElementById('mineAvatarImg');
        const name = document.getElementById('mineAvatarName');
        const hint = document.getElementById('mineAvatarHint');
        const saved = hasAvatar();
        const nick = displayName();
        if (img) img.src = saved ? window.__qfsAvatarImg.src : AVATAR_DEFAULT;
        if (name) name.textContent = nick || (saved ? '我的头像' : '设置我的头像');
        if (hint) hint.textContent = saved
            ? '头像已启用 · 签名 + 头像风格自动使用'
            : (nick ? '昵称已设置 · 点这里上传头像' : '用于照片上的「签名 + 头像」风格');
    }

    function closeSheet() {
        const sheet = document.getElementById('avatarSheet');
        if (sheet) sheet.hidden = true;
    }

    // 选图：直接走 native 的 file input，拿到 canvas 后才开裁剪；
    // 不复用 importPhotos 的错误提示，头像这里只取第一张。
    async function pick() {
        if (picking) return;
        picking = true;
        try {
            const list = await window.qfsNative.pickImages();
            if (list && list.length) openCrop(list[0].el);
            else toast('没有选到照片，头像没变');
        } catch (e) {
            // 选图异常不打断主流程，但不能静默：否则点「设置头像」看起来像没反应
            toast('读取照片失败，换一张试试');
        } finally {
            picking = false;
        }
    }

    function openCrop(src) {
        const sheet = document.getElementById('avatarSheet');
        const stage = document.getElementById('avatarCropStage');
        const img = document.getElementById('avatarCropImg');
        const zoom = document.getElementById('avatarZoom');
        const zoomVal = document.getElementById('avatarZoomVal');
        if (!sheet || !stage || !img) return;
        sheet.hidden = false;
        stage.classList.remove('dragging');
        const w = stage.clientWidth || 300;
        const iw = src.naturalWidth || src.width || 1;
        const ih = src.naturalHeight || src.height || 1;
        const min = Math.max(w / iw, w / ih);   // cover：短边刚好铺满
        crop = { iw, ih, w, min, max: min * 4, scale: min, x: 0, y: 0 };

        const paint = () => {
            crop.x = Math.min(0, Math.max(crop.w - crop.iw * crop.scale, crop.x));
            crop.y = Math.min(0, Math.max(crop.w - crop.ih * crop.scale, crop.y));
            img.style.width = crop.iw * crop.scale + 'px';
            img.style.height = crop.ih * crop.scale + 'px';
            img.style.left = crop.x + 'px';
            img.style.top = crop.y + 'px';
            const pct = Math.round(crop.scale / crop.min * 100);
            if (zoom) zoom.value = String(Math.max(100, Math.min(400, pct)));
            if (zoomVal) zoomVal.textContent = pct + '%';
        };
        const zoomTo = (s2, ax, ay) => {
            s2 = Math.max(crop.min, Math.min(crop.max, s2));
            if (ax == null) { ax = crop.w / 2; ay = crop.w / 2; }
            const k = s2 / crop.scale;
            crop.x = ax - (ax - crop.x) * k;
            crop.y = ay - (ay - crop.y) * k;
            crop.scale = s2;
            paint();
        };
        const setup = () => {
            crop.w = stage.clientWidth || w;
            crop.scale = crop.min;
            crop.x = (crop.w - crop.iw * crop.scale) / 2;
            crop.y = (crop.w - crop.ih * crop.scale) / 2;
            paint();
        };
        img.onload = setup;
        img.onerror = () => { toast('这张照片读不出来，换一张试试'); closeSheet(); };
        // 只赋一次 src：先给空串会多触发一次无效加载，再被真正的内容覆盖。
        // 选图给的是 canvas，转成 dataURL 后续 getImageData 才不会 taint。
        let source = src && src.src;
        if (!source && src && src.getContext) {
            try { source = src.toDataURL('image/jpeg', 0.92); } catch (_) {}
        }
        if (!source) { toast('这张照片读不出来，换一张试试'); closeSheet(); return; }
        img.src = source;
        if (img.complete && img.naturalWidth) setup();

        img.onpointerdown = null;
        let drag = null;
        stage.onpointerdown = (e) => {
            if (e.button !== 0) return;
            drag = { x: e.clientX, y: e.clientY, ox: crop.x, oy: crop.y };
            stage.classList.add('dragging');
            try { stage.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        };
        stage.onpointermove = (e) => {
            if (!drag) return;
            crop.x = drag.ox + (e.clientX - drag.x);
            crop.y = drag.oy + (e.clientY - drag.y);
            paint();
        };
        const end = (e) => {
            if (!drag) return;
            drag = null;
            stage.classList.remove('dragging');
            try { if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        stage.onpointerup = end;
        stage.onpointercancel = end;
        stage.ondblclick = () => zoomTo(crop.min);
        stage.onwheel = (e) => {
            e.preventDefault();
            const r = stage.getBoundingClientRect();
            zoomTo(crop.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
        };
        if (zoom) zoom.oninput = () => zoomTo(crop.min * (Number(zoom.value) || 100) / 100);
    }

    function commit() {
        if (!crop || !crop.iw) return;
        const img = document.getElementById('avatarCropImg');
        if (!img || !img.naturalWidth) return;
        const c = document.createElement('canvas');
        c.width = 200; c.height = 200;
        const sw = crop.w / crop.scale;   // 裁剪框对应原图边长
        c.getContext('2d').drawImage(img, -crop.x / crop.scale, -crop.y / crop.scale, sw, sw, 0, 0, 200, 200);
        const url = c.toDataURL('image/jpeg', 0.9);
        try { localStorage.setItem(KEY, url); } catch (_) {}
        setGlobal(url, updateUI);
        closeSheet();
    }

    function clear() {
        try { localStorage.removeItem(KEY); } catch (_) {}
        window.__qfsAvatarImg = null;
        updateUI();
        onChange();
        closeSheet();
    }

    function bind(opts) {
        onChange = (opts && opts.onChange) || onChange;
        toast = (opts && opts.hint) || toast;
        const row = document.getElementById('mineAvatarRow');
        if (row) row.addEventListener('click', openSheet);
        const sheet = document.getElementById('avatarSheet');
        if (sheet) {
            sheet.querySelector('[data-avatar-close]').addEventListener('click', closeSheet);
            document.getElementById('btnAvatarCancel').addEventListener('click', closeSheet);
            document.getElementById('btnAvatarPick').addEventListener('click', pick);
            document.getElementById('btnAvatarClear').addEventListener('click', clear);
            document.getElementById('btnAvatarOk').addEventListener('click', commit);
        }
        load();
    }

    function openSheet() {
        updateUI();
        // 还没设置头像时直接选图，选完才弹裁剪框，而不是先给一个空框发愣
        if (!hasAvatar()) { pick(); return; }
        const sheet = document.getElementById('avatarSheet');
        if (sheet) sheet.hidden = false;
        // 把当前头像放进裁剪框：能看到现状，也能直接重新构图
        const im = window.__qfsAvatarImg;
        if (im && im.naturalWidth) openCrop(im);
    }

    window.QF_Avatar = { bind, load, openSheet, pick, clear, hasAvatar, updateUI,
        // 测试挂钩：直接注入一张 dataURL，跳过系统文件选择器
        __setForTest: (dataUrl) => { try { localStorage.setItem(KEY, dataUrl); } catch (_) {} setGlobal(dataUrl, updateUI); }
    };
})();
