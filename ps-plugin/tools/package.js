'use strict';
/*
 * 把 ps-plugin 打成可分发的 ZXP：
 *   npm run ps:poc:package
 * 优先用 QF_ZXP_CERT / QF_ZXP_PASS 指定的正式证书；
 * 没提供时用 ZXPSignCmd 自带命令生成自签名证书（仅开发/测试用，不能上架）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.resolve(ROOT, '..');
const STAGE = path.join(PROJECT, 'build', 'zxp-stage', 'com.qingframe.ps.bridge.poc');
const OUT = path.join(PROJECT, 'build', 'qingframe-ps-poc.zxp');
const SIGNER = process.env.QF_ZXPSIGNCMD || path.join(__dirname, 'ZXPSignCmd.exe');

function run(args) {
    console.log('> ' + path.basename(SIGNER) + ' ' + args.join(' '));
    return execFileSync(SIGNER, args, { stdio: 'inherit', windowsHide: true });
}

function main() {
    if (!fs.existsSync(SIGNER)) {
        console.error('找不到 ZXPSignCmd：' + SIGNER);
        console.error('请下载 Adobe CEP 12 的 win64 版本放到 ps-plugin/tools/ZXPSignCmd.exe，');
        console.error('或设置 QF_ZXPSIGNCMD 指向它。');
        process.exit(1);
    }
    if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(STAGE, { recursive: true });
    for (const name of fs.readdirSync(ROOT)) {
        if (name === 'tools') continue; // 签名工具不入包
        const from = path.join(ROOT, name);
        fs.cpSync(from, path.join(STAGE, name), { recursive: true });
    }
    console.log('已暂存扩展 → ' + STAGE);

    let cert = process.env.QF_ZXP_CERT || '';
    let pass = process.env.QF_ZXP_PASS || '';
    const selfSigned = !cert;
    if (selfSigned) {
        cert = path.join(PROJECT, 'build', 'qf-dev-selfsigned.p12');
        pass = 'qf-dev-poc';
        if (!fs.existsSync(cert)) {
            fs.mkdirSync(path.dirname(cert), { recursive: true });
            run(['-selfSignedCert', 'CN', 'Beijing', 'Qingframe', 'Qingframe PS POC Dev',
                pass, cert]);
            console.warn('使用自签名证书：仅供本机开发测试，不能上架 Adobe Exchange。');
        }
    }

    if (fs.existsSync(OUT)) fs.rmSync(OUT);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    run(['-sign', STAGE, OUT, cert, pass]);
    run(['-verify', OUT]);
    const size = fs.statSync(OUT).size;
    console.log('\n打包完成：' + OUT + ' (' + Math.round(size / 1024) + ' KB)');
    console.log('安装：');
    console.log('  ExManCmd.exe /install "' + OUT + '"');
    if (selfSigned) console.log('  自签名包如被拒绝，需先取消扩展签名校验或使用开发者模式。');
}

main();
