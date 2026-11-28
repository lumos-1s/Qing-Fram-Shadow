/*
 * 清框影 PS 桥接 PoC — Photoshop ExtendScript 宿主端
 * 入口：
 *   qfGetDocKey()              轻量返回文档 key（尺寸/路径/图层/历史步数）
 *   qfGetLayerPng(path)        把当前文档合成导出成高质量 JPEG 到 path
 *   qfGetDocPath()             返回当前文档源文件路径与色彩配置
 *   qfPlacePng(path, name...)  把渲染结果作为新图层放回当前文档
 * 只用 Photoshop 自带 API，不依赖任何第三方库。
 */
#target photoshop

// 文档 key：面板用它判断「文档没改动就复用缓存的源图」。
// 历史步数变化 = 用户改过图，必须重新导出；图层 id/名称变化也要重导。
function qfDocKeyOf(doc) {
    var w = Math.max(1, Math.round(doc.width.as('px')));
    var h = Math.max(1, Math.round(doc.height.as('px')));
    // 源图取整份文档合成，所以选中哪个图层不影响像素；key 只看文档身份和编辑历史。
    var ident = '';
    try { ident = doc.fullName ? String(doc.fullName.fsName) : String(doc.name || ''); } catch (e) { ident = ''; }
    try { if (doc.id) ident += '#' + doc.id; } catch (e) { /* 旧版 PS 没有 id */ }
    var hist = 0;
    try { hist = doc.historyStates.length; } catch (e) { hist = 0; }
    // 历史步数有上限，达到上限后长度不变；再带上最后一步的名字，编辑后仍能失效缓存
    var histName = '';
    try {
        if (hist > 0) histName = String(doc.historyStates[hist - 1].name || '');
    } catch (e) { histName = ''; }
    return w + 'x' + h + '|' + ident + '|' + hist + '|' + histName;
}

function qfGetDocKey() {
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        return 'OK:' + qfDocKeyOf(doc);
    } catch (e) {
        return 'ERR:' + (e.message || e);
    }
}

function qfGetLayerPng(path) {
    var oldDialogs = app.displayDialogs;
    var doc = null;
    var tmp = null;
    try {
        doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';

        // 取整份文档的合成，尺寸就是文档画布，不是选中图层的外框。
        // 这样边框成品和文档 1:1 对应，不会出现下层露出或白边。
        var key = qfDocKeyOf(doc);

        // 保存到已存在的文件时不要弹「是否替换」把自动化卡住
        app.displayDialogs = DialogModes.NO;
        tmp = doc.duplicate();
        tmp.flatten();

        // 整份文档合成后没有 alpha；高质量 JPEG 比 PNG 小一个量级，面板加载快得多
        var file = new File(path);
        if (file.exists) file.remove();
        var opts = new JPEGSaveOptions();
        opts.quality = 12;
        tmp.saveAs(file, opts, true);
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        tmp = null;
        app.activeDocument = doc;
        return 'OK:' + key;
    } catch (e) {
        if (tmp) {
            try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* 忽略 */ }
        }
        return 'ERR:' + (e.message || e);
    } finally {
        try { app.displayDialogs = oldDialogs; } catch (e3) { /* 忽略 */ }
        try { if (doc) app.activeDocument = doc; } catch (e4) { /* 忽略 */ }
    }
}

// 返回当前文档的源文件路径，面板侧用 Node fs + exif.js 读 EXIF
function qfGetDocPath() {
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        if (!doc.fullName) return 'ERR:文档尚未保存，没有源文件可读取 EXIF';
        var profile = '';
        try { profile = String(doc.colorProfileName || ''); } catch (e) { profile = ''; }
        return 'OK:' + doc.fullName.fsName + '|' + profile;
    } catch (e) {
        return 'ERR:' + (e.message || e);
    }
}

function qfPlacePng(path, name, hideSrc, asSmart, fitDoc, outW, outH) {
    var oldDialogs = app.displayDialogs;
    // JPEG 是 sRGB，目标文档可能是 Adobe RGB；不关对话框会弹「配置文件不匹配」把自动化卡住
    app.displayDialogs = DialogModes.NO;
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        var srcLayer = doc.activeLayer;
        var png = new File(path);
        if (!png.exists) return 'ERR:渲染结果不存在';
        var layer = null;
        if (String(asSmart) === 'true' && typeof doc.place === 'function') {
            // 直接置入为智能对象：嵌入原图数据，后续缩放不失真
            app.activeDocument = doc;
            layer = doc.place(png);
        } else {
            var tmp = app.open(png);
            tmp.activeLayer.copy();
            // 先关掉 JPEG 文档，确保原文档重新成为最前面文档，再粘贴
            tmp.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
            layer = doc.paste();
        }
        if (!layer) return 'ERR:粘贴失败，没有生成新图层';
        layer.name = name || '清框影';
        layer.visible = true;
        layer.opacity = 100;

        // 默认：等比缩小到刚好完整放进文档（contain），绝不放大——
        // 这样预设写死的边框宽度不会被撑大，成品四边也不会被画布裁掉。
        // 只有用户显式勾选「缩放铺满文档」时才做 cover，允许放大并裁切补满。
        var b = layer.bounds;
        var dw = doc.width.as('px'), dh = doc.height.as('px');
        var srcW = Math.max(1, Number(outW) || Math.max(1, b[2].as('px') - b[0].as('px')));
        var srcH = Math.max(1, Number(outH) || Math.max(1, b[3].as('px') - b[1].as('px')));
        var s = 1;
        // 默认路径：成品已在面板侧等比缩到文档内，这里只 1:1 置入，
        // 绝不调用 resize —— 大图上的自由变换会把 Photoshop 暂存盘撑满而失败。
        // 只有显式勾选「缩放铺满文档」才在这里做一次 cover 变换。
        if (String(fitDoc) === 'true') {
            var lw = Math.max(1, b[2].as('px') - b[0].as('px'));
            var lh = Math.max(1, b[3].as('px') - b[1].as('px'));
            s = Math.max(dw / lw, dh / lh);
            layer.resize(Math.max(1, Math.round(lw * s)), Math.max(1, Math.round(lh * s)),
                AnchorPosition.MIDDLECENTER);
        }
        // 微调居中（不缩放，move 不会占大量暂存盘）
        b = layer.bounds;
        var curW = b[2].as('px') - b[0].as('px'), curH = b[3].as('px') - b[1].as('px');
        var dx = Math.round((dw - curW) / 2) - b[0].as('px');
        var dy = Math.round((dh - curH) / 2) - b[1].as('px');
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) layer.translate(dx, dy);
        // 默认隐藏原图层，避免下面还堆着一层原始照片；保留在文档里方便恢复
        if (String(hideSrc) === 'true' && srcLayer && srcLayer !== layer) {
            srcLayer.visible = false;
        }
        doc.activeLayer = layer;
        b = layer.bounds;
        return 'OK:' + layer.name + ' ' + Math.round(b[2].as('px') - b[0].as('px'))
            + 'x' + Math.round(b[3].as('px') - b[1].as('px'))
            + ' (从 ' + srcW + 'x' + srcH + ' 缩放 ' + s.toFixed(2) + ')';
    } catch (e) {
        return 'ERR:' + (e.message || e);
    } finally {
        app.displayDialogs = oldDialogs;
    }
}
