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

        var tmp = app.documents.add(w, h, res, 'qingframe_export_tmp',
            NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        layer.copy();
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
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        var png = new File(path);
        if (!png.exists) return 'ERR:渲染结果不存在';
        var tmp = app.open(png);
        tmp.activeLayer.copy();
        app.activeDocument = doc;
        var layer = doc.paste();
        layer.name = name || '清框影';
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        return 'OK:' + layer.name;
    } catch (e) {
        return 'ERR:' + (e.message || e);
    }
}
