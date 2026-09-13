const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const source = main.slice(main.indexOf('async function deleteBackup('), main.indexOf('async function createLoopbackListener'));
const target = path.resolve('config.toml');
const backup = `${target}.opentk-backup-2026-09-12T08-10-35-237Z`;

function saving(existingContent) {
  const writes = [];
  const copies = [];
  let stored = existingContent;
  const stamp = new Date('2026-09-12T08:10:35.237Z');
  const context = vm.createContext({
    path,
    findConfigPath: () => target,
    fs: {
      mkdir: async () => {},
      readFile: async () => {
        if (stored === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return stored;
      },
      stat: async () => ({ size: (stored || '').length, mtime: stamp }),
      copyFile: async (from, to) => copies.push([from, to]),
      writeFile: async (file, content) => { writes.push([file, content]); stored = content; }
    }
  });
  const saveSource = main.slice(main.indexOf('async function saveConfig('), main.indexOf('async function listBackups('));
  vm.runInContext(saveSource, context);
  return { run: context.saveConfig, writes, copies };
}

test('identical configuration skips write and redundant backup', async () => {
  const env = saving('same content');
  const result = await env.run(target, 'same content');
  assert.equal(result.unchanged, true);
  assert.equal(result.backupPath, null);
  assert.equal(env.writes.length, 0);
  assert.equal(env.copies.length, 0);
});

test('changed configuration still creates one backup before writing', async () => {
  const env = saving('old content');
  const result = await env.run(target, 'new content');
  assert.equal(result.unchanged, false);
  assert.equal(env.copies.length, 1);
  assert.deepEqual(env.writes, [[target, 'new content']]);
  assert.match(result.backupPath, /\.opentk-backup-/);
});

function deletion(response = 1, symlink = false) {
  const removed = [];
  let prompts = 0;
  const context = vm.createContext({
    path, mainWindow: {}, fs: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => symlink }) },
    dialog: { showMessageBox: async () => { prompts++; return { response }; } },
    shell: { trashItem: async (file) => removed.push(file) }
  });
  vm.runInContext(source, context);
  return { run: context.deleteBackup, removed, prompts: () => prompts };
}

test('backup deletion uses recycle bin after confirmation', async () => {
  const env = deletion();
  assert.equal((await env.run(target, backup)).canceled, false);
  assert.deepEqual(env.removed, [backup]);
});

test('cancel leaves backup untouched', async () => {
  const env = deletion(0);
  assert.equal((await env.run(target, backup)).canceled, true);
  assert.deepEqual(env.removed, []);
});

test('reject original, other directory, unrelated backup, and symlink', async () => {
  const env = deletion();
  for (const invalid of [target, path.join(path.dirname(target), 'other', path.basename(backup)), `${target}.opentk-backup-invalid`]) {
    await assert.rejects(env.run(target, invalid));
  }
  assert.equal(env.prompts(), 0);
  await assert.rejects(deletion(1, true).run(target, backup));
});

test('configuration language follows filename', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'editor-languages.js'), 'utf8'), context);
  const language = context.window.ConfigLanguages.languageForPath;
  assert.equal(language('C:\\config\\auth.json'), 'json');
  assert.equal(language('/config/config.toml'), 'toml');
  assert.equal(language('C:\\config\\.env'), 'dotenv');
  assert.equal(language('/config/.env.local'), 'dotenv');
  assert.equal(language('README.txt'), 'plaintext');
});

function configApply() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'config-apply.js'), 'utf8'), context);
  return context.window.ConfigApply;
}

test('API Key application updates only the custom provider fields', () => {
  const input = [
    'model = "keep"', '', '[model_providers.custom]', 'name = "Keep me"',
    'requires_openai_auth = true', 'requires_openai_auth = true',
    'http_headers = { old = "value" }', '', '[model_providers.other]',
    'requires_openai_auth = true', ''
  ].join('\n');
  const output = configApply().updateTomlProvider(input);
  assert.match(output, /\[model_providers\.custom\][\s\S]*name = "Keep me"/);
  assert.match(output, /requires_openai_auth = false/);
  assert.match(output, /http_headers = \{ "x-openai-actor-authorization" = "local-image-extension" \}/);
  assert.match(output, /env_key = "OPENAI_API_KEY"/);
  assert.equal((output.match(/requires_openai_auth = false/g) || []).length, 1);
  assert.match(output, /\[model_providers\.other\]\nrequires_openai_auth = true/);
});

test('API Key application creates provider section and updates dotenv without losing other entries', () => {
  const apply = configApply();
  const toml = apply.updateTomlProvider('model = "keep"\r\n');
  assert.match(toml, /\r\n\[model_providers\.custom\]\r\n/);
  const env = apply.updateEnv('KEEP=value\nOPENAI_API_KEY=old\nOPENAI_API_KEY=duplicate\n', 'new-key');
  assert.equal(env, 'KEEP=value\nOPENAI_API_KEY = new-key\n');
  assert.equal(apply.updateEnv('', 'new-key'), 'OPENAI_API_KEY = new-key\n');
});

test('Base URL application preserves provider section and supports custom values', () => {
  const apply = configApply();
  const input = '[model_providers.custom]\nname = "Keep"\nbase_url = "https://old.example"\n';
  const output = apply.updateBaseUrl(input, 'https://custom.example');
  assert.match(output, /name = "Keep"/);
  assert.match(output, /base_url = "https:\/\/custom\.example"/);
  assert.equal((output.match(/base_url\s*=/g) || []).length, 1);
});

test('opening backup switches inline editor and preserves current draft', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, {
        value: '', style: {}, scrollHeight: 360, textContent: '',
        classList: {
          add: (c) => classes.add(c), remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
          toggle: (c, enabled) => enabled ? classes.add(c) : classes.delete(c)
        },
        setAttribute: () => {},
        scrollTo: () => {}
      });
    }
    return elements.get(id);
  }
  let view;
  let contents;
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    api: { config: {
      readBackup: async () => ({ path: backup, content: 'old', name: 'backup', modifiedAt: '2026-09-12' })
    } },
    window: { ConfigDiff: {
      load: async () => ({}),
      create: () => ({ setContents: (...args) => { contents = args; }, clear: () => {} })
    } },
    saveConfig: () => {},
    showView: (id) => { view = id; },
    formatBackupTime: (v) => v,
    showToast: (message) => { throw new Error(message); },
    escapeHtml: (v) => v
  });
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  vm.runInContext(`
    let currentConfig = { path: 'config.toml' }, activeBackup = null;
    let diffRequest = 0, diffView = null, codeView = null;
    const editor = { value: 'unsaved draft' };
    const diffEditorFrame = document.querySelector('#diff-editor-frame');
    ${renderer.slice(renderer.indexOf('async function openDiff('), renderer.indexOf('async function loadConfig('))}
  `, context);
  await context.openDiff({ path: backup });
  assert.equal(element('#history-panel').classList.contains('hidden'), true);
  assert.equal(view, 'codex-view');
  assert.equal(element('#editor-frame').classList.contains('hidden'), true);
  assert.equal(element('#diff-editor-frame').classList.contains('hidden'), false);
  assert.deepEqual(contents, ['old', 'unsaved draft', 'config.toml']);
  context.closeDiffView();
  assert.equal(element('#editor-frame').classList.contains('hidden'), false);
});
