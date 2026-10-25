const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    openImageFolder: () => ipcRenderer.invoke('open-image-folder'),
    collectImages: (paths) => ipcRenderer.invoke('collect-images', paths),
    readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
    // Electron 32 起 File.path 被移除;统一走 webUtils,旧版本回退到 file.path
    getPathForFile: (file) => {
        try {
            if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
        } catch (e) { /* 回退 */ }
        return (file && file.path) || '';
    },
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    loadAllPresets: () => ipcRenderer.invoke('load-all-presets'),
    saveImage: (data, filename) => ipcRenderer.invoke('save-image-base64', { data, filename }),
    saveImagesBatch: (files) => ipcRenderer.invoke('save-images-batch', files),
    pickExportLocation: (payload) => ipcRenderer.invoke('pick-export-location', payload),
    writeExportFiles: (payload) => ipcRenderer.invoke('write-export-files', payload),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    listCustomIcons: () => ipcRenderer.invoke('list-custom-icons'),
    deleteCustomIcon: (dataUrl) => ipcRenderer.invoke('delete-custom-icon', dataUrl),
    renameCustomIcon: (dataUrl, name) => ipcRenderer.invoke('rename-custom-icon', dataUrl, name),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    listMarks: () => ipcRenderer.invoke('list-marks'),
    saveTemplate: (name, data) => ipcRenderer.invoke('save-template', { name, data }),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: (name) => ipcRenderer.invoke('load-template', name),
    deleteTemplate: (name) => ipcRenderer.invoke('delete-template', name),
    renameTemplate: (oldName, newName) => ipcRenderer.invoke('rename-template', { oldName, newName }),
    exportTemplate: (name, data) => ipcRenderer.invoke('export-template', { name, data }),
    importTemplate: () => ipcRenderer.invoke('import-template'),
    exportQfs: (data) => ipcRenderer.invoke('export-qfs', data),
    openQfs: () => ipcRenderer.invoke('open-qfs'),
    getUser: () => ipcRenderer.invoke('get-user'),
    saveUser: (user) => ipcRenderer.invoke('save-user', user),
    logoutUser: () => ipcRenderer.invoke('logout-user'),
    getPrefs: () => ipcRenderer.invoke('get-prefs'),
    savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),
    readExif: (filePath) => ipcRenderer.invoke('read-exif', filePath),
    openStickerImage: () => ipcRenderer.invoke('open-sticker-image'),
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    // 给渲染层同步判断平台用;不需要异步 invoke 就能决定快捷键显示/行为
    platform: process.platform,
    isMac: process.platform === 'darwin',
    showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    openDataDir: () => ipcRenderer.invoke('open-data-dir'),
    listWallCovers: () => ipcRenderer.invoke('list-wall-covers'),
    openWallCoversDir: () => ipcRenderer.invoke('open-wall-covers-dir'),
    copyText: (text) => ipcRenderer.invoke('copy-text', text),
    copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
    saveDiagnosticsFile: (text) => ipcRenderer.invoke('save-diagnostics', text),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    startUpdateDownload: () => ipcRenderer.invoke('start-update-download'),
    quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
    onUpdaterEvent: (cb) => {
        const l = (_e, payload) => cb(payload);
        ipcRenderer.on('updater:event', l);
        return () => ipcRenderer.removeListener('updater:event', l);
    },
    onExportProgress: (cb) => {
        const l = (_e, payload) => cb(payload);
        ipcRenderer.on('export-progress', l);
        return () => ipcRenderer.removeListener('export-progress', l);
    },
    // 自定义标题栏窗口控制
    winControls: {
        minimize: () => ipcRenderer.send('win-minimize'),
        toggleMaximize: () => ipcRenderer.send('win-toggle-max'),
        close: () => ipcRenderer.send('win-close'),
        onMaximizedChange: (cb) => {
            const l = (_e, v) => cb(v);
            ipcRenderer.on('win-maximized', l);
            return () => ipcRenderer.removeListener('win-maximized', l);
        }
    }
});