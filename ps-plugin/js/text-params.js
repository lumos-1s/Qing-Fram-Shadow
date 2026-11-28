'use strict';
/* 预设可编辑文字：文字行 / 署名 / 风格自带文案。字段与桌面模板完全一致。 */
(function () {
    let t = null;
    let onChange = null;
    let ctls = [];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
    function hex(v, d) { const s = String(v || '').replace('#', ''); return /^[0-9a-f]{6}$/i.test(s) ? '#' + s : d; }
    function setPath(path, v) {
        let node = t;
        for (let i = 0; i < path.length - 1; i++) {
            const k = path[i];
            if (!node[k] || typeof node[k] !== 'object') node[k] = {};
            node = node[k];
        }
        node[path[path.length - 1]] = v;
    }
    function getPath(path, d) {
        let node = t;
        for (const k of path) {
            if (!node || typeof node !== 'object') return d;
            node = node[k];
        }
        return node == null ? d : node;
    }
    function ctl(type, label, value, setter, extra) {
        const id = ctls.length;
        ctls.push({ id, label, setter, type, unit: (extra && extra.unit) || '' });
        let input;
        if (type === 'range') {
            input = `<input type="range" data-tp="${id}" min="${extra.min}" max="${extra.max}" step="${extra.step}" value="${value}">`
                + `<output data-out="${id}">${value}${extra.unit || ''}</output>`;
        } else if (type === 'select') {
            input = `<select data-tp="${id}">` + extra.options.map(([v, l]) =>
                `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';
        } else if (type === 'check') {
            input = `<input type="checkbox" data-tp="${id}"${value ? ' checked' : ''}>`;
        } else if (type === 'color') {
            input = `<input type="color" data-tp="${id}" value="${value}">`;
        } else {
            input = `<input type="text" data-tp="${id}" value="${esc(value)}">`;
        }
        return `<div class="exif-row"><label>${esc(label)}</label>${input}</div>`;
    }

    const CAPTIONS = [
        [['polaroidCaption'], '拍立得文案', 'rowPolaroidCaption'],
        [['hassyCaption'], '哈苏文案', 'rowHassyCaption'],
        [['appleCard', 'dateText'], '苹果卡日期', 'rowAppleDate'],
        [['xmLeica', 'brandText'], '联名品牌', 'rowXmText1'],
        [['xmLeica', 'line1'], '联名第一行', 'rowXmText1'],
        [['xmLeica', 'line2'], '联名第二行', 'rowXmText2'],
        [['xmLeica', 'partnerBrand'], '联名合作方', 'rowXmPartner']
    ];

    function render() {
        const host = document.getElementById('textParams');
        if (!host || !t) return;
        ctls = [];
        const decor = t.decorConfig || (t.decorConfig = {});
        const lines = decor.textLines || (decor.textLines = []);
        // 与桌面端同一张能力表：这个风格不读的字段连控件都不摆出来
        const style = String(t.photoFrameStyle || '').toUpperCase();
        const vis = (window.StyleCaps && window.StyleCaps.visibleRows)
            ? window.StyleCaps.visibleRows(style) : {};
        const show = (row) => vis[row] !== false;
        let out = '';

        out += '<details open><summary>文字行</summary>';
        out += '<div class="text-acts"><button id="btnAddLine" type="button">＋ 添加文字</button></div>';
        lines.forEach((line, i) => {
            out += `<div class="line-head">第 ${i + 1} 行 <button class="line-del" data-del="${i}" type="button">删除</button></div>`;
            out += ctl('text', '内容', line.text || '', (v) => { line.text = v; });
            out += ctl('range', '字号', num(line.fontSize, 40), (v) => { line.fontSize = v; },
                { min: 8, max: 240, step: 1, unit: '' });
            out += ctl('color', '颜色', hex(line.colorHex, '#ffffff'), (v) => { line.colorHex = v; });
            out += ctl('select', '位置', line.align || 'bottom', (v) => { line.align = v; }, {
                options: [['free', '自由'], ['bottom', '底部'], ['top', '顶部'], ['exif', '参数条'], ['center', '居中']]
            });
            out += ctl('range', '透明度', num(line.opacity, 100), (v) => { line.opacity = v; },
                { min: 0, max: 100, step: 1, unit: '%' });
        });
        out += '</details>';

        // 个性签名：没有签名/头像区的风格整组隐藏
        let signOut = '';
        if (show('rowSignText')) {
            signOut += ctl('text', '内容', t.userSignature || '', (v) => {
                t.userSignature = v;
                try { localStorage.setItem('qfs_user_signature', v); } catch (e) { /* 忽略 */ }
            });
        }
        if (show('rowSignFont')) {
            signOut += ctl('select', '字体', t.signFont || 'Courier New', (v) => { t.signFont = v; }, {
                options: [['Courier New', 'Courier New'], ['Microsoft YaHei', '微软雅黑'],
                    ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman']]
            });
        }
        if (show('rowSignSize')) {
            signOut += ctl('range', '大小', num(t.signSize, 1), (v) => { t.signSize = v; },
                { min: 0.5, max: 2, step: 0.05, unit: '' });
        }
        if (show('rowSignColor')) {
            signOut += ctl('color', '颜色', hex(t.signColor, '#555555'), (v) => { t.signColor = v; });
        }
        if (show('rowAvatarShow')) {
            signOut += ctl('check', '显示头像', t.avatarShow !== 0, (v) => { t.avatarShow = v ? 1 : 0; });
        }
        if (show('rowAvatarScale')) {
            signOut += ctl('range', '头像大小', num(t.avatarScale, 0.85), (v) => { t.avatarScale = v; },
                { min: 0.3, max: 2, step: 0.05, unit: '' });
        }
        if (show('rowSignModel')) {
            signOut += ctl('check', '带型号', (t.signIncludeModel || 0) === 1,
                (v) => { t.signIncludeModel = v ? 1 : 0; });
        }
        if (show('rowBgBlur')) {
            signOut += ctl('check', '签名背景模糊', (t.signBgBlur || 0) === 1,
                (v) => { t.signBgBlur = v ? 1 : 0; });
        }
        if (show('rowAvatarShow') || show('rowAvatarScale')) {
            signOut += '<div class="text-acts"><button id="btnPickAvatar" type="button">选择头像图片</button></div>';
        }
        if (signOut) out += '<details><summary>个性签名</summary>' + signOut + '</details>';

        // 参数文字：型号始终可用（EXIF 底条会读），其余按风格能力显隐
        const manual = t.manualExif || (t.manualExif = {});
        let paramOut = '';
        if (show('rowParamFontSize')) {
            paramOut += ctl('range', '字号', num(t.paramFontSize, 33), (v) => { t.paramFontSize = v; },
                { min: 0, max: 160, step: 1, unit: '' });
        }
        paramOut += ctl('text', '相机型号', String(manual.model || ''), (v) => { manual.model = v; });
        if (show('rowParamType')) {
            paramOut += ctl('select', '类型', String(t.paramType == null ? 0 : t.paramType),
                (v) => { t.paramType = Number(v); }, {
                    options: [['0', '型号+参数'], ['1', '只有参数'], ['2', '只有型号']]
                });
        }
        if (show('rowParamPos')) {
            paramOut += ctl('select', '位置', t.paramPosition || 'CENTER',
                (v) => { t.paramPosition = v; }, {
                    options: [['CENTER', '居中'], ['RIGHT', '靠右'], ['SPLIT', '两端']]
                });
        }
        out += '<details><summary>参数文字</summary>' + paramOut + '</details>';

        const caps = CAPTIONS.filter(([path, , row]) => getPath(path, null) != null && show(row));
        if (caps.length) {
            out += '<details><summary>风格文案</summary>' + caps.map(([path, label]) =>
                ctl('text', label, String(getPath(path, '')), (v) => setPath(path, v))
            ).join('') + '</details>';
        }

        host.innerHTML = out;
        host.querySelectorAll('[data-tp]').forEach((el) => {
            const c = ctls[Number(el.dataset.tp)];
            if (!c) return;
            const ev = (c.type === 'select' || c.type === 'check') ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const v = c.type === 'range' ? Number(el.value)
                    : (c.type === 'check' ? el.checked : el.value);
                c.setter(v);
                const o = host.querySelector(`[data-out="${c.id}"]`);
                if (o && c.type === 'range') o.textContent = v + c.unit;
                if (onChange) onChange();
            });
        });
        const add = host.querySelector('#btnAddLine');
        if (add) add.addEventListener('click', () => {
            const w = Number(t.__qfDocW) || 1000, h = Number(t.__qfDocH) || 1000;
            lines.push({
                text: '新文字', align: 'free', x: Math.round(w / 2), y: Math.round(h / 2),
                fontFamily: 'Microsoft YaHei', fontSize: Math.max(16, Math.round(Math.min(w, h) * 0.04)),
                fontWeight: 400, letterSpacing: 0, colorHex: '#ffffff', opacity: 100, rotation: 0
            });
            if (onChange) onChange();
            render();
        });
        host.querySelectorAll('[data-del]').forEach((b) => {
            b.addEventListener('click', () => {
                lines.splice(Number(b.dataset.del), 1);
                if (onChange) onChange();
                render();
            });
        });
        const avatarBtn = host.querySelector('#btnPickAvatar');
        if (avatarBtn) avatarBtn.addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.onchange = () => {
                const f = inp.files && inp.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const raw = String(reader.result);
                    // 头像缩到 256px 再存：原图动辄几 MB，直接塞 localStorage 会超配额
                    const src = new Image();
                    src.onload = () => {
                        let data = raw;
                        try {
                            const max = 256;
                            const k = Math.min(1, max / Math.max(1, src.naturalWidth, src.naturalHeight));
                            const cv = document.createElement('canvas');
                            cv.width = Math.max(1, Math.round(src.naturalWidth * k));
                            cv.height = Math.max(1, Math.round(src.naturalHeight * k));
                            cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
                            data = cv.toDataURL('image/png');
                        } catch (e) { /* 解码失败就用原图 */ }
                        try { localStorage.setItem('qfs_user_avatar', data); } catch (e) { /* 忽略 */ }
                        const im = new Image();
                        im.onload = () => { window.__qfsAvatarImg = im; if (onChange) onChange(); };
                        im.src = data;
                    };
                    src.onerror = () => { /* 读不出来的图片直接忽略 */ };
                    src.src = raw;
                };
                reader.readAsDataURL(f);
            };
            inp.click();
        });
    }

    window.QF_TextParams = {
        setTemplate(x) { t = x; render(); },
        current() { return t; },
        onChange(fn) { onChange = fn; },
        render
    };
})();
