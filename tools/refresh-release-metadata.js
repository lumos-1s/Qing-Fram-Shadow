// Recompute the updater metadata after SignPath has signed the installer.
//
// Signing changes the installer bytes, so the size/SHA512 in latest.yml and the
// NSIS .blockmap built by electron-builder no longer match. Run this after the
// final installer is in dist/:
//
//   node tools/refresh-release-metadata.js
//
// The script reads dist/latest.yml, updates the installer entry and root hash,
// and regenerates the .blockmap with the same block-map implementation used by
// electron-builder 26.x.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const LATEST = path.join(DIST, 'latest.yml');

function fail(message) {
    console.error(`[refresh-release-metadata] ${message}`);
    process.exit(1);
}

function sha512Of(file) {
    return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

async function main() {
    if (!fs.existsSync(LATEST)) {
        fail(`missing ${path.relative(ROOT, LATEST)}; run electron-builder first`);
    }

    const doc = yaml.load(fs.readFileSync(LATEST, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        fail('latest.yml does not contain a YAML mapping');
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (String(doc.version) !== String(pkg.version)) {
        fail(`latest.yml version ${doc.version} does not match package.json version ${pkg.version}`);
    }

    const entries = Array.isArray(doc.files) ? doc.files : [];
    const installerName = (typeof doc.path === 'string' && doc.path)
        || (entries[0] && (entries[0].url || entries[0].path));
    if (!installerName || typeof installerName !== 'string') {
        fail('latest.yml has no installer path/url');
    }
    if (path.basename(installerName) !== installerName) {
        fail(`latest.yml installer path must be a bare filename: ${installerName}`);
    }

    const installerPath = path.join(DIST, installerName);
    if (!fs.existsSync(installerPath)) {
        fail(`missing installer: ${path.relative(ROOT, installerPath)}`);
    }

    const size = fs.statSync(installerPath).size;
    const sha512 = sha512Of(installerPath);

    const blockmapPath = `${installerPath}.blockmap`;
    const blockmap = await buildBlockMap(installerPath, 'gzip', blockmapPath);
    if (blockmap.size !== size || blockmap.sha512 !== sha512) {
        fail('regenerated blockmap does not match the signed installer');
    }

    doc.path = installerName;
    doc.sha512 = sha512;
    if (entries.length === 0) {
        doc.files = [{ url: installerName, sha512, size }];
    } else {
        let matched = false;
        for (const entry of entries) {
            if (!entry || (entry.url !== installerName && entry.path !== installerName)) continue;
            entry.url = installerName;
            entry.sha512 = sha512;
            entry.size = size;
            matched = true;
        }
        if (!matched) {
            entries[0] = { ...entries[0], url: installerName, sha512, size };
        }
    }

    const dumped = yaml.dump(doc, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(LATEST, dumped, 'utf8');

    console.log(`[refresh-release-metadata] ${installerName}`);
    console.log(`  size:    ${size}`);
    console.log(`  sha512:  ${sha512}`);
    console.log(`  blockmap: ${path.basename(blockmapPath)} (${fs.statSync(blockmapPath).size} bytes)`);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
