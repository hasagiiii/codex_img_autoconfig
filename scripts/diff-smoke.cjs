const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.join(__dirname, '..', '.test-output');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron-profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
const deadline = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1220, height: 800, show: false, frame: false,
    webPreferences: { preload: path.join(__dirname, 'diff-smoke-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) { errors.push(message); console.log('RENDERER:', message); }
  });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.equal(await evaluate(`document.querySelector('#oidc-panel').textContent.includes('Client Secret')`), false);
  assert.equal(await evaluate(`document.querySelector('#oidc-panel').textContent.includes('none + PKCE (S256)')`), true);
  assert.equal(await evaluate(`document.querySelector('#update-status').textContent`), '开发模式不支持在线更新');
  assert.equal(await evaluate(`document.querySelector('#check-update').disabled`), true);
  await evaluate(`Promise.all([initializeConfigFiles(), openDiff({path: 'backup'})])`);
  // Initialization can invalidate a pending open; open the selected backup after it settles.
  await evaluate(`openDiff({path: 'backup'})`);
  async function settled() {
    await evaluate(`new Promise((resolve, reject) => {
      const until = Date.now() + 10000;
      const check = () => {
        if (diffView?.view.getLineChanges()) return resolve();
        if (Date.now() > until) return reject(new Error('No computed diff: ' + document.querySelector('#toast').textContent));
        setTimeout(check, 50);
      };
      check();
    })`);
  }
  await settled();
  for (const [width, height] of [[1220, 800], [960, 650]]) {
    window.setSize(width, height);
    await evaluate('diffView.view.layout()');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = await evaluate(`(() => {
      const left = diffView.view.getOriginalEditor();
      const right = diffView.view.getModifiedEditor();
      return {
        visible: !diffEditorFrame.classList.contains('hidden'),
        leftTop: left.getTopForLineNumber(4), rightTop: right.getTopForLineNumber(3),
        leftWidth: left.getLayoutInfo().width, rightWidth: right.getLayoutInfo().width,
        readonly: left.getOption(monaco.editor.EditorOption.readOnly),
        writable: !right.getOption(monaco.editor.EditorOption.readOnly),
        background: getComputedStyle(document.querySelector('#monaco-diff .monaco-editor-background')).backgroundColor
      };
    })()`);
    assert.equal(state.visible, true);
    assert.equal(state.leftTop, state.rightTop, 'unchanged anchor must align');
    assert.ok(state.leftWidth > 100 && state.rightWidth > 100);
    assert.equal(state.readonly, true);
    assert.equal(state.writable, true);
    assert.equal(state.background, 'rgb(30, 30, 30)');
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, `diff-${width}.png`), image.toPNG());
    console.log('PASS', width, JSON.stringify(state));
    await evaluate('loadBackups()');
    assert.equal(await evaluate("document.querySelector('#history-count').textContent"), '2');
    await evaluate('setHistoryOpen(true)');
    const history = await evaluate(`(() => {
      const panel = document.querySelector('#history-panel').getBoundingClientRect();
      const name = document.querySelector('.backup-name');
      const remove = document.querySelector('.backup-delete');
      return {
        inBounds: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
        deleteText: remove.textContent,
        uniformFont: getComputedStyle(name).fontSize === getComputedStyle(remove).fontSize,
        caption: document.querySelector('#page-caption').textContent
      };
    })()`);
    assert.equal(history.inBounds, true);
    assert.equal(history.deleteText, '删除');
    assert.equal(history.uniformFont, true);
    assert.equal(history.caption.includes('OIDC'), false);
    fs.writeFileSync(path.join(output, `history-${width}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate('setHistoryOpen(false)');
    console.log('PASS history layout:', width);
    await evaluate(`setApiKeyMode('provider')`);
    assert.equal(await evaluate(`(() => {
      const button = document.querySelector('#api-key-login').getBoundingClientRect();
      const apply = document.querySelector('#apply-api-key').getBoundingClientRect();
      const loginStyle = getComputedStyle(document.querySelector('#api-key-login'));
      const applyStyle = getComputedStyle(document.querySelector('#apply-api-key'));
      const login = document.querySelector('#nav-login .nav-icon');
      const settings = document.querySelector('[data-view="oidc-view"] .nav-icon');
      return button.width === apply.width && button.height === apply.height && button.height === 28 &&
        document.querySelector('#manual-api-key').type === 'text' &&
        loginStyle.fontWeight === applyStyle.fontWeight && loginStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(login).fontFamily === getComputedStyle(settings).fontFamily &&
        getComputedStyle(login).fontSize === getComputedStyle(settings).fontSize;
    })()`), true);
    await evaluate(`document.querySelector('#api-key-login').click()`);
    assert.equal(await evaluate("loginDialog.open && document.querySelector('#codex-view').classList.contains('active')"), true);
    const dialogFits = await evaluate(`(() => {
      const bounds = loginDialog.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })()`);
    assert.equal(dialogFits, true);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, `login-${width}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('#close-login').click()`);
    assert.equal(await evaluate('loginDialog.open'), false);
    await evaluate(`document.querySelector('#nav-login').click()`);
    assert.equal(await evaluate("loginDialog.open && !document.querySelector('#nav-login').hasAttribute('data-view')"), true);
    await evaluate(`document.querySelector('#close-login').click()`);
    console.log('PASS both login dialog entries:', width);
  }
  window.setSize(960, 650);
  await evaluate(`showView('oidc-view'); document.querySelector('#oidc-panel').scrollTop = document.querySelector('#oidc-panel').scrollHeight`);
  await evaluate(`renderUpdateState({supported: true, status: 'available', currentVersion: '0.1.0', availableVersion: '0.1.1'})`);
  assert.equal(await evaluate(`!document.querySelector('#download-update').classList.contains('hidden') && document.querySelector('#install-update').classList.contains('hidden')`), true);
  await evaluate(`renderUpdateState({supported: true, status: 'downloading', currentVersion: '0.1.0', availableVersion: '0.1.1', percent: 47})`);
  assert.equal(await evaluate(`!document.querySelector('#update-progress').classList.contains('hidden') && document.querySelector('#update-progress-bar').style.width === '47%'`), true);
  await evaluate(`renderUpdateState({supported: true, status: 'downloaded', currentVersion: '0.1.0', availableVersion: '0.1.1', percent: 100})`);
  assert.equal(await evaluate(`!document.querySelector('#install-update').classList.contains('hidden') && document.querySelector('#download-update').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`(() => {
    const panel = document.querySelector('#oidc-panel').getBoundingClientRect();
    const update = document.querySelector('.update-settings').getBoundingClientRect();
    return update.top >= panel.top && update.bottom <= panel.bottom;
  })()`), true);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'settings-update.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS updater states and settings layout');
  await evaluate(`showView('codex-view')`);
  await evaluate(`document.querySelector('#nav-login').click(); login()`);
  await evaluate('loadApiKeys()');
  assert.equal(await evaluate(`!loginDialog.open && authenticated &&
    document.querySelector('#api-key-login').classList.contains('hidden') &&
    !document.querySelector('#api-key-controls').classList.contains('hidden') &&
    [...document.querySelector('#api-key-select').options].some(option => option.textContent === 'Test API Key')`), true);
  assert.equal(await evaluate(`document.querySelector('#api-key-mode-provider').textContent`), 'OpenTk');
  await evaluate(`document.querySelector('#nav-account').click()`);
  assert.equal(await evaluate(`(() => {
    const name = document.querySelector('#nav-account-name').getBoundingClientRect();
    const menu = document.querySelector('#account-menu').getBoundingClientRect();
    return menu.left - name.right >= 4 && menu.left - name.right <= 10;
  })()`), true);
  await evaluate(`closeAccountMenu()`);
  await evaluate('logout()');
  assert.equal(await evaluate(`!authenticated &&
    !document.querySelector('#api-key-login').classList.contains('hidden') &&
    document.querySelector('#api-key-controls').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`editor.value.includes('model = "new"')`), true);
  console.log('PASS login, API Key loading, logout, and draft preservation');
  await evaluate(`diffView.restore(activeBackup.content)`);
  assert.equal(await evaluate('editor.value === activeBackup.content'), true);
  await evaluate(`diffView.view.getModifiedEditor().trigger('test', 'undo', null)`);
  assert.equal(await evaluate('editor.value.includes(\'model = "new"\')'), true);
  for (const [name, left, right, leftLine, rightLine] of [
    ['insert', 'head\nanchor\ntail', 'head\nadded1\nadded2\nanchor\ntail', 2, 4],
    ['delete', 'head\nremoved1\nremoved2\nanchor\ntail', 'head\nanchor\ntail', 4, 2],
    ['multiple', 'head\nremoved\nsame\nanchor\ntail', 'head\nsame\nadded1\nadded2\nanchor\ntail', 4, 5]
  ]) {
    await evaluate(`diffView.setContents(${JSON.stringify(left)}, ${JSON.stringify(right)}, 'config.toml')`);
    await settled();
    const aligned = await evaluate(`diffView.view.getOriginalEditor().getTopForLineNumber(${leftLine}) === diffView.view.getModifiedEditor().getTopForLineNumber(${rightLine})`);
    assert.equal(aligned, true, `${name}: unchanged anchor must align`);
    console.log('PASS alignment:', name);
  }
  await evaluate(`new Promise(resolve => {
    const subscription = diffView.view.onDidUpdateDiff(() => { subscription.dispose(); resolve(); });
    diffView.view.getModifiedEditor().executeEdits('test', [{range: new monaco.Range(1,1,1,1), text: 'inserted\\n'}]);
  })`);
  assert.equal(await evaluate('diffView.view.getOriginalEditor().getTopForLineNumber(4) === diffView.view.getModifiedEditor().getTopForLineNumber(6)'), true);
  console.log('PASS alignment after editing');
  await evaluate(`diffView.setContents('head\\n' + 'a'.repeat(2000), 'head\\nshort', 'config.toml')`);
  await settled();
  await evaluate(`diffView.view.getOriginalEditor().revealLine(2); diffView.view.getOriginalEditor().render(true); diffView.view.getModifiedEditor().render(true);`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'diff-long.png'), (await window.webContents.capturePage()).toPNG());
  console.log('SCROLL METRICS', await evaluate(`JSON.stringify({
    left: diffView.view.getOriginalEditor().getScrollWidth(),
    length: diffView.view.getOriginalEditor().getModel().getLineContent(2).length,
    wordWrap: diffView.view.getOriginalEditor().getOption(monaco.editor.EditorOption.wordWrap),
    content: diffView.view.getOriginalEditor().getContentWidth(),
    width: diffView.view.getOriginalEditor().getLayoutInfo().contentWidth,
    bar: document.querySelector('#diff-horizontal-scroll').scrollWidth,
    barWidth: document.querySelector('#diff-horizontal-scroll').clientWidth
  })`));
  await evaluate(`const bar = document.querySelector('#diff-horizontal-scroll'); bar.scrollLeft = 150; bar.dispatchEvent(new Event('scroll'));`);
  assert.ok(await evaluate('diffView.view.getOriginalEditor().getScrollLeft() > 0'));
  console.log('PASS shared horizontal scrollbar');
  await evaluate('closeDiffView()');
  assert.equal(await evaluate('monaco.editor.getModels().length'), 1);
  const samples = [
    ['auth.json', 'json', '{\n  "OPENAI_API_KEY": "test-key",\n  "enabled": true,\n  "count": 42\n}\n', ['string', 'number']],
    ['config.toml', 'toml', '# Codex settings\nmodel = "test-model"\ncount = 42\nenabled = true\n[provider]\nurl = "https://example.test"\nitems = [1, 2, 3]\n', ['comment', 'key', 'string', 'number', 'keyword', 'type']],
    ['.env', 'dotenv', '# Environment\nAPI_KEY=test-key\nBASE_URL="https://example.test"\nexport TOKEN="${API_KEY}"\nPORT=8080\n', ['comment', 'key', 'string', 'variable.parameter', 'keyword']]
  ];
  for (const [name, language, content, required] of samples) {
    await evaluate(`renderConfig({path: ${JSON.stringify(name)}, exists: true, content: ${JSON.stringify(content)}, size: 100})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tokens = await evaluate(`monaco.editor.tokenize(${JSON.stringify(content)}, ${JSON.stringify(language)}).flat().map(t => t.type)`);
    assert.equal(await evaluate('codeView.view.getModel().getLanguageId()'), language);
    for (const type of required) assert.ok(tokens.some((token) => token.startsWith(type)), `${name} missing ${type}: ${tokens}`);
    assert.equal(await evaluate('editor.value === codeView.view.getValue()'), true);
    await evaluate(`codeView.view.render(true)`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(output, `syntax-${language}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(`codeView.view.executeEdits('test', [{range: new monaco.Range(1,1,1,1), text: ' '}])`);
    assert.equal(await evaluate("document.querySelector('#dirty-state').textContent"), '待保存');
    await evaluate("codeView.view.trigger('test', 'undo', null)");
    assert.equal(await evaluate('editor.value'), content);
    await evaluate(`openDiff({path: 'backup'})`);
    await settled();
    assert.equal(await evaluate('diffView.view.getOriginalEditor().getModel().getLanguageId()'), language);
    assert.equal(await evaluate('diffView.view.getModifiedEditor().getModel().getLanguageId()'), language);
    await evaluate('closeDiffView()');
    assert.equal(await evaluate('monaco.editor.getModels().length'), 1);
    console.log('PASS syntax, editing, undo, and diff language:', language);
  }
  await evaluate(`drafts.clear(); currentConfig = null; initializeConfigFiles()`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').value`), 'fake-existing-key');
  assert.equal(await evaluate(`configFiles.some(file => file.name === '.env')`), false);
  await evaluate(`login().then(loadApiKeys)`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').value`), 'fake-existing-key');
  assert.equal(await evaluate(`document.querySelector('#manual-key-status').textContent.includes('第三方 Key')`), true);
  await evaluate(`loadConfig(() => api.config.read(authConfig.path))`);
  await evaluate(`codeView.setValue(JSON.stringify({OPENAI_API_KEY: 'fake-editor-key', other: 42}))`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').value`), 'fake-editor-key');
  await evaluate(`openDiff({path: 'backup'})`);
  await evaluate(`diffView.restore(JSON.stringify({OPENAI_API_KEY: 'fake-diff-key', other: 42}))`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').value`), 'fake-diff-key');
  await evaluate(`setManualKey('fake-diff-manual')`);
  assert.equal(await evaluate(`JSON.parse(diffView.view.getModifiedEditor().getValue()).OPENAI_API_KEY`), 'fake-diff-manual');
  await evaluate(`closeDiffView(); codeView.setValue('{invalid')`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').disabled`), true);
  await evaluate(`setManualKey('must-not-overwrite')`);
  assert.equal(await evaluate('editor.value'), '{invalid');
  await evaluate(`codeView.setValue('{"OPENAI_API_KEY":"fake-existing-key","tokens":{"preserved":true}}')`);
  await evaluate(`document.querySelector('#api-key-select').value = 'test'; document.querySelector('#api-key-select').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`JSON.parse(editor.value).OPENAI_API_KEY`), 'fake-test-key');
  await evaluate(`applyApiKey()`);
  assert.equal(await evaluate(`api.config.read(authConfig.path).then(file => JSON.parse(file.content).OPENAI_API_KEY)`), 'fake-test-key');
  assert.equal(await evaluate(`api.config.read(authConfig.path).then(file => JSON.parse(file.content).tokens.preserved)`), true);
  assert.equal(await evaluate(`api.config.read('C:\\\\test\\\\config.toml').then(file => file.content.includes('requires_openai_auth = false') && file.content.includes('env_key = "OPENAI_API_KEY"') && file.content.includes('x-openai-actor-authorization'))`), true);
  assert.equal(await evaluate(`api.config.read('C:\\\\test\\\\.env').then(file => file.content === 'OPENAI_API_KEY = fake-test-key\\n')`), true);
  assert.equal(await evaluate(`configFiles.some(file => file.name === '.env')`), true);
  await evaluate(`logout()`);
  assert.equal(await evaluate(`document.querySelector('#manual-api-key').value`), 'fake-test-key');
  await evaluate(`loadConfig(() => api.config.read(configFiles.find(file => file.name === '.env').path))`);
  await evaluate(`testFixture.removeEnv(); loadConfig(() => api.config.read(currentConfig.path))`);
  assert.equal(await evaluate(`currentConfig.path.endsWith('config.toml') && !configFiles.some(file => file.name === '.env')`), true);
  assert.equal(await evaluate(`document.querySelector('#config-file-list').textContent.includes('.env')`), false);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(output, 'manual-api-key.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS third-party API Key, apply to three files, editor/diff sync, preservation, Provider selection, logout, and .env lifecycle');
  assert.equal(errors.filter((message) => /Refused to|Could not create web worker|Uncaught/.test(message)).length, 0, errors.join('\n'));
  console.log('PASS restore, undo, disposal, and CSP/worker checks');
  clearTimeout(deadline);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
