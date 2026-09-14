const api = window.desktopApi;
const editor = { value: '' };
let codeView = null;
const toast = document.querySelector('#toast');
const diffEditorFrame = document.querySelector('#diff-editor-frame');
let diffView = null;

let currentConfig = null;
let savedContent = '';
let oidcSettings = null;
let apiKeys = [];
let backups = [];
let configFiles = [];
let toastTimer;
let activeBackup = null;
let diffRequest = 0;
let authenticated = false;
let apiKeyRequest = 0;
let backupRequest = 0;
let providerKeysLoaded = false;
let apiKeyMode = 'provider';
let apiKeyModeTouched = false;
let baseUrl = 'https://opentk.ai';
let updaterState = null;
const drafts = new Map();
let authConfig = null;
const loginDialog = document.querySelector('#login-dialog');
const closeChoiceDialog = document.querySelector('#close-choice-dialog');
let loginInFlight = false;
let loginAttempt = 0;

function isAuthFile(path) {
  return /(^|[\\/])auth\.json$/i.test(path || '');
}

function parseAuth(content) {
  const value = JSON.parse(content || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('auth.json 必须是 JSON 对象');
  return value;
}

function authDraft() {
  if (!authConfig) return null;
  if (currentConfig?.path === authConfig.path) return { content: editor.value, saved: savedContent };
  return drafts.get(authConfig.path) || { content: authConfig.content || '', saved: authConfig.content || '' };
}

function extractBaseUrl(content) {
  const match = String(content || '').match(/^\s*base_url\s*=\s*["']([^"']+)["']/mi);
  return match?.[1] || 'https://opentk.ai';
}

function renderBaseUrl(value) {
  baseUrl = value || 'https://opentk.ai';
  document.querySelector('#base-url-input').value = baseUrl;
}

function renderApiKeyMode() {
  const provider = apiKeyMode === 'provider';
  document.querySelector('#api-key-mode-provider').classList.toggle('active', provider);
  document.querySelector('#api-key-mode-provider').setAttribute('aria-selected', String(provider));
  document.querySelector('#api-key-mode-manual').classList.toggle('active', !provider);
  document.querySelector('#api-key-mode-manual').setAttribute('aria-selected', String(!provider));
  document.querySelector('#api-key-provider-panel').classList.remove('hidden');
  document.querySelector('#api-key-manual-panel').classList.add('hidden');
  document.querySelector('#api-key-status').classList.toggle('hidden', !authenticated);
}

function setApiKeyMode(mode, touched = true) {
  apiKeyMode = mode === 'manual' ? 'manual' : 'provider';
  if (touched) apiKeyModeTouched = true;
  renderApiKeyMode();
}

function syncManualKey() {
  const input = document.querySelector('#manual-api-key');
  const comboInput = document.querySelector('#api-key-input');
  const status = document.querySelector('#manual-key-status');
  const draft = authDraft();
  input.disabled = !draft;
  const applyButton = document.querySelector('#apply-api-key');
  applyButton.disabled = !draft;
  if (!draft) return;
  try {
    const data = parseAuth(draft.content);
    input.value = typeof data.OPENAI_API_KEY === 'string' ? data.OPENAI_API_KEY : '';
    comboInput.value = input.value;
    const selected = apiKeys.find((key) => key.value === input.value);
    document.querySelector('#api-key-select').value = selected?.id || '';
    applyButton.disabled = !input.value;
    const thirdParty = providerKeysLoaded && input.value && !selected;
    if (thirdParty || (!apiKeyModeTouched && input.value && !providerKeysLoaded)) setApiKeyMode('manual', false);
    else if (!apiKeyModeTouched) setApiKeyMode('provider', false);
    const origin = providerKeysLoaded && input.value ? (selected ? 'Provider Key' : '第三方 Key（来自 auth.json）') : '';
    const pending = draft.content !== draft.saved ? '待应用' : '';
    status.textContent = [origin, pending].filter(Boolean).join(' · ');
    status.classList.toggle('third-party', Boolean(thirdParty));
  } catch {
    input.value = '';
    input.disabled = true;
    applyButton.disabled = true;
    status.textContent = 'auth.json 格式错误，请先在编辑器中修正';
    status.classList.remove('third-party');
  }
}

function setManualKey(value) {
  const draft = authDraft();
  if (!draft) return;
  try {
    const data = parseAuth(draft.content);
    data.OPENAI_API_KEY = value;
    const content = JSON.stringify(data, null, 2) + '\n';
    drafts.set(authConfig.path, { content, saved: draft.saved });
    if (currentConfig?.path === authConfig.path) {
      editor.value = content;
      if (activeBackup) diffView?.restore(content);
      else codeView?.setValue(content);
      updateDirtyState();
    }
    syncManualKey();
  } catch {
    showToast('auth.json 格式错误，未修改文件', true);
  }
}

function samePath(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

async function fileDraft(file) {
  if (samePath(currentConfig?.path, file.path)) return { ...file, content: editor.value };
  const draft = drafts.get(file.path);
  if (draft) return { ...file, content: draft.content };
  return api.config.read(file.path);
}

async function applyApiKey() {
  const button = document.querySelector('#apply-api-key');
  const input = document.querySelector('#manual-api-key');
  const key = input.value;
  if (!key || button.disabled) return;
  button.disabled = true;
  input.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    if (/\r|\n/.test(key)) throw new Error('API Key 不能包含换行符');
    const authFile = configFiles.find((file) => file.name === 'auth.json');
    const tomlFile = configFiles.find((file) => file.name === 'config.toml');
    if (!authFile || !tomlFile) throw new Error('没有找到 Codex 配置目录');
    const envFile = configFiles.find((file) => file.name === '.env') || {
      name: '.env', path: authFile.path.replace(/[^\\/]+$/, '.env'), exists: false
    };
    const [authSource, tomlSource, envSource] = await Promise.all([
      fileDraft(authFile), fileDraft(tomlFile), fileDraft(envFile)
    ]);
    const selectedBaseUrl = document.querySelector('#base-url-input').value.trim();
    baseUrl = selectedBaseUrl;
    const authData = parseAuth(authSource.content);
    authData.OPENAI_API_KEY = key;
    const contents = new Map([
      [authFile.path, `${JSON.stringify(authData, null, 2)}\n`],
      [tomlFile.path, window.ConfigApply.updateBaseUrl(window.ConfigApply.updateTomlProvider(tomlSource.content || ''), selectedBaseUrl)],
      [envFile.path, window.ConfigApply.updateEnv(envSource.content || '', key)]
    ]);
    const results = new Map();
    for (const [path, content] of contents) results.set(path, await api.config.save(path, content));
    for (const [path, content] of contents) drafts.set(path, { content, saved: content });
    authConfig = { ...authSource, ...results.get(authFile.path), content: contents.get(authFile.path), exists: true };

    const activeContent = contents.get(currentConfig?.path);
    if (activeContent !== undefined) {
      const updated = { ...currentConfig, ...results.get(currentConfig.path), content: activeContent, exists: true };
      currentConfig = null;
      renderConfig(updated);
    }
    await loadConfigFiles();
    syncManualKey();
    const changed = [...results.values()].some((result) => !result.unchanged);
    const restart = await api.codex.restart();
    showToast(changed
      ? (restart.restarted ? 'API Key 和 Base URL 已应用，Codex 已重启' : '配置已应用，但未检测到 Codex 进程')
      : (restart.restarted ? '配置内容未变化，未创建备份；Codex 已重启' : '配置内容未变化，未创建备份'));
  } catch (error) {
    showToast(`应用失败：${error.message}`, true);
  } finally {
    button.removeAttribute('aria-busy');
    syncManualKey();
  }
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3400);
}

function renderUpdateState(state) {
  updaterState = state || {};
  const status = document.querySelector('#update-status');
  const version = document.querySelector('#update-version');
  const progress = document.querySelector('#update-progress');
  const progressBar = document.querySelector('#update-progress-bar');
  const checkButton = document.querySelector('#check-update');
  const downloadButton = document.querySelector('#download-update');
  const installButton = document.querySelector('#install-update');
  const percent = Math.round(Number(updaterState.percent) || 0);
  const labels = {
    idle: '尚未检查更新',
    unsupported: updaterState.unsupportedReason === 'portable'
      ? '便携版不支持在线更新，请安装正式版'
      : '开发模式不支持在线更新',
    checking: '正在检查更新...',
    available: `发现新版本 ${updaterState.availableVersion || ''}`.trim(),
    'up-to-date': '当前已是最新版本',
    downloading: `正在下载更新 ${percent}%`,
    downloaded: `版本 ${updaterState.availableVersion || ''} 已下载`.trim(),
    error: `更新失败：${updaterState.error || '未知错误'}`
  };
  status.textContent = labels[updaterState.status] || labels.idle;
  version.textContent = `当前版本：${updaterState.currentVersion || '-'}`;
  const downloading = updaterState.status === 'downloading';
  progress.classList.toggle('hidden', !downloading);
  progressBar.style.width = `${percent}%`;
  checkButton.disabled = !updaterState.supported || ['checking', 'downloading'].includes(updaterState.status);
  downloadButton.classList.toggle('hidden', updaterState.status !== 'available');
  installButton.classList.toggle('hidden', updaterState.status !== 'downloaded');
}

async function loadUpdateStatus() {
  try { renderUpdateState(await api.update.status()); }
  catch (error) { renderUpdateState({ status: 'error', error: error.message, currentVersion: '-' }); }
}

async function runUpdateAction(action, button) {
  if (button.disabled) return;
  button.disabled = true;
  try { renderUpdateState(await action()); }
  catch (error) {
    renderUpdateState({ ...updaterState, status: 'error', error: error.message });
    showToast(`更新失败：${error.message}`, true);
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function initializeCodeEditor() {
  try {
    const monaco = await window.ConfigDiff.load();
    codeView = window.ConfigEditor.create(monaco, document.querySelector('#config-editor'),
      (content) => { editor.value = content; updateDirtyState(); },
      updateCursor, saveConfig);
    codeView.setContents(editor.value, currentConfig?.path || '');
  } catch (error) { showToast(`编辑器加载失败：${error.message}`, true); }
}

function updateDirtyState() {
  const dirty = editor.value !== savedContent;
  const label = document.querySelector('#dirty-state');
  label.textContent = dirty ? '待保存' : '未修改';
  label.style.color = dirty ? 'var(--warning)' : '';
  if (isAuthFile(currentConfig?.path)) syncManualKey();
}

function updateCursor(position = codeView?.view.getPosition()) {
  document.querySelector('#cursor-position').textContent = `第 ${position?.lineNumber || 1} 行，第 ${position?.column || 1} 列`;
}

function renderConfig(config) {
  if (currentConfig) drafts.set(currentConfig.path, { content: editor.value, saved: savedContent });
  closeDiffView();
  currentConfig = config;
  if (isAuthFile(config.path)) authConfig = config;
  const draft = drafts.get(config.path);
  savedContent = draft?.saved ?? config.content ?? '';
  editor.value = draft?.content ?? savedContent;
  document.querySelector('#config-path').textContent = config.path;
  document.querySelector('#config-format').textContent = config.format || 'TEXT';
  document.querySelector('#config-size').textContent = formatBytes(config.size);
  document.querySelector('#config-state').textContent = config.exists ? '已读取' : '等待创建';
  document.querySelector('#status-dot').classList.toggle('ready', Boolean(config.exists));
  document.querySelector('#editor-subtitle').textContent = config.exists ? '保存时会自动生成备份' : '保存后会创建此文件';
  codeView?.setContents(editor.value, config.path);
  if (config.name === 'config.toml' || /config\.toml$/i.test(config.path || '')) renderBaseUrl(extractBaseUrl(config.content));
  updateDirtyState();
  updateCursor();
  renderConfigFiles();
  loadBackups();
}

function renderConfigFiles() {
  const list = document.querySelector('#config-file-list');
  list.innerHTML = '';
  if (!configFiles.length) {
    list.innerHTML = '<div class="file-list-loading">没有找到配置文件</div>';
    return;
  }
  configFiles.forEach((file) => {
    const button = document.createElement('button');
    button.className = `config-file-item${currentConfig?.path === file.path ? ' active' : ''}`;
    button.innerHTML = `<span class="file-item-name">${escapeHtml(file.name)}</span><span class="file-item-state">${file.exists ? '已存在' : '待创建'}</span>`;
    button.addEventListener('click', () => loadConfig(() => api.config.read(file.path)));
    list.appendChild(button);
  });
}

function renderConfigDirectory(info) {
  const pathElement = document.querySelector('#config-directory-path');
  const modeElement = document.querySelector('#config-directory-mode');
  const resetButton = document.querySelector('#reset-config-directory');
  pathElement.textContent = info.directory || '未找到配置目录';
  pathElement.title = info.directory || '';
  modeElement.textContent = info.customized ? '自定义' : '默认';
  resetButton.classList.toggle('hidden', !info.customized);
}

async function loadConfigDirectory() {
  try {
    renderConfigDirectory(await api.config.directory());
  } catch (error) {
    document.querySelector('#config-directory-path').textContent = `读取失败：${error.message}`;
  }
}

async function loadConfigFiles() {
  try {
    const previousEnv = configFiles.find((file) => file.name === '.env');
    const nextFiles = await api.config.listFiles();
    if (previousEnv && !nextFiles.some((file) => samePath(file.path, previousEnv.path))) drafts.delete(previousEnv.path);
    configFiles = nextFiles;
    if (currentConfig && /(^|[\\/])\.env$/i.test(currentConfig.path) &&
        !configFiles.some((file) => file.path === currentConfig.path)) {
      drafts.delete(currentConfig.path);
      const fallback = configFiles.find((file) => file.name === 'config.toml') || configFiles[0];
      if (fallback) await loadConfig(() => api.config.read(fallback.path));
    }
    renderConfigFiles();
  } catch (error) {
    document.querySelector('#config-file-list').innerHTML = `<div class="file-list-loading error-text">文件列表读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function formatBackupTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function loadBackups() {
  const list = document.querySelector('#backup-list');
  const count = document.querySelector('#history-count');
  const targetPath = currentConfig?.path;
  const request = ++backupRequest;
  count.textContent = '-';
  if (!targetPath) return;
  try {
    const result = await api.config.listBackups(targetPath);
    if (request !== backupRequest || targetPath !== currentConfig?.path) return;
    backups = result;
    count.textContent = String(backups.length);
    list.innerHTML = '';
    if (!backups.length) {
      list.innerHTML = '<div class="backup-empty">暂无历史版本</div>';
      return;
    }
    backups.forEach((backup) => {
      const row = document.createElement('div');
      row.className = 'backup-list-row';
      const button = document.createElement('button');
      button.className = `backup-item${activeBackup?.path === backup.path ? ' active' : ''}`;
      button.dataset.backupPath = backup.path;
      button.title = backup.name;
      button.innerHTML = `<span class="backup-name">${escapeHtml(backup.name)}</span><span class="backup-time">${formatBackupTime(backup.modifiedAt)}</span>`;
      button.addEventListener('click', () => openDiff(backup));
      const remove = document.createElement('button');
      remove.className = 'backup-delete';
      remove.textContent = '删除';
      remove.type = 'button';
      remove.title = `删除备份：${backup.name}`;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', async () => {
        const targetPath = currentConfig?.path;
        remove.disabled = true;
        try {
          const result = await api.config.deleteBackup(targetPath, backup.path);
          if (!result.canceled) {
            if (activeBackup?.path === backup.path) closeDiffView();
            if (targetPath === currentConfig?.path) await loadBackups();
            showToast('备份已移到回收站');
          }
        } catch (error) { showToast(`删除失败：${error.message}`, true); }
        finally { remove.disabled = false; }
      });
      row.append(button, remove);
      list.appendChild(row);
    });
  } catch (error) {
    if (request !== backupRequest || targetPath !== currentConfig?.path) return;
    count.textContent = '-';
    list.innerHTML = `<div class="backup-empty error-text">备份读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function openDiff(backup) {
  const request = ++diffRequest;
  const targetPath = currentConfig?.path;
  try {
    const [snapshot, monaco] = await Promise.all([api.config.readBackup(backup.path), window.ConfigDiff.load()]);
    if (request !== diffRequest || targetPath !== currentConfig?.path) return;
    setHistoryOpen(false);
    showView('codex-view');
    activeBackup = snapshot;
    document.querySelector('#diff-backup-meta').textContent = `${snapshot.name} · ${formatBackupTime(snapshot.modifiedAt)}`;
    document.querySelector('#diff-current-meta').textContent = currentConfig?.path || '当前配置';
    document.querySelector('#editor-subtitle').textContent = '正在对比备份，右侧内容可编辑';
    document.querySelector('#editor-frame').classList.add('hidden');
    diffEditorFrame.classList.remove('hidden');
    document.querySelector('#close-diff').classList.remove('hidden');
    document.querySelectorAll('.backup-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.backupPath === backup.path);
    });
    if (!diffView) {
      diffView = window.ConfigDiff.create(
        monaco, document.querySelector('#monaco-diff'),
        document.querySelector('#diff-horizontal-scroll'), document.querySelector('#diff-horizontal-spacer'),
        (content) => { editor.value = content; updateDirtyState(); },
        (status) => { document.querySelector('#diff-status').textContent = status; },
        (position) => { document.querySelector('#cursor-position').textContent = `第 ${position.lineNumber} 行，第 ${position.column} 列`; },
        saveConfig
      );
    }
    diffView.setContents(snapshot.content, editor.value, targetPath);
  } catch (error) { showToast(`读取备份失败：${error.message}`, true); }
}

function setHistoryOpen(open) {
  document.querySelector('#history-panel').classList.toggle('hidden', !open);
  document.querySelector('#history-toggle').setAttribute('aria-expanded', String(open));
}

function closeDiffView() {
  diffRequest++;
  activeBackup = null;
  diffView?.clear();
  codeView?.setValue(editor.value);
  document.querySelectorAll('.backup-item.active').forEach((item) => item.classList.remove('active'));
  if (!diffEditorFrame) return;
  diffEditorFrame.classList.add('hidden');
  document.querySelector('#editor-frame').classList.remove('hidden');
  document.querySelector('#close-diff').classList.add('hidden');
  document.querySelector('#reload-config').classList.remove('hidden');
  const subtitle = document.querySelector('#editor-subtitle');
  if (currentConfig) subtitle.textContent = currentConfig.exists ? '保存时会自动生成备份' : '保存后会创建此文件';
}

async function loadConfig(loader = api.config.read) {
  try {
    const config = await loader();
    if (!config.exists && /(^|[\\/])\.env$/i.test(config.path)) {
      await loadConfigFiles();
      const fallback = configFiles.find((file) => file.name === 'config.toml') || configFiles[0];
      if (fallback) renderConfig(await api.config.read(fallback.path));
      return;
    }
    renderConfig(config);
  }
  catch (error) { showToast(`读取失败：${error.message}`, true); }
}

async function saveConfig() {
  if (!currentConfig) return;
  try {
    const target = currentConfig.path;
    const content = editor.value;
    const result = await api.config.save(target, content);
    const latest = currentConfig?.path === target ? editor.value : (drafts.get(target)?.content ?? content);
    drafts.set(target, { content: latest, saved: content });
    if (isAuthFile(target)) authConfig = { ...authConfig, ...result, path: target, content, exists: true };
    if (currentConfig?.path !== target) { syncManualKey(); return; }
    savedContent = content;
    currentConfig = { ...currentConfig, ...result, exists: true };
    document.querySelector('#config-size').textContent = formatBytes(result.size);
    document.querySelector('#config-state').textContent = '已保存';
    document.querySelector('#status-dot').classList.add('ready');
    updateDirtyState();
    await loadConfigFiles();
    await loadBackups();
    showToast(result.unchanged ? '内容未变化，未创建备份' : (result.backupPath ? '配置已保存，并创建了备份' : '配置已保存'));
  } catch (error) { showToast(`保存失败：${error.message}`, true); }
}

function renderApiKeys(keys) {
  apiKeys = Array.isArray(keys) ? keys : [];
  const select = document.querySelector('#api-key-select');
  const menu = document.querySelector('#api-key-menu');
  menu.innerHTML = '';
  select.innerHTML = '';
  if (!apiKeys.length) {
    select.add(new Option('没有可用 API Key', ''));
    select.disabled = true;
    document.querySelector('#api-key-status').textContent = 'Provider 没有返回 API Key。';
    syncManualKey();
    return;
  }
  select.add(new Option('选择 Provider API Key', ''));
  apiKeys.forEach((key) => select.add(new Option(key.label, key.id)));
  apiKeys.forEach((key) => {
    const option = document.createElement('button');
    option.type = 'button'; option.role = 'option'; option.dataset.keyId = key.id;
    option.textContent = key.label;
    option.addEventListener('click', () => {
      document.querySelector('#api-key-input').value = key.value;
      setManualKey(key.value);
      menu.classList.add('hidden');
      document.querySelector('#api-key-toggle').setAttribute('aria-expanded', 'false');
    });
    menu.append(option);
  });
  select.disabled = false;
  syncManualKey();
  document.querySelector('#api-key-status').textContent = `已加载 ${apiKeys.length} 个 API Key。`;
}

async function loadApiKeys() {
  if (!authenticated) return;
  const request = ++apiKeyRequest;
  const status = document.querySelector('#api-key-status');
  status.textContent = '正在从 OIDC Resource API 获取...';
  try {
    const keys = await api.oidc.apiKeys();
    if (request === apiKeyRequest && authenticated) {
      providerKeysLoaded = true;
      renderApiKeys(keys);
    }
  } catch (error) {
    if (request !== apiKeyRequest || !authenticated) return;
    document.querySelector('#api-key-select').disabled = true;
    status.textContent = error.message;
  }
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
  const titles = {
    'codex-view': ['Codex配置', '读取和编辑本机 Codex 配置文件'],
    'oidc-view': ['配置', '管理 OIDC Provider 和登录参数']
  };
  const [title, caption] = titles[viewId] || titles['codex-view'];
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#page-caption').textContent = caption;
  document.querySelector('#file-actions').classList.toggle('hidden', viewId !== 'codex-view');
}

function showSettingsPanel(panelId) {
  document.querySelectorAll('#oidc-view [data-settings-panel]').forEach((item) => {
    const active = item.dataset.settingsPanel === panelId;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#oidc-view .config-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === panelId);
  });
}

async function loadWindowSettings() {
  try {
    const settings = await api.window.readSettings();
    document.querySelector('#close-to-tray-toggle').checked = settings.minimizeToTray !== false;
  } catch (error) {
    showToast(`应用设置读取失败：${error.message}`, true);
  }
}

async function saveWindowSettings() {
  try {
    await api.window.saveSettings({
      minimizeToTray: document.querySelector('#close-to-tray-toggle').checked
    });
    showToast('应用设置已保存');
  } catch (error) {
    showToast(`应用设置保存失败：${error.message}`, true);
  }
}

function showCloseChoice(settings) {
  if (settings?.minimizeToTray !== undefined) {
    document.querySelector('#close-to-tray-toggle').checked = settings.minimizeToTray !== false;
  }
  if (!closeChoiceDialog.open) closeChoiceDialog.showModal();
}

async function resolveCloseChoice(choice) {
  const buttons = closeChoiceDialog.querySelectorAll('button');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.window.resolveClose(choice);
    if (result?.ok) closeChoiceDialog.close();
  } catch (error) {
    showToast(`关闭设置保存失败：${error.message}`, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function showLoginDialog() {
  if (authenticated || loginDialog.open) return;
  closeAccountMenu();
  setHistoryOpen(false);
  loginDialog.showModal();
}

function renderOidcSettings(settings) {
  oidcSettings = settings;
  document.querySelector('#oidc-issuer').value = settings.issuer || '';
  document.querySelector('#oidc-client-id').value = settings.clientId || '';
  document.querySelector('#oidc-scopes').value = settings.scopes || 'openid profile email offline_access sub2api:apikey';
  document.querySelector('#oidc-redirect-uri').value = settings.redirectUri;
  document.querySelector('#summary-issuer').textContent = settings.issuer || '尚未配置';
  document.querySelector('#summary-client-id').textContent = settings.clientId || '-';
  document.querySelector('#summary-redirect-uri').textContent = settings.redirectUri;
  document.querySelector('#manual-login-button').classList.toggle('hidden', !settings.issuer);
}

async function loadOidcSettings() {
  try { renderOidcSettings(await api.oidc.readSettings()); }
  catch (error) { showToast(`OIDC 配置读取失败：${error.message}`, true); }
}

async function saveOidcSettings() {
  try {
    const settings = await api.oidc.saveSettings({
      issuer: document.querySelector('#oidc-issuer').value,
      clientId: document.querySelector('#oidc-client-id').value,
      scopes: document.querySelector('#oidc-scopes').value,
      redirectUri: document.querySelector('#oidc-redirect-uri').value
    });
    renderOidcSettings(settings);
    showToast('OIDC 配置已保存');
  } catch (error) { showToast(`保存失败：${error.message}`, true); }
}

function renderAuthStatus(status) {
  authenticated = Boolean(status.authenticated);
  document.querySelector('#api-key-login-hint').classList.toggle('hidden', authenticated);
  document.querySelector('#api-key-controls').classList.remove('hidden');
  document.querySelector('#api-key-controls').classList.toggle('has-refresh', authenticated);
  document.querySelector('#api-key-toggle').classList.toggle('hidden', !authenticated);
  document.querySelector('#refresh-api-keys').classList.toggle('hidden', !authenticated);
  if (!authenticated) {
    apiKeyRequest++;
    providerKeysLoaded = false;
    renderApiKeys([]);
  } else if (loginDialog.open) {
    loginDialog.close();
  }
  renderApiKeyMode();
  const account = document.querySelector('#account-block');
  const loginButton = document.querySelector('#login-button');
  const logoutButton = document.querySelector('#logout-button');
  const heading = document.querySelector('#login-heading');
  const description = document.querySelector('#login-description');
  const summary = document.querySelector('#summary-auth-status');

  account.classList.toggle('hidden', !status.authenticated);
  loginButton.classList.toggle('hidden', status.authenticated);
  logoutButton.classList.toggle('hidden', !status.authenticated);
  summary.textContent = status.authenticated ? (status.expired ? '会话已过期' : '已登录') : '未登录';

  if (status.authenticated) {
    const name = status.user.name || '已登录用户';
    document.querySelector('#account-name').textContent = name;
    document.querySelector('#account-email').textContent = status.user.email || status.user.subject;
    document.querySelector('#account-avatar').textContent = name.slice(0, 1).toUpperCase();
    document.querySelector('#nav-account-wrap').classList.remove('hidden');
    document.querySelector('#nav-avatar').textContent = name.slice(0, 1).toUpperCase();
    document.querySelector('#nav-account-name').textContent = name;
    heading.textContent = status.expired ? '会话已过期' : '身份账户已连接';
    description.textContent = status.expired ? '请退出后重新登录，以获取新的会话。' : 'OIDC 登录已完成，令牌使用系统安全存储加密保管。';
  } else {
    document.querySelector('#nav-account-wrap').classList.add('hidden');
    closeAccountMenu();
    heading.textContent = '连接你的身份账户';
    description.textContent = '登录将在系统默认浏览器中打开，授权完成后自动返回此应用。';
  }
  document.querySelector('#nav-login').classList.toggle('hidden', Boolean(status.authenticated));
}

async function refreshAuthStatus() {
  try {
    const status = await api.oidc.status();
    renderAuthStatus(status);
    if (status.authenticated) loadApiKeys();
  }
  catch (error) { showToast(`登录状态读取失败：${error.message}`, true); }
}

async function login() {
  const button = document.querySelector('#login-button');
  if (loginInFlight) {
    loginAttempt += 1;
    try { await api.oidc.cancelLogin(); } catch { /* The previous attempt may already have finished. */ }
    loginInFlight = false;
    return login();
  }
  loginInFlight = true;
  const attempt = ++loginAttempt;
  const message = document.querySelector('#login-message');
  button.disabled = false;
  button.textContent = '重新发起登录';
  message.className = 'login-message';
  message.textContent = '本地回调监听已启动，登录窗口将在系统浏览器中打开。';
  try {
    const status = await api.oidc.login();
    if (attempt !== loginAttempt) return;
    renderAuthStatus(status);
    loadApiKeys();
    message.textContent = '登录成功。';
    showToast('OIDC 登录成功');
  } catch (error) {
    if (attempt !== loginAttempt || error.message === '登录已取消。') return;
    message.className = 'login-message error';
    message.textContent = error.message.includes('WWW-Authenticate challenge')
      ? `${error.message} 可以先手动打开 Provider 检查登录入口，随后再重试。`
      : error.message;
    document.querySelector('#manual-login-button').classList.remove('hidden');
  } finally {
    if (attempt === loginAttempt) {
      loginInFlight = false;
      button.disabled = false;
      button.textContent = '重新发起登录';
    }
  }
}

async function logout() {
  try {
    closeAccountMenu();
    renderAuthStatus(await api.oidc.logout());
    renderApiKeys([]);
    document.querySelector('#login-message').textContent = '本地会话已清除。';
    showToast('已退出登录');
  } catch (error) { showToast(`退出失败：${error.message}`, true); }
}

document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-settings-panel]').forEach((item) => item.addEventListener('click', () => {
  showSettingsPanel(item.dataset.settingsPanel);
}));
document.querySelector('#close-to-tray-toggle').addEventListener('change', saveWindowSettings);
document.querySelector('#save-config').addEventListener('click', saveConfig);
document.querySelector('#reload-config').addEventListener('click', async () => {
  const target = currentConfig?.path;
  try {
    const config = await api.config.read(target);
    if (currentConfig?.path !== target) return;
    drafts.delete(target);
    savedContent = editor.value = config.content || '';
    await loadConfig(() => Promise.resolve(config));
    await loadConfigFiles();
  } catch (error) { showToast(`读取失败：${error.message}`, true); }
});
document.querySelector('#history-toggle').addEventListener('click', () => {
  const open = document.querySelector('#history-panel').classList.contains('hidden');
  setHistoryOpen(open);
  if (open) loadBackups();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#history-control')) setHistoryOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('#history-panel').classList.contains('hidden')) {
    setHistoryOpen(false);
    document.querySelector('#history-toggle').focus();
  }
});
document.querySelector('#refresh-backups').addEventListener('click', loadBackups);
document.querySelector('#close-diff').addEventListener('click', closeDiffView);
document.querySelector('#open-folder').addEventListener('click', () => api.config.openFolder(currentConfig?.path));
document.querySelector('#choose-config-directory').addEventListener('click', (event) => {
  event.currentTarget.disabled = true;
  switchConfigDirectory(() => api.config.chooseDirectory(), '配置目录已切换')
    .finally(() => { event.currentTarget.disabled = false; });
});
document.querySelector('#reset-config-directory').addEventListener('click', (event) => {
  event.currentTarget.disabled = true;
  switchConfigDirectory(() => api.config.resetDirectory(), '已恢复默认配置目录')
    .finally(() => { event.currentTarget.disabled = false; });
});
document.querySelector('#choose-file').addEventListener('click', async () => {
  try {
    const chosen = await api.config.chooseFile();
    if (!chosen.canceled) renderConfig(chosen);
  } catch (error) { showToast(`打开文件失败：${error.message}`, true); }
});
document.querySelector('#save-oidc').addEventListener('click', saveOidcSettings);
document.querySelector('#check-update').addEventListener('click', (event) => runUpdateAction(api.update.check, event.currentTarget));
document.querySelector('#download-update').addEventListener('click', (event) => runUpdateAction(api.update.download, event.currentTarget));
document.querySelector('#install-update').addEventListener('click', (event) => runUpdateAction(api.update.install, event.currentTarget));
document.querySelector('#refresh-api-keys').addEventListener('click', loadApiKeys);
document.querySelector('#api-key-mode-provider').addEventListener('click', () => setApiKeyMode('provider'));
document.querySelector('#api-key-mode-manual').addEventListener('click', () => setApiKeyMode('manual'));
document.querySelector('#api-key-select').addEventListener('change', () => {
  setApiKeyMode('provider');
  const selected = apiKeys.find((key) => key.id === document.querySelector('#api-key-select').value);
  if (selected?.value) setManualKey(selected.value);
});
document.querySelector('#manual-api-key').addEventListener('input', (event) => {
  setApiKeyMode('manual');
  setManualKey(event.target.value);
});
document.querySelector('#apply-api-key').addEventListener('click', applyApiKey);
document.querySelector('#base-url-input').addEventListener('input', (event) => {
  baseUrl = event.target.value.trim();
});
document.querySelector('#base-url-toggle').addEventListener('click', () => {
  const menu = document.querySelector('#base-url-menu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  document.querySelector('#base-url-toggle').setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('#base-url-menu [data-value]').forEach((item) => item.addEventListener('click', () => {
  const value = item.dataset.value;
  document.querySelector('#base-url-input').value = value;
  baseUrl = value;
  document.querySelector('#base-url-menu').classList.add('hidden');
  document.querySelector('#base-url-toggle').setAttribute('aria-expanded', 'false');
}));
document.querySelector('#api-key-toggle').addEventListener('click', () => {
  const menu = document.querySelector('#api-key-menu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  document.querySelector('#api-key-toggle').setAttribute('aria-expanded', String(open));
});
document.querySelector('#api-key-input').addEventListener('input', (event) => {
  setApiKeyMode('manual');
  setManualKey(event.target.value);
});
document.querySelector('#restore-backup').addEventListener('click', () => {
  if (!activeBackup) return;
  diffView?.restore(activeBackup.content);
  document.querySelector('#diff-status').textContent = '已载入备份内容，请点击保存配置写入当前文件';
  showToast('备份内容已载入右侧编辑器');
});
document.querySelector('#copy-callback').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.querySelector('#oidc-redirect-uri').value);
  showToast('回调地址已复制');
});
document.querySelector('#restart-codex').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await api.codex.restart();
    showToast(result.restarted
      ? 'ChatGPT/Codex 已重启'
      : '未能启动 Codex 或 ChatGPT');
  } catch (error) {
    showToast(`重启 Codex 失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
document.querySelector('#login-button').addEventListener('click', login);
document.querySelector('#nav-login').addEventListener('click', showLoginDialog);
document.querySelector('#close-login').addEventListener('click', () => loginDialog.close());
loginDialog.addEventListener('click', (event) => {
  const bounds = loginDialog.getBoundingClientRect();
  if (event.target === loginDialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom)) loginDialog.close();
});
document.querySelector('#logout-button').addEventListener('click', logout);
document.querySelector('#nav-account').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = document.querySelector('#account-menu');
  const isOpen = !menu.classList.contains('hidden');
  menu.classList.toggle('hidden', isOpen);
  event.currentTarget.setAttribute('aria-expanded', String(!isOpen));
});
document.querySelector('#account-logout').addEventListener('click', logout);
document.addEventListener('click', (event) => {
  if (!event.target.closest('#nav-account-wrap')) closeAccountMenu();
});
document.querySelector('#manual-login-button').addEventListener('click', async () => {
  try {
    await api.oidc.openProvider();
    document.querySelector('#login-message').textContent = 'Provider 已在浏览器中打开。请检查登录入口和客户端配置；不要重复打开旧的 callback 地址。';
  } catch (error) {
    document.querySelector('#login-message').className = 'login-message error';
    document.querySelector('#login-message').textContent = error.message;
  }
});
document.querySelector('#window-minimize').addEventListener('click', () => api.window.minimize());
document.querySelector('#window-maximize').addEventListener('click', () => api.window.toggleMaximize());
document.querySelector('#window-close').addEventListener('click', () => api.window.close());
document.querySelector('#cancel-close-choice').addEventListener('click', () => {
  closeChoiceDialog.close();
  api.window.cancelClose();
});
document.querySelector('#choose-close-quit').addEventListener('click', () => resolveCloseChoice('quit'));
document.querySelector('#choose-close-tray').addEventListener('click', () => resolveCloseChoice('tray'));
closeChoiceDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeChoiceDialog.close();
  api.window.cancelClose();
});
api.window.onCloseRequested(showCloseChoice);
document.querySelector('#go-oidc-settings').addEventListener('click', () => {
  loginDialog.close();
  showView('oidc-view');
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (loginDialog.open) return;
    if (document.querySelector('#oidc-view').classList.contains('active')) saveOidcSettings();
    else saveConfig();
  }
});

function closeAccountMenu() {
  const menu = document.querySelector('#account-menu');
  const account = document.querySelector('#nav-account');
  if (!menu || !account) return;
  menu.classList.add('hidden');
  account.setAttribute('aria-expanded', 'false');
}

async function initializeConfigFiles() {
  await loadConfigDirectory();
  await loadConfigFiles();
  const auth = configFiles.find((file) => file.name === 'auth.json');
  if (auth) {
    try { authConfig = await api.config.read(auth.path); syncManualKey(); }
    catch { document.querySelector('#manual-key-status').textContent = 'auth.json 读取失败'; }
  }
  const preferred = configFiles.find((file) => file.name === 'config.toml') || configFiles[0];
  if (preferred) await loadConfig(() => api.config.read(preferred.path));
}

async function switchConfigDirectory(action, successMessage) {
  if (currentConfig && editor.value !== savedContent &&
      !window.confirm('当前文件有未保存修改，切换配置目录将丢弃这些修改。继续吗？')) return;
  try {
    const result = await action();
    if (result.canceled) return;
    closeDiffView();
    drafts.clear();
    currentConfig = null;
    authConfig = null;
    activeBackup = null;
    renderConfigDirectory(result);
    await initializeConfigFiles();
    showToast(successMessage);
  } catch (error) {
    showToast(`配置目录操作失败：${error.message}`, true);
  }
}

api.oidc.onStatusChanged((status) => {
  renderAuthStatus(status);
  if (!status.authenticated) {
    renderApiKeys([]);
    document.querySelector('#api-key-status').textContent = '请登录后加载 API Key。';
  }
});
api.update.onChanged(renderUpdateState);
setInterval(async () => {
  try { renderAuthStatus(await api.oidc.status()); } catch { /* Retry on the next tick. */ }
}, 60000);
renderApiKeyMode();
Promise.all([initializeCodeEditor(), initializeConfigFiles(), loadOidcSettings(), loadWindowSettings(), refreshAuthStatus(), loadUpdateStatus()]);
