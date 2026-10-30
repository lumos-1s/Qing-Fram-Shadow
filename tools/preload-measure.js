// 测量专用 preload:提供 App 启动所需的 IPC 桥 + 测试图注入
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    saveImage: () => ipcRenderer.invoke('save-image-base64'),
    saveImagesBatch: () => ipcRenderer.invoke('save-images-batch'),
    pickExportLocation: () => ipcRenderer.invoke('pick-export-location'),
    writeExportFiles: () => ipcRenderer.invoke('write-export-files'),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    importLogoPack: (filePath) => ipcRenderer.invoke('import-logo-pack', filePath),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    saveTemplate: () => ipcRenderer.invoke('save-template'),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: () => ipcRenderer.invoke('load-template'),
    deleteTemplate: () => ipcRenderer.invoke('delete-template'),
    renameTemplate: () => ipcRenderer.invoke('rename-template'),
    exportTemplate: () => ipcRenderer.invoke('export-template'),
    importTemplate: () => ipcRenderer.invoke('import-template'),
    exportQfs: () => ipcRenderer.invoke('export-qfs'),
    openQfs: () => ipcRenderer.invoke('open-qfs'),
    getUser: () => ipcRenderer.invoke('get-user'),
    saveUser: () => ipcRenderer.invoke('save-user'),
    logoutUser: () => ipcRenderer.invoke('logout-user'),
    getPrefs: () => ipcRenderer.invoke('get-prefs'),
    savePrefs: (p) => ipcRenderer.invoke('save-prefs', p),
    readExif: () => ipcRenderer.invoke('read-exif'),
    loadAcrTables: () => ipcRenderer.invoke('load-acr-tables'),
    openStickerImage: () => ipcRenderer.invoke('open-sticker-image'),
    listWallCovers: () => ipcRenderer.invoke('list-wall-covers'),
    openWallCoversDir: () => ipcRenderer.invoke('open-wall-covers-dir')
});

// 测试标记：page 主世界可读。app.js 据此跳过「启动即开预设墙」——
// 老用例是在墙出现之前写的，墙的 fixed 覆盖层会把真实鼠标事件全挡在画布外。
contextBridge.exposeInMainWorld('__qfTest', true);

contextBridge.exposeInMainWorld('__measure', {
    testImage: () => ipcRenderer.invoke('measure:test-image')
});
