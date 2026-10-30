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
})();
