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
        var layer = doc.activeLayer;
        if (!layer) return 'ERR:没有选中图层';

        var b = layer.bounds;
        var x0 = b[0].as('px'), y0 = b[1].as('px');
        var x1 = b[2].as('px'), y1 = b[3].as('px');
        var w = Math.max(1, Math.round(x1 - x0));
        var h = Math.max(1, Math.round(y1 - y0));
        var res = doc.resolution;

        // 必须先激活原文档并复制图层，再新建临时文档；
        // 否则新建的临时文档变成最前面，layer.copy() 会报「目标文档必须是最前面的文档」。
        app.activeDocument = doc;
        layer.copy();

        var tmp = app.documents.add(w, h, res, 'qingframe_export_tmp',
            NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        tmp.paste();

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
        var s = Math.min(dw / lw, dh / lh);
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
