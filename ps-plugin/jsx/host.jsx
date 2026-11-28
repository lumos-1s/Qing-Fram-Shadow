/*
 * 清框影 PS 桥接 PoC — Photoshop ExtendScript 宿主端
 * 入口：
 *   qfSelfTest()                    自检关键 API 是否可用
 *   qfGetDocKey()                   轻量返回文档 key（尺寸/路径/历史步数）
 *   qfGetLayerPng(path)             把当前文档合成导出成高质量 JPEG 到 path
 *   qfGetDocPath()                  返回当前文档源文件路径与色彩配置
 *   qfPlacePng(path, ...)           把渲染结果作为新图层放回当前文档
 * 只用 Photoshop 自带 API，不依赖任何第三方库。
 */
#target photoshop

// 文档 key：面板用它判断「文档没改动就复用缓存的源图」。
// 历史步数变化 = 用户改过图，必须重新导出；只看文档身份，不看选中图层。
function qfDocKeyOf(doc) {
    var w = Math.max(1, Math.round(doc.width.as('px')));
    var h = Math.max(1, Math.round(doc.height.as('px')));
    var ident = '';
    try { ident = doc.fullName ? String(doc.fullName.fsName) : String(doc.name || ''); } catch (e) { ident = ''; }
    try { if (doc.id) ident += '#' + doc.id; } catch (e) { /* 旧版 PS 没有 id */ }
    var hist = 0;
    try { hist = doc.historyStates.length; } catch (e) { hist = 0; }
    var histName = '';
    try {
        if (hist > 0) histName = String(doc.historyStates[hist - 1].name || '');
    } catch (e) { histName = ''; }
    return w + 'x' + h + '|' + ident + '|' + hist + '|' + histName;
}

function qfSelfTest() {
    try {
        var doc = app.activeDocument;
        var c = [];
        c.push(doc ? 'doc' : 'no-doc');
        c.push(doc && typeof doc.resizeCanvas === 'function' ? 'canvas' : 'no-canvas');
        c.push(doc && typeof doc.place === 'function' ? 'place' : 'no-place');
        c.push(doc && typeof doc.suspendHistory === 'function' ? 'undo-group' : 'no-undo-group');
        c.push(typeof JPEGSaveOptions === 'function' ? 'jpeg' : 'no-jpeg');
        c.push(typeof UnitValue === 'function' ? 'unit' : 'no-unit');
        c.push(typeof DialogModes !== 'undefined' && typeof DialogModes.NO !== 'undefined' ? 'dialog' : 'no-dialog');
        var size = doc ? ('|' + Math.round(doc.width.as('px')) + 'x' + Math.round(doc.height.as('px'))) : '';
        return 'OK:' + c.join(',') + size;
    } catch (e) {
        return 'ERR:' + (e.message || e);
    }
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
    var tmp = null;
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';
        var key = qfDocKeyOf(doc);

        app.displayDialogs = DialogModes.NO;
        var file = new File(path);
        if (file.exists) file.remove();
        var opts = new JPEGSaveOptions();
        opts.quality = 12;

        // 优先直接存副本：JPEG 会自己合成可见图层，不必先 duplicate + flatten，
        // 对 5905x3937 这类大文档能省掉一整份内存拷贝。
        try {
            doc.saveAs(file, opts, true); // asCopy = true，不改变当前文档
        } catch (e1) {
            tmp = doc.duplicate();
            tmp.flatten();
            var f2 = new File(path);
            if (f2.exists) f2.remove();
            tmp.saveAs(f2, opts, true);
            tmp.close(SaveOptions.DONOTSAVECHANGES);
            tmp = null;
            app.activeDocument = doc;
        }
        return 'OK:' + key;
    } catch (e) {
        if (tmp) {
            try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) { /* 忽略 */ }
        }
        return 'ERR:' + (e.message || e);
    } finally {
        try { app.displayDialogs = oldDialogs; } catch (e3) { /* 忽略 */ }
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

var qfLastPlaceResult = '';
var qfPlaceArgs = null;
var qfPlaceDidRun = false;

// 真正的写回实现
function qfPlacePngImpl(path, name, hideSrc, asSmart, fitDoc, outW, outH, canvasFit) {
    qfPlaceDidRun = true;
    var oldDialogs = app.displayDialogs;
    var result = '';
    app.displayDialogs = DialogModes.NO;
    try {
        var doc = app.activeDocument;
        if (!doc) return 'ERR:没有打开的文档';

        // 反复套用时替换掉上一次的边框图层，不再一直往上叠
        for (var i = doc.layers.length - 1; i >= 0; i--) {
            var old = doc.layers[i];
            if (old && old.name && String(old.name).indexOf('清框影边框') === 0) old.remove();
        }
        var srcLayer = doc.activeLayer;

        var png = new File(path);
        if (!png.exists) return 'ERR:渲染结果不存在';

        // 按预设尺寸调整文档画布：只改画布边界，不重采样，不需要自由变换。
        var dw = doc.width.as('px'), dh = doc.height.as('px');
        if (String(canvasFit) === 'true' && Number(outW) > 0 && Number(outH) > 0) {
            try {
                doc.resizeCanvas(new UnitValue(Number(outW), 'px'),
                    new UnitValue(Number(outH), 'px'), AnchorPosition.MIDDLECENTER);
                dw = doc.width.as('px'); dh = doc.height.as('px');
            } catch (e0) {
                return 'ERR:调整文档画布失败：' + (e0.message || e0);
            }
        }

        var layer = null;
        if (String(asSmart) === 'true' && typeof doc.place === 'function') {
            app.activeDocument = doc;
            layer = doc.place(png);
        } else {
            var tmp = app.open(png);
            tmp.activeLayer.copy();
            tmp.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
            layer = doc.paste();
        }
        if (!layer) return 'ERR:粘贴失败，没有生成新图层';
        layer.name = name || '清框影边框';
        layer.visible = true;
        layer.opacity = 100;

        var b = layer.bounds;
        var srcW = Math.max(1, Number(outW) || Math.max(1, b[2].as('px') - b[0].as('px')));
        var srcH = Math.max(1, Number(outH) || Math.max(1, b[3].as('px') - b[1].as('px')));
        var s = 1;
        // 默认路径：成品已在面板侧处理，这里只 1:1 置入，绝不调用 resize。
        // 只有显式勾选「缩放铺满文档」才在这里做一次 cover 变换。
        if (String(fitDoc) === 'true') {
            var lw = Math.max(1, b[2].as('px') - b[0].as('px'));
            var lh = Math.max(1, b[3].as('px') - b[1].as('px'));
            s = Math.max(dw / lw, dh / lh);
            layer.resize(Math.max(1, Math.round(lw * s)), Math.max(1, Math.round(lh * s)),
                AnchorPosition.MIDDLECENTER);
        }
        // 居中微调（不缩放，move 不占大量暂存盘）
        b = layer.bounds;
        var curW = b[2].as('px') - b[0].as('px'), curH = b[3].as('px') - b[1].as('px');
        var dx = Math.round((dw - curW) / 2) - b[0].as('px');
        var dy = Math.round((dh - curH) / 2) - b[1].as('px');
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) layer.translate(dx, dy);

        if (String(hideSrc) === 'true' && srcLayer && srcLayer !== layer) {
            srcLayer.visible = false;
        }
        doc.activeLayer = layer;
        b = layer.bounds;
        result = 'OK:' + layer.name + ' ' + Math.round(b[2].as('px') - b[0].as('px'))
            + 'x' + Math.round(b[3].as('px') - b[1].as('px'))
            + ' (从 ' + srcW + 'x' + srcH + ' 缩放 ' + s.toFixed(2) + ')';
    } catch (e) {
        result = 'ERR:' + (e.message || e);
    } finally {
        try { app.displayDialogs = oldDialogs; } catch (e4) { /* 忽略 */ }
        qfLastPlaceResult = result;
    }
    return result;
}

// 不使用 suspendHistory 的直接入口，供 panel 在 EvalScript 报错时兜底
function qfPlacePngDirect(path, name, hideSrc, asSmart, fitDoc, outW, outH, canvasFit) {
    qfLastPlaceResult = '';
    qfPlaceDidRun = false;
    return qfPlacePngImpl(path, name, hideSrc, asSmart, fitDoc, outW, outH, canvasFit);
}

// 把「替换旧图层 + 调画布 + 置入 + 隐藏原图层」合成一次历史，Ctrl+Z 一步撤销
function qfPlacePng(path, name, hideSrc, asSmart, fitDoc, outW, outH, canvasFit) {
    qfLastPlaceResult = '';
    qfPlaceDidRun = false;
    // 用全局变量传参：ExtendScript 的 suspendHistory 只能吃代码字符串，
    // 把中文图层名/路径 JSON 序列化进去在某些版本会解析失败（EvalScript error）。
    qfPlaceArgs = [path, name, hideSrc, asSmart, fitDoc, outW, outH, canvasFit];
    var code = 'qfPlacePngImpl(qfPlaceArgs[0],qfPlaceArgs[1],qfPlaceArgs[2],qfPlaceArgs[3],'
        + 'qfPlaceArgs[4],qfPlaceArgs[5],qfPlaceArgs[6],qfPlaceArgs[7])';
    try {
        var doc = app.activeDocument;
        if (doc && typeof doc.suspendHistory === 'function') {
            doc.suspendHistory('清框影边框', code);
            if (qfPlaceDidRun) return qfLastPlaceResult;
        }
    } catch (e) { /* 旧版 PS 没有 suspendHistory，退回直接调用 */ }
    // 已经执行过就绝不重复执行，避免贴两层
    if (qfPlaceDidRun) return qfLastPlaceResult;
    return qfPlacePngImpl(qfPlaceArgs[0], qfPlaceArgs[1], qfPlaceArgs[2], qfPlaceArgs[3],
        qfPlaceArgs[4], qfPlaceArgs[5], qfPlaceArgs[6], qfPlaceArgs[7]);
}
