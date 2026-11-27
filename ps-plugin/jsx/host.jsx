/*
 * 清框影 PS 桥接 PoC — Photoshop ExtendScript 宿主端
 * 两个入口：
 *   qfGetLayerPng(path)        把当前选中图层导出成透明 PNG 到 path
 *   qfPlacePng(path, name)     把 PNG 作为新图层放回当前文档
 * 只用Photoshop自带 API，不依赖任何第三方库。
 */
#target photoshop

function qfGetLayerPng(path) {
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';

        // 取整份文档的合成，尺寸就是文档画布，不是选中图层的外框。
        // 这样边框成品和文档 1:1 对应，不会出现下层露出或白边。
        var w = Math.max(1, Math.round(doc.width.as('px')));
        var h = Math.max(1, Math.round(doc.height.as('px')));

        app.activeDocument = doc;
        var tmp = doc.duplicate();
        tmp.flatten();

        var file = new File(path);
        tmp.saveAs(file, new PNGSaveOptions(), true);
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = doc;
        return 'OK:' + w + 'x' + h;
    } catch (e) {
        return 'ERR:' + (e.message || e);
    }
}

function qfPlacePng(path, name) {
    var oldDialogs = app.displayDialogs;
    // JPEG 是 sRGB，目标文档可能是 Adobe RGB；不关对话框会弹「配置文件不匹配」把自动化卡住
    app.displayDialogs = DialogModes.NO;
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        var png = new File(path);
        if (!png.exists) return 'ERR:渲染结果不存在';
        var tmp = app.open(png);
        tmp.activeLayer.copy();
        // 先关掉 PNG 文档，确保原文档重新成为最前面文档，再粘贴
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        // ExtendScript 里没有 doc.activate()，赋值 app.activeDocument 即可把文档切到最前
        app.activeDocument = doc;
        var layer = doc.paste();
        if (!layer) return 'ERR:粘贴失败，没有生成新图层';
        layer.name = name || '清框影';
        layer.visible = true;
        layer.opacity = 100;

        // 边框模板会在照片外加密度/留白，成品画布可能比文档大；
        // 不缩放直接粘进去会被画布裁掉，所以按比例缩放到刚好装进文档并居中。
        var b = layer.bounds;
        var lw = Math.max(1, b[2].as('px') - b[0].as('px'));
        var lh = Math.max(1, b[3].as('px') - b[1].as('px'));
        var dw = doc.width.as('px'), dh = doc.height.as('px');
        // cover（取较大比例）：成品必须盖满文档画布，避免下层露出或留白边
        var s = Math.max(dw / lw, dh / lh);
        if (Math.abs(s - 1) > 0.001) {
            layer.resize(Math.max(1, Math.round(lw * s)), Math.max(1, Math.round(lh * s)),
                AnchorPosition.MIDDLECENTER);
        }
        doc.activeLayer = layer;
        b = layer.bounds;
        return 'OK:' + layer.name + ' ' + Math.round(b[2].as('px') - b[0].as('px'))
            + 'x' + Math.round(b[3].as('px') - b[1].as('px'));
    } catch (e) {
        return 'ERR:' + (e.message || e);
    } finally {
        app.displayDialogs = oldDialogs;
    }
}
