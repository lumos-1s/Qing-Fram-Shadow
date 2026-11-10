// 统一图片加载入口。
//
// 为什么必须走这里：照片是经 `qflocal://` 协议读的，而页面本身是 `file://` ——
// 两者不同源。不加 `crossOrigin` 就把图片画进 canvas 的话，画布会被标记为 tainted，
// 之后 getImageData / toBlob / toDataURL 一律抛
//   SecurityError: Tainted canvases may not be exported
// 表现出来就是：调色读不到像素、裁切点确定报错、导出直接失败。
//
// 设了 crossOrigin='anonymous' 后请求走 CORS 模式，主进程的 qflocal 响应带
// Access-Control-Allow-Origin，图片即被视为「可用于导出」；data:/blob: 图片设了也无害。
(function () {
    window.qfsImage = function (src) {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        if (src) im.src = src;
        return im;
    };

    // 把离屏画布转成可长期持有的 Image —— 所有「改像素」的操作（旋转、EXIF 方向
    // 校正、裁切）都必须走这里，不要再各自 toDataURL。
    //
    // 为什么只能是 PNG：JPEG 没有 alpha 通道，编码时透明像素会被当成黑色写进去。
    // 主照片旋转 / EXIF 方向校正以前用 toDataURL('image/jpeg')，于是带透明区域、
    // 圆角或羽化边缘的 PNG 一旋转就出现黑块（用户看到的「图片变黑」）；裁切一直
    // 用 PNG，所以没这毛病。统一入口后三处不再分叉。
    //
    // 用 blob URL 而不是 dataURL：大图的 base64 字符串会多占约 33% 内存，
    // blob 交给浏览器管理即可。decode 完成才 revoke，避免懒解码时拿到空图。
    window.qfsCanvasImage = function (canvas) {
        return new Promise((resolve) => {
            let asked = false;
            const fail = () => { if (!asked) { asked = true; resolve(null); } };
            try {
                canvas.toBlob((blob) => {
                    if (asked) return;
                    if (!blob) { fail(); return; }
                    const url = URL.createObjectURL(blob);
                    const im = window.qfsImage();
                    const finish = (ok) => {
                        if (asked) return;
                        asked = true;
                        URL.revokeObjectURL(url);
                        resolve(ok && im.naturalWidth ? im : null);
                    };
                    im.onload = () => {
                        if (im.decode) im.decode().then(() => finish(true), () => finish(true));
                        else finish(true);
                    };
                    im.onerror = () => finish(false);
                    im.src = url;
                }, 'image/png');
            } catch (_) {
                // 画布被 tainted（跨域又没走 qflocal）时 toBlob 会抛 SecurityError：
                // 宁可让调用方提示失败，也别把半张黑图换上去。
                fail();
            }
        });
    };
})();
