// Write the electron-updater configuration into a prepackaged app directory.
//
// `electron-builder --prepackaged` does not run the normal publish manager, so
// it does not create resources/app-update.yml. The signing workflow packages
// the installers from a signed `dist/win-unpacked` directory, which means the
// updater file must be added there before that step.
//
// This script mirrors the relevant electron-builder settings:
// build.publish (GitHub) and win.signtoolOptions.publisherName.
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(DIST, 'win-unpacked', 'resources', 'app-update.yml');

function fail(message) {
    console.error(`[prepare-app-update] ${message}`);
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};
const publish = Array.isArray(build.publish) ? build.publish[0] : build.publish;
if (!publish || publish.provider !== 'github' || !publish.owner || !publish.repo) {
    fail('package.json build.publish must contain a GitHub provider with owner and repo');
}

const configuredPublisherName = build.win && build.win.signtoolOptions
    ? build.win.signtoolOptions.publisherName
    : null;

// The workflow passes the actual signer subject after SignPath has signed the
// application, so app-update.yml matches the certificate even if its subject
// formatting differs from the configured DN.
const publisherArgIndex = process.argv.indexOf('--publisher-name');
const publisherName = publisherArgIndex >= 0
    ? process.argv[publisherArgIndex + 1]
    : (process.env.SIGNPATH_PUBLISHER_NAME || configuredPublisherName);
if (!publisherName) {
    fail('no publisher name; pass --publisher-name or set build.win.signtoolOptions.publisherName');
}

const updaterCacheDirName = `${String(pkg.name || '').toLowerCase()}-updater`;
if (!pkg.name) fail('package.json name is required for updaterCacheDirName');

const doc = {
    provider: 'github',
    owner: publish.owner,
    repo: publish.repo,
    updaterCacheDirName,
    publisherName: Array.isArray(publisherName) ? publisherName : [publisherName],
};

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, yaml.dump(doc, { lineWidth: -1, noRefs: true }), 'utf8');

console.log(`[prepare-app-update] wrote ${path.relative(ROOT, TARGET)}`);
console.log(`  publisher: ${doc.publisherName.join(', ')}`);
