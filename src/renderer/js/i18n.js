// 界面多语言运行时(中文原文为键的查表式 i18n)
//   · 词典 DICT:中文界面文案 → 英文。键就是 index.html 里现成的文案,不需要给 HTML 加 key 属性,
//     新增界面文字未进词典时自动保持中文,词典可以增量补,不会腐烂成"漏标 key"。
//   · apply():DOMContentLoaded 后用 TreeWalker 扫描文本节点 + placeholder/title 属性,整词命中才替换;
//     SCRIPT/STYLE/TEXTAREA 跳过;首尾空白原样保留。
//   · 语言切换:右上角 cbLang 下拉,选择后写 localStorage 并整页刷新(动态生成的列表随重载套用新语言)。
//   · v1 口径:静态界面文案(页签/分组/按钮/下拉项/输入提示)已覆盖;JS 动态产生的状态栏消息、
//     弹窗标题与 hint-box 长说明暂为中文,后续按需补词典。
(function () {
    'use strict';

    var LANG_KEY = 'qfs_lang';

    var DICT = {
        /* ── 页签 / 顶栏 ── */
        '参数': 'Params', '边框': 'Frame', '光影': 'Light', '模板': 'Template',
        '拼图': 'Collage', '切图': 'Slice',         '详情': 'Details', '更新': 'Update',
        '检查更新': 'Check updates', '撤销': 'Undo', '重做': 'Redo', '重置': 'Reset', '随机': 'Random',
        '适应': 'Fit', '复制': 'Copy', '同步到选中': 'Sync to selected', '导入照片': 'Import photos',
        '导出': 'Export', '设置用户': 'Set profile', '检查更新中…': 'Checking for updates…',

        /* ── 通用词 ── */
        '保存': 'Save', '取消': 'Cancel', '确认': 'Confirm', '删除': 'Delete', '重命名': 'Rename',
        '重置': 'Reset', '选择': 'Select', '名称': 'Name', '标签': 'Tag', '尺寸': 'Size',
        '大小': 'Size', '颜色': 'Color', '字体': 'Font', '字号': 'Font size', '样式': 'Style',
        '效果': 'Effect', '无': 'None', '正常': 'Normal', '自动': 'Auto', '选择图片': 'Choose image',
        '知道了': 'Got it', '继续上次会话': 'Resume last session', '开始使用': 'Get started',
        '透明': 'Transparent', '白色': 'White', '黑色': 'Black', '深灰': 'Dark gray',
        '红色': 'Red', '绿色': 'Green', '蓝色': 'Blue', '金色': 'Gold', '橙色': 'Orange', '紫色': 'Purple',
        '内': 'Inside', '外': 'Outside', '居中': 'Center', '居右': 'Right', '分列': 'Split',
        '竖排': 'Vertical', '直角': 'Square', '双线': 'Double', '虚线': 'Dashed', '实线,留空': 'Solid (blank=none)',
        '全部': 'All', '显示名称': 'Show name', '显示头像': 'Show avatar', '更换头像': 'Change avatar',
        '头像（选填）': 'Avatar (optional)', '请输入用户名': 'Enter a username', '清除用户资料': 'Clear profile',

        /* ── 参数页签:相机参数 / EXIF ── */
        '相机参数(自动识别)': 'Camera info (auto from EXIF)',
        '参数库': 'Camera presets', '存入库': 'Save to library', '删除': 'Delete',
        '品牌': 'Brand', '型号': 'Model', '焦距': 'Focal length', '光圈': 'Aperture',
        '快门': 'Shutter', '相机型号': 'Camera model',
        'EXIF 参数条': 'EXIF param strip', '等效焦距换算': '35mm-equivalent focal',
        '参数字号': 'Param font size', '参数缩放': 'Param scale', '参数位置': 'Param position',
        '参数类型': 'Param format', '参数颜色': 'Param color', '参数文字': 'Param text',
        '拍摄信息': 'Shot info', '位置信息': 'Location', '日期参数': 'Date',
        '品牌显示': 'Brand display', '品牌行': 'Brand line', '品牌行含型号': 'Brand line with model',
        '不显示品牌': 'Hide brand', '仅Logo': 'Logo only', '仅文字': 'Text only', '文字+Logo': 'Text + Logo',
        '完整参数': 'Full params', '居中参数': 'Centered params', '画面参数': 'Frame params',
        '完整包含': 'Include all',

        /* ── 签名 / 头像 ── */
        '签名 / 头像': 'Signature / Avatar', '个性签名': 'Signature', '签名字体': 'Signature font',
        '签名颜色': 'Signature color', '签名大小': 'Signature size', '输入你的签名文字': 'Your signature text',
        '头像大小': 'Avatar size',

        /* ── 边框页签 ── */
        '填充': 'Fill', '填充(高级)': 'Fill (advanced)', '填充类型': 'Fill type', '纯色': 'Solid',
        '渐变': 'Gradient', '纹理': 'Texture', '照片': 'Photo', '背景': 'Background',
        '模糊': 'Blur', '模糊照片底': 'Blurred photo backdrop', '背景模糊': 'Background blur',
        '模糊程度': 'Blur amount', '填充透明度': 'Fill opacity', '填充颜色': 'Fill color',
        '渐变类型': 'Gradient type', '渐变角度': 'Gradient angle', '线性': 'Linear', '径向': 'Radial',
        '纹理缩放': 'Texture scale', '纹理混合': 'Texture blend', '正片叠底': 'Multiply', '滤色': 'Screen',
        '叠加': 'Overlay', '内置纹理': 'Built-in textures', '选择纹理': 'Pick a texture',
        '描边': 'Stroke', '描边位置': 'Stroke position', '描边粗细': 'Stroke width',
        '描边透明度': 'Stroke opacity', '描边颜色': 'Stroke color', '镂空描边': 'Outline stroke',
        '阴影': 'Shadow', '阴影 / 发光': 'Shadow / Glow', '投影': 'Drop shadow', '发光': 'Glow',
        '发光模糊': 'Glow blur', '发光透明度': 'Glow opacity', '发光颜色': 'Glow color',
        '阴影透明度': 'Shadow opacity', '阴影颜色': 'Shadow color',
        '圆角': 'Corner radius', '照片圆角': 'Photo radius', '边框圆角': 'Frame radius',
        '统一边距': 'Uniform margin', '图片缩放': 'Photo scale', '整体偏移 X': 'Offset X (all)',
        '整体偏移 Y': 'Offset Y (all)', '偏移 X': 'Offset X', '偏移 Y': 'Offset Y',
        '画布比例': 'Canvas ratio', '画布': 'Canvas', '裁剪方式': 'Crop mode', '填满裁切': 'Fill & crop',
        '原始': 'Original', '边框色': 'Frame color', '角饰': 'Corner ornament', '四角装饰括号': 'Corner brackets',
        '撕边': 'Torn edge', '撕边（胶片特效）': 'Torn edge (film effect)', '撕边强度': 'Tear strength',
        '撕边密度': 'Tear density',

        /* ── 光影页签 ── */
        '暗角': 'Vignette', '强度': 'Strength', '羽化': 'Feather', '漏光': 'Light leak',
        '漏光类型': 'Leak type', '暖光': 'Warm', '冷光': 'Cool', '品红': 'Magenta',
        '漏光强度': 'Leak opacity', '漏光角度': 'Leak angle', '胶片颗粒': 'Film grain',
        '颗粒强度': 'Grain amount', '扩散': 'Diffusion',

        /* ── Logo / 元素 ── */
        '图标库': 'Icon library', '内置标记': 'Built-in marks',
        '品牌 Logo': 'Brand logos', '自定义图标': 'Custom icons', '+ 添加自定义图标': '+ Add custom icon',
        '元素管理': 'Elements', '位置 X': 'Position X', '位置 Y': 'Position Y',
        '透明度': 'Opacity', '缩放': 'Scale', '旋转': 'Rotation',
        '↑顶': '↑ Top', '上移': 'Up', '下移': 'Down', '↓底': '↓ Bottom',
        '复制 (Ctrl+C)': 'Copy (Ctrl+C)', '粘贴 (Ctrl+V)': 'Paste (Ctrl+V)', '删除 (Del)': 'Delete (Del)',
        '左对齐': 'Left', '右对齐': 'Right', '水平居中': 'Center H', '顶对齐': 'Top', '底对齐': 'Bottom',
        '垂直居中': 'Center V', '水平均分': 'Distribute H', '垂直均分': 'Distribute V',
        '统一尺寸': 'Uniform size', '清空全部元素': 'Clear all elements',
        '文字转图片': 'Text to image', '主标题': 'Title', '副标题': 'Subtitle',
        '第一行': 'Line 1', '第二行': 'Line 2', '背景条': 'Text backdrop', '删除字幕': 'Remove caption',
        '转图片的文字(如: 摄于杭州 · 2026)': 'Text to render (e.g. Hangzhou · 2026)',

        /* ── 模板页签 ── */
        '模板名称': 'Template name', '分类标签': 'Tag', '模板信息': 'Template info',
        '保存 / 导入导出': 'Save / Import & export',
        '导出 .qfs': 'Export .qfs', '导入': 'Import', '导出配置': 'Export config', '导入配置': 'Import config',
        '复制分享码': 'Copy share code', '粘贴分享码': 'Paste share code',
        '已存模板': 'Saved templates', '搜索模板名称 / 标签…': 'Search templates / tags…',
        '快速预设': 'Quick presets', '复古胶片': 'Vintage film', '证件照': 'ID photo',
        '自动取色边框': 'Auto color frame', '同步时适配横竖方向': 'Adapt margins on sync',

        /* ── 拼图 / 切图 ── */
        '拼图布局': 'Collage layout', '间距与字幕': 'Gaps & captions', '格子间距': 'Cell gap',
        '格子圆角': 'Cell radius', '块间留白': 'Block gap', '添加/编辑字幕': 'Add / edit caption',
        '全部重置格子': 'Reset all cells', '清空全部格子图片': 'Clear all cell photos',
        '槽位缩放': 'Slot scale', '导出拼图': 'Export collage', '退出拼图': 'Exit collage',
        '九宫格切图': '9-grid slice', '切分规格': 'Slice layout', '切分预览': 'Slice preview',
        '导出切图': 'Export slices', '导出这 n² 张': 'Export these n²',
        '格式': 'Format', '质量': 'Quality', '渲染长边': 'Long edge',
        '原图尺寸': 'Original size', '原图分辨率': 'Original resolution',

        /* ── 导出面板 / 分辨率 ── */
        '常用清晰 · 2048px': 'Everyday · 2048px', '手机分享 · 1080px': 'Mobile share · 1080px',
        '高清大图 · 4096px': 'HD large · 4096px', '打印超大 · 8192px': 'Print XL · 8192px',
        '质量 60%': 'Quality 60%', '质量 70%': 'Quality 70%', '质量 80%': 'Quality 80%',
        '质量 85%': 'Quality 85%', '质量 90%': 'Quality 90%', '质量 92%': 'Quality 92%',
        '质量 95%': 'Quality 95%', '质量 98%': 'Quality 98%', '质量 100%': 'Quality 100%',
        '分文件夹导出': 'Export into folders', '导出诊断日志': 'Export diagnostics',
        '含 GPS': 'Keep GPS',

        /* ── 新手引导 / 弹窗 ── */
        '新手引导': 'Guide', '返回缩略图': 'Back to thumbnails',
        '← 返回缩略图': '← Back to thumbnails',

        /* ── 参数库下拉 / 常用占位 ── */
        '-- 选择已存参数(自动填入) --': '-- Pick a saved preset (auto-fill) --',
        '搜索预设…': 'Search presets…', '内置': 'Built-in',

        /* ── 位置枚举(参数条/水印) ── */
        '居左': 'Left',

        /* ── 填充混合等 ── */
        '真实': 'Real'
    };

    function currentLang() {
        try { return localStorage.getItem(LANG_KEY) || 'zh'; } catch (e) { return 'zh'; }
    }

    // 整词替换一段文本;返回替换后的值,未命中返回 null
    function translateText(s) {
        if (currentLang() !== 'en' || !s) return null;
        var trimmed = s.trim();
        if (!trimmed) return null;
        var en = DICT[trimmed];
        if (en == null || en === trimmed) return null;
        // 保留首尾空白,替换中间部分
        var lead = s.slice(0, s.indexOf(trimmed));
        return lead + en + s.slice(s.indexOf(trimmed) + trimmed.length);
    }

    function isSkippable(node) {
        var tag = node.parentNode && node.parentNode.nodeName;
        return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA';
    }

    function apply() {
        if (currentLang() !== 'en') return;
        // 1) 文本节点(整词命中才换;动态列表里未进词典的中文原样保留)
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) { return isSkippable(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
        });
        var nodes = [], n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(function (tn) {
            var rep = translateText(tn.nodeValue);
            if (rep != null) tn.nodeValue = rep;
        });
        // 2) placeholder 与 title 属性
        document.querySelectorAll('[placeholder],[title]').forEach(function (el) {
            var p = translateText(el.getAttribute('placeholder'));
            if (p != null) el.setAttribute('placeholder', p);
            var t = translateText(el.getAttribute('title'));
            if (t != null) el.setAttribute('title', t);
        });
        // 3) select 未选中项的可见文案由文本节点覆盖,无需额外处理
    }

    function bindLangSwitch() {
        var sel = document.getElementById('cbLang');
        if (!sel) return;
        sel.value = currentLang();
        sel.addEventListener('change', function () {
            try { localStorage.setItem(LANG_KEY, sel.value); } catch (e) {}
            location.reload();
        });
    }

    function boot() {
        apply();
        bindLangSwitch();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // 供 JS 侧动态文案使用(后续按需接入):window.QfsI18n.t('保存')
    window.QfsI18n = {
        t: function (s) {
            if (currentLang() !== 'en' || !s) return s;
            var en = DICT[String(s).trim()];
            return en != null ? en : s;
        },
        apply: apply,
        current: currentLang
    };
})();
