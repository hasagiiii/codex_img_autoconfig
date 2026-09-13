const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

test('GitHub release configuration targets this repository', () => {
  assert.equal(packageJson.build.publish.provider, 'github');
  assert.equal(packageJson.build.publish.owner, 'hasagiiii');
  assert.equal(packageJson.build.publish.repo, 'codex_img_autoconfig');
  assert.ok(packageJson.dependencies['electron-updater']);
  assert.match(packageJson.scripts['release:github'], /-Target nsis -Publish/);
});

test('desktop updater requires user confirmation before download and install', () => {
  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /process\.env\.PORTABLE_EXECUTABLE_FILE/);
  assert.match(main, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(main, /autoUpdater\.downloadUpdate\(\)/);
  assert.match(main, /autoUpdater\.quitAndInstall\(false, true\)/);
  assert.match(preload, /update:check/);
  assert.match(preload, /update:download/);
  assert.match(preload, /update:install/);
});

test('version tags publish a GitHub Release with repository token', () => {
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /npm run release:github/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test('GitHub publishing builds installer and portable artifacts', () => {
  const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-win.ps1'), 'utf8');
  assert.ok(buildScript.includes("@('--win', 'nsis', 'portable'"));
  assert.ok(packageJson.build.nsis);
  assert.ok(packageJson.build.portable);
});
