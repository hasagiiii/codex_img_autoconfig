const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const rendererIndex = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const rendererStyles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
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

test('ChatGPT restart retries macOS launch and terminates all matching processes', () => {
  assert.match(main, /let restartChatGPTPromise = null/);
  assert.match(main, /\['-x', 'ChatGPT'\]/);
  assert.match(main, /\['-f', '\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT'\]/);
  assert.match(main, /execFileAsync\('pkill', \['-TERM', \.\.\.args\]\)/);
  assert.match(main, /execFileAsync\('pkill', \['-KILL', \.\.\.args\]\)/);
  assert.match(main, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
});

test('left navigation supports a persisted collapsed mode', () => {
  assert.match(rendererIndex, /id="nav-collapse"/);
  assert.match(rendererIndex, /aria-label="收起菜单"/);
  assert.match(rendererIndex, /<div class="nav-footer">\s*<button class="nav-collapse"[\s\S]*?<div class="nav-bottom-links">/);
  assert.match(renderer, /const navCollapseKey = 'codex-config-nav-collapsed'/);
  assert.match(renderer, /localStorage\.setItem\(navCollapseKey/);
  assert.match(renderer, /collapsed \? '展开菜单' : '收起菜单'/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \{ grid-template-columns: 68px/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.nav-collapse \{ align-self: center; margin: 1px 0;/);
  assert.match(rendererStyles, /transition: grid-template-columns \.26s ease/);
  assert.match(rendererStyles, /\.brand-copy \{[^}]*transition: max-width \.22s ease, opacity \.16s ease, visibility 0s linear \.22s/);
  assert.match(rendererStyles, /\.brand-mark \{[^}]*flex: 0 0 34px/);
  assert.match(rendererStyles, /\.nav-icon \{[^}]*flex: 0 0 17px/);
  assert.match(rendererStyles, /\.nav-header \{[^}]*height: 34px/);
  assert.match(rendererStyles, /\.brand-copy \{[^}]*height: 34px[^}]*white-space: nowrap/);
  assert.match(rendererStyles, /\.nav-section-title \{ height: 17px; max-height: 17px/);
  assert.match(rendererStyles, /\.nav-item > span:not\(\.nav-icon\), \.nav-login > span:not\(\.nav-icon\), #nav-account-name \{[^}]*visibility: visible[^}]*transition: max-width \.22s ease/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.app-nav \{ padding-right: 10px; padding-left: 10px;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.brand \{ justify-content: center; gap: 0; padding-left: 0;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.nav-item,\s*\.app-shell\.nav-collapsed \.nav-login \{ justify-content: center; gap: 0; padding-right: 0; padding-left: 0; overflow: hidden;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.brand \{ justify-content: center; gap: 0; padding-left: 0;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.nav-account \{ width: 100%; justify-content: center; gap: 0;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.nav-item \{ width: 40px; height: 40px; justify-self: center;/);
  assert.match(rendererStyles, /\.app-shell\.nav-collapsed \.nav-account \{ width: 100%; justify-content: center;/);
  assert.doesNotMatch(rendererStyles, /\.app-shell\.nav-collapsed \.nav-section-title \{ max-height: 0/);
});

test('model inputs provide filtered autocomplete suggestions', () => {
  assert.match(rendererIndex, /id="custom-model-menu"/);
  assert.match(renderer, /function matchingModels\(models, query = ''\)/);
  assert.match(renderer, /showModelSuggestions\(value\)/);
  assert.match(renderer, /renderCustomModelSuggestions\(value\)/);
  assert.match(renderer, /modelSuggestionSource\(\)/);
  assert.match(rendererStyles, /\.custom-model-menu \{ top: 34px;/);
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

test('macOS builds publish dmg and zip artifacts for both architectures', () => {
  const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-mac.cjs'), 'utf8');
  assert.equal(packageJson.scripts['build:mac'], 'node ./scripts/build-mac.cjs');
  assert.equal(packageJson.scripts['release:mac'], 'node ./scripts/build-mac.cjs --publish');
  assert.deepEqual(packageJson.build.mac.target, [
    { target: 'dmg', arch: ['x64', 'arm64'] },
    { target: 'zip', arch: ['x64', 'arm64'] }
  ]);
  assert.match(buildScript, /process\.platform !== 'darwin'/);
  assert.match(buildScript, /--publish/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /npm run release:mac/);
});

test('application icon and user data directory use the supplied app identity', () => {
  assert.equal(packageJson.build.win.icon, 'assets/app-icon.ico');
  assert.equal(packageJson.build.mac.icon, 'assets/app-icon.icns');
  assert.match(packageJson.build.files.join('\n'), /assets\/\*\*\//);
  assert.match(main, /app\.setName\('codex_img_autoconfig'\)/);
  assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'codex_img_autoconfig'\)\)/);
  assert.match(main, /assets', 'app-icon\.png'/);
  assert.ok(fs.existsSync(path.join(root, 'assets', 'app-icon.png')));
  assert.ok(fs.existsSync(path.join(root, 'assets', 'app-icon.ico')));
  assert.ok(fs.existsSync(path.join(root, 'assets', 'app-icon.icns')));
});
