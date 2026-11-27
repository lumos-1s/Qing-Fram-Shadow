'use strict';
/* 下载 Adobe CEP 12 的 ZXPSignCmd（win64）到 ps-plugin/tools/。
   该工具由 Adobe 提供，不入库；打包脚本会优先使用本地这一份。 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe';
const OUT = path.resolve(__dirname, 'ZXPSignCmd.exe');

function get(url, redirects, cb) {
    https.get(url, { headers: { 'User-Agent': 'qingframe-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects > 5) return cb(new Error('重定向过多'));
            return get(res.headers.location, redirects + 1, cb);
        }
        if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
        cb(null, res);
    }).on('error', cb);
}

get(URL, 0, (err, res) => {
    if (err) { console.error('下载失败：' + err.message); process.exit(1); }
    const tmp = OUT + '.part';
    const file = fs.createWriteStream(tmp);
    let size = 0;
    res.on('data', (c) => { size += c.length; });
    res.pipe(file);
    file.on('finish', () => {
        file.close();
        if (size < 1000000) { fs.unlinkSync(tmp); console.error('下载内容异常'); process.exit(1); }
        fs.renameSync(tmp, OUT);
        console.log('已下载 ZXPSignCmd：' + OUT + ' (' + Math.round(size / 1024) + ' KB)');
    });
});
