// 导出路径与文件名的纯逻辑（不依赖 electron，可离线单测）
const path = require('path');

// 文件名只允许作为"单个名字"使用:去掉目录、控制字符、Windows 保留名与末尾点/空格。
// 导出链路的 filename/subdir 来自 .qfs 等不可信输入,必须在主进程再收一次口。
function safeLeafName(name, fallback) {
    let s = path.basename(String(name == null ? '' : name));
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!s || s === '.' || s === '..') s = (fallback === undefined) ? 'file' : fallback;
    const stem = s.replace(/\.[^.]*$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) s = '_' + s;
    return s;
}

const EXPORT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
function safeExportName(name, fallback) {
    let s = safeLeafName(name, fallback);
    if (!EXPORT_EXTS.has(path.extname(s).toLowerCase())) s += '.png';
    return s;
}

// 已设置「默认导出位置」时，导出该落到哪儿：
//   多张 → 整批写进该目录（目录模式）
//   单张 → 目录里第一个不重名的文件名（同名自动 _1、_2，绝不覆盖已有文件）
// 目录失效（被删/权限变了）返回 null，调用方回退到系统保存框。
// validDir / freeFilePath 由调用方注入，避免这里再实现一套目录判定。
function autoExportTarget(dir, count, hintName, deps) {
    const d = deps || {};
    if (typeof d.validDir !== 'function' || typeof d.freeFilePath !== 'function') return null;
    if (!d.validDir(dir)) return null;
    if (Number(count) > 1) return { mode: 'dir', dir };
    const hint = safeExportName(hintName || 'photo.jpg', 'photo.jpg');
    return { mode: 'file', filePath: d.freeFilePath(dir, hint) };
}

module.exports = { safeLeafName, safeExportName, autoExportTarget, EXPORT_EXTS };
