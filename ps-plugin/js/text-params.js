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

    // 能力表登记了、但桌面端放在别的页签里的风格专属字段。
    // 只在对应 row 为 true 时生成控件，面板里不再出现无主滑块。
    // scale:100 表示模板存倍率(1 = 100%)，面板显示百分数。
    const STYLE_ROWS = [
        { row: 'rowBrandLogo', label: '品牌显示', type: 'select', path: ['brandLogo'], def: 0,
          options: [['0', '仅文字'], ['1', '文字+Logo'], ['2', '仅Logo'], ['3', '不显示品牌']] },
        { row: 'rowBrandSize', label: '品牌大小', type: 'range', path: ['brandSize'], def: 100,
          min: 50, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowParamColor', label: '参数颜色', type: 'select', path: ['paramColor'], def: 'auto',
          options: [['auto', '自动'], ['#000', '黑色'], ['#fff', '白色']] },
        { row: 'rowCreditMode', label: '署名内容', type: 'select', path: ['creditMode'], def: 0,
          options: [['0', '个性签名'], ['1', '相机型号']] },

        // 苹果信息卡
        { row: 'rowAppleFont', label: '信息卡字体', type: 'select', path: ['appleCard', 'fontFamily'], def: 'Courier New',
          options: [['Courier New', 'Courier New'], ['Helvetica', 'Helvetica'], ['Georgia', 'Georgia'],
              ['Times New Roman', 'Times New Roman'], ['Consolas', 'Consolas'], ['Arial Black', 'Arial Black']] },
        { row: 'rowAppleShow', label: '显示·品牌', type: 'check', path: ['appleCard', 'showBrand'], def: 1 },
        { row: 'rowAppleShow', label: '显示·型号', type: 'check', path: ['appleCard', 'showModel'], def: 1 },
        { row: 'rowAppleShow', label: '显示·参数', type: 'check', path: ['appleCard', 'showParams'], def: 1 },
        { row: 'rowAppleShow', label: '显示·日期', type: 'check', path: ['appleCard', 'showDate'], def: 1 },
        { row: 'rowAppleShow', label: '显示·Logo', type: 'check', path: ['appleCard', 'showLogo'], def: 1 },
        { row: 'rowAppleShow', label: '显示·竖线', type: 'check', path: ['appleCard', 'showLine'], def: 1 },
        { row: 'rowAppleModelSize', label: '型号字号', type: 'range', path: ['appleCard', 'modelScale'], def: 100,
          min: 50, max: 250, step: 5, scale: 100, unit: '%' },
        { row: 'rowAppleParamSize', label: '参数字号', type: 'range', path: ['appleCard', 'paramScale'], def: 100,
          min: 50, max: 250, step: 5, scale: 100, unit: '%' },
        { row: 'rowAppleDateSize', label: '日期字号', type: 'range', path: ['appleCard', 'dateScale'], def: 100,
          min: 50, max: 250, step: 5, scale: 100, unit: '%' },
        { row: 'rowAppleLogoSize', label: 'Logo 大小', type: 'range', path: ['appleCard', 'logoScale'], def: 100,
          min: 30, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowAppleLogoOpacity', label: 'Logo 透明度', type: 'range', path: ['appleCard', 'logoOpacity'], def: 60,
          min: 0, max: 100, step: 1, unit: '%' },
        { row: 'rowAppleLineWidth', label: '竖线宽度', type: 'range', path: ['appleCard', 'lineScale'], def: 100,
          min: 20, max: 500, step: 5, scale: 100, unit: '%' },
        { row: 'rowAppleColors', label: '主文字色', type: 'color', path: ['appleCard', 'textColor'], def: '#1d1d1f' },
        { row: 'rowAppleColors', label: '副文字色', type: 'color', path: ['appleCard', 'subColor'], def: '#86868b' },
        { row: 'rowAppleColors', label: '竖线颜色', type: 'color', path: ['appleCard', 'lineColor'], def: '#d2d2d7' },
        { row: 'rowAppleColors', label: '信息卡底色', type: 'color', path: ['appleCard', 'barBg'], def: '#ffffff' },

        // 联名水印
        { row: 'rowXmShow', label: '显示·竖线', type: 'check', path: ['xmLeica', 'showDiv'], def: 1 },
        { row: 'rowXmShow', label: '显示·渐变', type: 'check', path: ['xmLeica', 'showScrim'], def: 1 },
        { row: 'rowXmAlign', label: '对齐', type: 'select', path: ['xmLeica', 'align'], def: 1,
          options: [['0', '左下'], ['1', '底部居中'], ['2', '右下']] },
        { row: 'rowXmFont', label: '联名字体', type: 'select', path: ['xmLeica', 'fontFamily'], def: 'Courier New',
          options: [['Courier New', 'Courier New'], ['Arial', 'Arial'], ['Helvetica', 'Helvetica'],
              ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman'], ['Consolas', 'Consolas'],
              ['Arial Black', 'Arial Black']] },
        { row: 'rowXmBrandSize', label: '字标字号', type: 'range', path: ['xmLeica', 'brandScale'], def: 100,
          min: 40, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowXmBrandTrack', label: '字标字距', type: 'range', path: ['xmLeica', 'brandTracking'], def: 16,
          min: 0, max: 50, step: 1, scale: 100, unit: '%' },
        { row: 'rowXmLineWeight', label: '文案字重', type: 'select', path: ['xmLeica', 'lineWeight'], def: 600,
          options: [['300', '细 300'], ['400', '常规 400'], ['500', '中等 500'], ['600', '半粗 600'], ['700', '粗 700']] },
        { row: 'rowXmLineSize', label: '文案字号', type: 'range', path: ['xmLeica', 'lineScale'], def: 100,
          min: 40, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowXmLogoSize', label: '联名 Logo 大小', type: 'range', path: ['xmLeica', 'logoScale'], def: 100,
          min: 30, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowXmLogoOpacity', label: '联名 Logo 透明度', type: 'range', path: ['xmLeica', 'logoOpacity'], def: 100,
          min: 0, max: 100, step: 1, unit: '%' },
        { row: 'rowXmLogoColor', label: 'Logo 颜色', type: 'color', path: ['xmLeica', 'logoColor'], def: '#ffffff' },
        { row: 'rowXmLogoColor', label: '保留 Logo 原色', type: 'check', path: ['xmLeica', 'logoRaw'], def: 1 },
        { row: 'rowXmPad', label: '边距', type: 'range', path: ['xmLeica', 'padScale'], def: 100,
          min: 40, max: 300, step: 5, scale: 100, unit: '%' },
        { row: 'rowXmScrim', label: '渐变强度', type: 'range', path: ['xmLeica', 'scrim'], def: 45,
          min: 0, max: 100, step: 1, unit: '%' },
        { row: 'rowXmColors', label: '主文字色', type: 'color', path: ['xmLeica', 'textColor'], def: '#ffffff' },
        { row: 'rowXmColors', label: '副文字色', type: 'color', path: ['xmLeica', 'subColor'], def: '#d9d9d9' },
        { row: 'rowXmColors', label: '竖线颜色', type: 'color', path: ['xmLeica', 'divColor'], def: '#ffffff' }
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

        // 风格专属字段：完全由能力表驱动，没登记的行一个都不摆
        let styleOut = '';
        for (const d of STYLE_ROWS) {
            if (!show(d.row)) continue;
            const raw = getPath(d.path, null);
            let value = raw == null ? d.def : (d.scale ? Number(raw) * d.scale : raw);
            if (d.type === 'range') value = Math.round(num(value, d.def));
            if (d.type === 'check') value = !!value;
            styleOut += ctl(d.type, d.label, value, (v) => {
                setPath(d.path, d.type === 'check' ? (v ? 1 : 0)
                    : (d.scale ? v / d.scale : v));
            }, d.type === 'range'
                ? { min: d.min, max: d.max, step: d.step, unit: d.unit || '%' }
                : (d.type === 'select' ? { options: d.options } : undefined));
        }
        if (styleOut) out += '<details><summary>风格专属</summary>' + styleOut + '</details>';

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
