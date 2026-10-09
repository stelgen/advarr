#!/usr/bin/env node
// Advarr — release hygiene bot (release-gate job 1).
// Verifies that a release tag matches EVERY source of version truth in the repo:
//   package.json / server.js APP_VERSION / Dockerfile OCI label / CHANGELOG section.
// Zero deps, no network. Exit 1 on any mismatch → release is not published.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const args = process.argv.slice(2);
const tagIdx = args.indexOf('--tag');
const tag = tagIdx >= 0 ? args[tagIdx + 1] : '';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

check('tag format v<major>.<minor>.<patch>', /^v\d+\.\d+\.\d+$/.test(tag), `got "${tag}"`);

const pkg = JSON.parse(read('package.json'));
const server = read('server.js');
const dockerfile = read('Dockerfile');
const changelog = read('CHANGELOG.md');

const appVersion = (server.match(/const APP_VERSION = '([\d.]+)';/) || [])[1];
const dockerVersion = (dockerfile.match(/org\.opencontainers\.image\.version="([\d.]+)"/) || [])[1];
const bare = tag.replace(/^v/, '');

check('package.json.version == tag', bare === pkg.version, `${pkg.version} vs ${tag}`);
check('server.js APP_VERSION == tag', bare === appVersion, `${appVersion} vs ${tag}`);
check('Dockerfile OCI label version == tag', bare === dockerVersion, `${dockerVersion} vs ${tag}`);
check(
  'CHANGELOG.md has a section for this version',
  new RegExp(`^## ${bare.replace(/\./g, '\\.')}\\b`, 'm').test(changelog),
  `expected "## ${bare}" header`,
);

// data integrity: all declared sources must exist and be parseable
check('version declared in all four sources', Boolean(bare && pkg.version && appVersion && dockerVersion));

const failed = results.filter((r) => !r.ok);
console.log(`\nrelease hygiene: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`::error::release hygiene failed for ${tag} — fix versions before release`);
  process.exit(1);
}