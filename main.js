const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, nativeImage, safeStorage } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const dns = require('dns');
const { autoUpdater } = require('electron-updater');

// Electron's embedded Node runtime may not include certificates installed in
// the operating system. Use the system trust store for provider/OIDC HTTPS.
if (!process.env.NODE_USE_SYSTEM_CA) process.env.NODE_USE_SYSTEM_CA = '1';

const legacyUserDataPath = app.getPath('userData');
app.setName('codex_img_autoconfig');
app.setPath('userData', path.join(app.getPath('appData'), 'codex_img_autoconfig'));

// Some local HTTPS providers bind only to IPv6 while Node resolves localhost
// to IPv4 first. Keep the user-facing issuer as localhost, but use ::1.
const originalDnsLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  const isLocalhost = String(hostname).toLowerCase() === 'localhost';
  if (!isLocalhost) return originalDnsLookup.call(dns, hostname, options, callback);
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const all = Boolean(options?.all);
  if (all) return process.nextTick(callback, null, [{ address: '::1', family: 6 }]);
  return process.nextTick(callback, null, '::1', 6);
};

const DEFAULT_REDIRECT_URI = 'http://localhost:53777/oauth/callback';
const LEGACY_REDIRECT_URIS = new Set([
  'http://localhost:53682/oauth/callback',
  'http://127.0.0.1:53682/oauth/callback'
]);
const LEGACY_OIDC_CLIENT_IDS = new Set([
  'rp_f226saroedw7mluvsqg5co4mlm'
]);
const DEFAULT_OIDC_SETTINGS = {
  issuer: 'https://opentk.ai',
  clientId: 'rp_bbmuek3vawcpuwbqulapgq246i',
  clientAuthMethod: 'none',
  scopes: 'openid profile email offline_access sub2api:apikey',
  redirectUri: DEFAULT_REDIRECT_URI
};

const CONFIG_CANDIDATES = [
  process.env.CODEX_CONFIG_PATH,
  path.join(os.homedir(), '.codex', 'config.toml'),
  path.join(os.homedir(), '.codex', 'config.json'),
  path.join(process.env.APPDATA || '', 'Codex', 'config.toml'),
  path.join(process.env.APPDATA || '', 'OpenAI', 'Codex', 'config.toml')
].filter(Boolean);
const CONFIG_GROUP_FILES = ['auth.json', 'config.toml', '.env'];
const execFileAsync = promisify(execFile);
const CHATGPT_PROCESS_NAME = 'ChatGPT.exe';
const OPEN_TOKEN_ICON_DATA_URL = 'data:image/png;base64,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';

let mainWindow;
let activeLoginServer;
let lastAuthorizationUrl = '';
let tray;
let isQuitting = false;
let closePromptInFlight = false;
let updaterConfigured = false;
let updateState = {
  supported: false,
  status: 'idle',
  currentVersion: app.getVersion(),
  unsupportedReason: '',
  availableVersion: '',
  percent: 0,
  transferred: 0,
  total: 0,
  error: ''
};

function logTray(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  for (const target of ['/tmp/opentk-tray.log', path.join(os.tmpdir(), 'opentk-tray.log')]) {
    try { fsSync.appendFileSync(target, line); } catch { /* Diagnostics must never affect startup. */ }
  }
}
// A packaged build remains single-instance, but `npm start` must be able to
// run beside an older installed build so source changes are actually visible.
const hasSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// This is a text/configuration tool; disabling GPU avoids crashes in restricted desktop sandboxes.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

function oidcSettingsPath() {
  return path.join(app.getPath('userData'), 'oidc-settings.json');
}

function windowSettingsPath() {
  return path.join(app.getPath('userData'), 'window-settings.json');
}

async function readWindowSettings() {
  try {
    const stored = await readJson(windowSettingsPath(), {});
    return {
      minimizeToTray: stored.minimizeToTray !== false,
      closeChoiceSet: stored.closeChoiceSet === true
    };
  } catch {
    return { minimizeToTray: true, closeChoiceSet: false };
  }
}

async function saveWindowSettings(patch = {}) {
  const current = await readWindowSettings();
  const settings = {
    minimizeToTray: patch.minimizeToTray === undefined ? current.minimizeToTray : Boolean(patch.minimizeToTray),
    closeChoiceSet: patch.closeChoiceSet === undefined ? current.closeChoiceSet : Boolean(patch.closeChoiceSet)
  };
  await fs.mkdir(path.dirname(windowSettingsPath()), { recursive: true });
  await fs.writeFile(windowSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === 'darwin') {
    app.dock?.show();
    app.dock?.setIcon(createMacDockIcon());
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMacStatusIcon() {
  return nativeImage.createFromDataURL(OPEN_TOKEN_ICON_DATA_URL)
    .resize({ width: 18, height: 18 });
}

function createMacDockIcon() {
  const source = nativeImage.createFromDataURL(OPEN_TOKEN_ICON_DATA_URL)
    .resize({ width: 54, height: 54 });
  const sourceBitmap = source.toBitmap();
  const canvasSize = 64;
  const canvas = Buffer.alloc(canvasSize * canvasSize * 4);
  const rowBytes = 54 * 4;
  for (let row = 0; row < 54; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = ((row + 5) * canvasSize + 5) * 4;
    sourceBitmap.copy(canvas, targetOffset, sourceOffset, sourceOffset + rowBytes);
  }
  return nativeImage.createFromBitmap(canvas, { width: canvasSize, height: canvasSize, scaleFactor: 1 });
}

function ensureTray() {
  if (tray) return tray;
  try {
    const icon = process.platform === 'darwin'
      ? createMacStatusIcon()
      : nativeImage.createFromPath(path.join(__dirname, 'assets', 'app-icon.png'))
        .resize({ width: 18, height: 18 });
    logTray(`creating platform=${process.platform} iconEmpty=${icon.isEmpty()} size=${JSON.stringify(icon.getSize())}`);
    tray = new Tray(icon);
    tray.setImage(icon);
    if (process.platform === 'darwin') tray.setTitle('');
    tray.setToolTip('OpenTk Codex配置工具');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 OpenTk', click: showMainWindow },
      { type: 'separator' },
      { label: '退出应用', click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', showMainWindow);
    logTray('created');
    return tray;
  } catch (error) {
    logTray(`failed ${error.stack || error.message}`);
    throw error;
  }
}

function applyWindowClose(minimizeToTray) {
  if (minimizeToTray) {
    ensureTray();
    mainWindow?.hide();
  } else {
    isQuitting = true;
    app.quit();
  }
}

async function requestWindowClose() {
  if (!mainWindow || mainWindow.isDestroyed() || closePromptInFlight) return;
  closePromptInFlight = true;
  try {
    const settings = await readWindowSettings();
    if (!settings.closeChoiceSet) {
      mainWindow.webContents.send('window:close-requested', settings);
      return;
    }
    closePromptInFlight = false;
    applyWindowClose(settings.minimizeToTray);
  } catch (error) {
    closePromptInFlight = false;
    dialog.showErrorBox('关闭失败', error.message || String(error));
  }
}

function authSessionPath() {
  return path.join(app.getPath('userData'), 'oidc-session.json');
}

async function migrateLegacyUserData() {
  const targetDirectory = app.getPath('userData');
  if (path.resolve(legacyUserDataPath) === path.resolve(targetDirectory) || !fsSync.existsSync(legacyUserDataPath)) return;
  await fs.mkdir(targetDirectory, { recursive: true });
  for (const name of ['oidc-settings.json', 'oidc-session.json', 'codex-config-settings.json', 'window-settings.json']) {
    const source = path.join(legacyUserDataPath, name);
    const target = path.join(targetDirectory, name);
    try { await fs.access(target); } catch (error) {
      if (error.code !== 'ENOENT') continue;
      try { await fs.copyFile(source, target); } catch (copyError) { if (copyError.code !== 'ENOENT') throw copyError; }
    }
  }
}

function publishUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send('update:changed', updateState);
  return updateState;
}

function updateErrorMessage(error) {
  return String(error?.message || error || '检查更新失败').replace(/\s+/g, ' ').trim();
}

function allowLocalOidcCertificate(issuer) {
  try {
    const hostname = new URL(issuer).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  } catch {
    // URL validation reports the user-facing configuration error later.
  }
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;
  const unsupportedReason = !app.isPackaged
    ? 'development'
    : (process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : '');
  if (unsupportedReason) {
    publishUpdateState({ supported: false, status: 'unsupported', unsupportedReason });
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  publishUpdateState({ supported: true, status: 'idle', unsupportedReason: '' });
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({
    status: 'available', availableVersion: info.version || '', percent: 0, error: ''
  }));
  autoUpdater.on('update-not-available', (info) => publishUpdateState({
    status: 'up-to-date', availableVersion: info?.version || app.getVersion(), percent: 0, error: ''
  }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({
    status: 'downloading', percent: Math.max(0, Math.min(100, progress.percent || 0)),
    transferred: progress.transferred || 0, total: progress.total || 0, error: ''
  }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({
    status: 'downloaded', availableVersion: info.version || updateState.availableVersion,
    percent: 100, error: ''
  }));
  autoUpdater.on('error', (error) => publishUpdateState({ status: 'error', error: updateErrorMessage(error) }));
}

async function checkForUpdates() {
  configureAutoUpdater();
  if (!updateState.supported) return updateState;
  try {
    publishUpdateState({ status: 'checking', error: '' });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateState({ status: 'error', error: updateErrorMessage(error) });
  }
  return updateState;
}

async function downloadUpdate() {
  configureAutoUpdater();
  if (updateState.status !== 'available') throw new Error('当前没有可下载的更新。');
  publishUpdateState({ status: 'downloading', percent: 0, error: '' });
  await autoUpdater.downloadUpdate();
  return updateState;
}

function findConfigPath() {
  const customDirectory = readConfiguredConfigDirectory();
  if (customDirectory) return path.join(customDirectory, 'config.toml');
  const existing = CONFIG_CANDIDATES.find((filePath) => {
    try { return fsSync.statSync(filePath).isFile(); } catch { return false; }
  });
  return existing || path.join(defaultConfigGroupDirectory(), 'config.toml');
}

function configDirectorySettingsPath() {
  return path.join(app.getPath('userData'), 'codex-config-settings.json');
}

function readConfiguredConfigDirectory() {
  try {
    const stored = JSON.parse(fsSync.readFileSync(configDirectorySettingsPath(), 'utf8'));
    if (typeof stored.directory !== 'string' || !stored.directory.trim()) return '';
    return path.resolve(stored.directory);
  } catch {
    return '';
  }
}

function defaultConfigGroupDirectory() {
  const configured = process.env.CODEX_CONFIG_PATH;
  if (configured) return path.dirname(configured);
  const existing = CONFIG_CANDIDATES.find((filePath) => {
    try { return fsSync.statSync(filePath).isFile(); } catch { return false; }
  });
  return existing ? path.dirname(existing) : path.join(os.homedir(), '.codex');
}

function configGroupDirectory() {
  return readConfiguredConfigDirectory() || defaultConfigGroupDirectory();
}

function configDirectoryInfo() {
  const customDirectory = readConfiguredConfigDirectory();
  return {
    directory: customDirectory || defaultConfigGroupDirectory(),
    customized: Boolean(customDirectory),
    defaultDirectory: defaultConfigGroupDirectory()
  };
}

async function chooseConfigDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Codex 配置目录',
    defaultPath: configGroupDirectory(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, ...configDirectoryInfo() };
  const directory = path.resolve(result.filePaths[0]);
  await fs.mkdir(path.dirname(configDirectorySettingsPath()), { recursive: true });
  await fs.writeFile(configDirectorySettingsPath(), JSON.stringify({ directory }, null, 2), 'utf8');
  return { ok: true, ...configDirectoryInfo() };
}

async function resetConfigDirectory() {
  try { await fs.unlink(configDirectorySettingsPath()); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ok: true, ...configDirectoryInfo() };
}

async function listConfigFiles() {
  const directory = configGroupDirectory();
  const files = [];
  for (const name of CONFIG_GROUP_FILES) {
    const filePath = path.join(directory, name);
    let exists = false;
    let size = 0;
    let modifiedAt = null;
    try {
      const stat = await fs.stat(filePath);
      exists = stat.isFile();
      size = stat.size;
      modifiedAt = stat.mtime.toISOString();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (name === '.env' && !exists) continue;
    files.push({ name, path: filePath, exists, size, modifiedAt, format: path.extname(name).slice(1).toUpperCase() || 'ENV' });
  }
  const cachePath = modelCachePath();
  if (!files.some((file) => path.resolve(file.path) === path.resolve(cachePath))) {
    try {
      const stat = await fs.stat(cachePath);
      if (stat.isFile()) files.push({
        name: 'models_cache.json', path: cachePath, exists: true,
        size: stat.size, modifiedAt: stat.mtime.toISOString(), format: 'JSON'
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

function protect(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储当前不可用，无法保存敏感信息。');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function unprotect(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readOidcSettings() {
  const stored = await readJson(oidcSettingsPath(), {});
  const normalize = (input, id, fallbackName) => {
    const storedRedirectUri = LEGACY_REDIRECT_URIS.has(input.redirectUri)
      ? DEFAULT_REDIRECT_URI
      : input.redirectUri;
    const storedClientId = LEGACY_OIDC_CLIENT_IDS.has(input.clientId)
      ? DEFAULT_OIDC_SETTINGS.clientId
      : input.clientId;
    return {
      id: String(input.id || id),
      name: String(input.name || fallbackName),
      issuer: String(input.issuer || DEFAULT_OIDC_SETTINGS.issuer),
      clientId: String(storedClientId || DEFAULT_OIDC_SETTINGS.clientId),
      clientAuthMethod: 'none',
      scopes: String(input.scopes || DEFAULT_OIDC_SETTINGS.scopes),
      redirectUri: storedRedirectUri || DEFAULT_REDIRECT_URI
    };
  };
  const legacy = !Array.isArray(stored.providers);
  const providers = (Array.isArray(stored.providers) ? stored.providers : [stored])
    .filter((provider) => provider && typeof provider === 'object')
    .map((provider, index) => normalize(provider, `provider-${index + 1}`, `OIDC Provider ${index + 1}`));
  if (!providers.length) providers.push(normalize({}, 'default', '默认 Provider'));
  const activeProviderId = providers.some((provider) => provider.id === stored.activeProviderId)
    ? stored.activeProviderId
    : providers[0].id;
  const active = providers.find((provider) => provider.id === activeProviderId) || providers[0];
  const settings = { ...active, providerId: active.id, providers };
  const source = Array.isArray(stored.providers) ? stored.providers : [];
  const legacyInput = legacy ? stored : {};
  const hasLegacySecret = Object.prototype.hasOwnProperty.call(legacyInput, 'clientSecretProtected') ||
    Object.prototype.hasOwnProperty.call(legacyInput, 'clientSecret');
  const migratedRedirectUri = typeof legacyInput.redirectUri === 'string' &&
    LEGACY_REDIRECT_URIS.has(legacyInput.redirectUri);
  const migratedClientId = typeof legacyInput.clientId === 'string' &&
    LEGACY_OIDC_CLIENT_IDS.has(legacyInput.clientId);
  const needsMigration = hasLegacySecret || migratedRedirectUri || migratedClientId ||
    (!legacy && (stored.activeProviderId !== active.id || source.length !== providers.length ||
      source.some((provider, index) => JSON.stringify(provider) !== JSON.stringify(providers[index]))));
  if (needsMigration) {
    await fs.mkdir(path.dirname(oidcSettingsPath()), { recursive: true });
    await fs.writeFile(oidcSettingsPath(), JSON.stringify({ ...active, activeProviderId: active.id, providers }, null, 2), 'utf8');
  }
  return settings;
}

function validateRedirectUri(value) {
  const redirect = new URL(value);
  if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost') {
    throw new Error(`回调地址必须使用 ${DEFAULT_REDIRECT_URI}。`);
  }
  if (!redirect.port) throw new Error('回调地址必须包含固定端口。');
  return redirect;
}

async function saveOidcSettings(input) {
  const current = await readOidcSettings();
  const issuer = String(input.issuer || '').trim().replace(/\/$/, '');
  const clientId = String(input.clientId || '').trim();
  const scopes = String(input.scopes || DEFAULT_OIDC_SETTINGS.scopes).trim();
  const redirectUri = String(input.redirectUri || DEFAULT_REDIRECT_URI).trim();
  const providerId = String(input.providerId || current.providerId || 'default').trim();
  const name = String(input.name || current.name || 'OIDC Provider').trim();

  validateRedirectUri(redirectUri);
  if (issuer) new URL(issuer);

  const providers = (current.providers || []).map((provider) => provider.id === providerId
    ? { id: providerId, name, issuer, clientId, clientAuthMethod: 'none', scopes, redirectUri }
    : provider);
  if (!providers.some((provider) => provider.id === providerId)) {
    providers.push({ id: providerId, name, issuer, clientId, clientAuthMethod: 'none', scopes, redirectUri });
  }
  const stored = { activeProviderId: providerId, providers };
  await fs.mkdir(path.dirname(oidcSettingsPath()), { recursive: true });
  await fs.writeFile(oidcSettingsPath(), JSON.stringify(stored, null, 2), 'utf8');
  return readOidcSettings();
}

let tokenRefreshPromise = null;
let authRevision = 0;

async function discoverPublicClient(oidc, issuer, clientId) {
  allowLocalOidcCertificate(issuer);
  const config = await oidc.discovery(
    new URL(issuer), clientId,
    { token_endpoint_auth_method: 'none' },
    oidc.None()
  );
  const supported = config.serverMetadata().token_endpoint_auth_methods_supported;
  if (Array.isArray(supported) && !supported.includes('none')) {
    throw new Error('Provider 不支持公开客户端。请为此 Client ID 启用 token_endpoint_auth_method=none 和 PKCE S256。');
  }
  return config;
}

async function readStoredAccessToken(rejectedToken) {
  const session = await readJson(authSessionPath(), null);
  if (!session?.tokenSetProtected) throw new Error('请先完成 OIDC 登录。');
  const tokenSet = JSON.parse(unprotect(session.tokenSetProtected));
  const expiring = session.expiresAt && Date.now() >= session.expiresAt - 60000;
  if (!tokenSet.access_token || expiring || rejectedToken === tokenSet.access_token) {
    if (!tokenRefreshPromise) {
      tokenRefreshPromise = refreshStoredTokens(session, tokenSet)
        .finally(() => { tokenRefreshPromise = null; });
    }
    return tokenRefreshPromise;
  }
  return tokenSet.access_token;
}

async function refreshStoredTokens(session, tokenSet) {
  const revision = authRevision;
  const expireSession = async () => {
    if (revision === authRevision) await logout();
    throw new Error('登录已过期，请重新登录。');
  };
  if (!tokenSet.refresh_token) return expireSession();
  const settings = await readOidcSettings();
  if (session.issuer !== settings.issuer || session.clientId !== settings.clientId) {
    return expireSession();
  }
  const oidc = await import('openid-client');
  let tokens;
  try {
    const config = await discoverPublicClient(oidc, session.issuer, session.clientId);
    tokens = await oidc.refreshTokenGrant(config, tokenSet.refresh_token);
  } catch (error) {
    if (['invalid_grant', 'invalid_token'].includes(error.error)) return expireSession();
    // Network/provider failures must not destroy a potentially valid session.
    throw new Error(oidcErrorMessage(error, 'Token 刷新 '));
  }
  if (revision !== authRevision) throw new Error('登录会话已变更，请重试。');
  const updated = {
    ...session,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    tokenSetProtected: protect(JSON.stringify({
      ...tokenSet,
      ...tokens,
      refresh_token: tokens.refresh_token || tokenSet.refresh_token
    }))
  };
  // Keep the revision check and write together so logout cannot resurrect a session.
  fsSync.writeFileSync(authSessionPath(), JSON.stringify(updated, null, 2), 'utf8');
  return tokens.access_token;
}

function normalizeApiKeys(items) {
  if (typeof items === 'string') items = [items];
  if (items && !Array.isArray(items) && typeof items === 'object') {
    items = Object.entries(items).map(([id, value]) => ({ id, value }));
  }
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (typeof item === 'string') return { id: item, label: item, value: item };
    const value = item.api_key || item.apiKey || item.key || item.secret || item.token || item.value || '';
    const id = item.id || item.key_id || item.keyId || value || `key-${index + 1}`;
    const label = item.name || item.label || item.title || id;
    return { id: String(id), label: String(label), value: String(value), createdAt: item.created_at || item.createdAt || '' };
  });
}

async function fetchUserInfoClaims(settings, accessToken, userinfoEndpoint) {
  const endpoint = userinfoEndpoint || `${settings.issuer.replace(/\/$/, '')}/oidc/userinfo`;
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`UserInfo 请求失败（HTTP ${response.status}）。\n回包：${rawBody || '(空响应)'}`);
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(`UserInfo 回包不是有效 JSON。\n回包：${rawBody || '(空响应)'}`);
  }
}

async function fetchApiKeys() {
  const session = await readJson(authSessionPath(), null);
  if (!session) throw new Error('请先完成 OIDC 登录。');
  const settings = await readOidcSettings();
  let accessToken = await readStoredAccessToken();
  const endpoint = `${settings.issuer.replace(/\/$/, '')}/oidc/resource/api-keys`;
  // Existing sessions may skip OIDC discovery, so enable the local mkcert
  // compatibility immediately before the API Key request as well.
  allowLocalOidcCertificate(endpoint);
  const request = () => fetch(endpoint, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
  });
  let response;
  try {
    response = await request();
  } catch (error) {
    if (error?.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      throw new Error('API Key 请求失败：Provider 的 TLS 证书链无法验证。请在系统中安装根证书，或让 Provider 返回完整的证书链后重试。');
    }
    throw error;
  }
  if (response.status === 401) {
    await response.text();
    try {
      accessToken = await readStoredAccessToken(accessToken);
      response = await request();
    } catch (error) {
      if (error?.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || error?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        throw new Error('API Key 请求失败：Provider 的 TLS 证书链无法验证。请在系统中安装根证书，或让 Provider 返回完整的证书链后重试。');
      }
      throw error;
    }
  }
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`API Key 请求失败（HTTP ${response.status}）。\n请求地址：${endpoint}\n回包：${rawBody || '(空响应)'}`);
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error(`API Key 回包不是有效 JSON。\n请求地址：${endpoint}\n回包：${rawBody || '(空响应)'}`);
  }
  const namespacedKey = Object.keys(payload || {}).find((key) => /api[_-]?keys?|apikey/i.test(key));
  const items = Array.isArray(payload)
    ? payload
    : payload.items || payload.api_keys || payload.apiKeys || payload.apikeys || payload.keys || payload.data?.items || payload.data || (namespacedKey ? payload[namespacedKey] : []);
  const keys = normalizeApiKeys(items);
  if (!keys.length) {
    throw new Error(`API Key 接口没有返回可用 Key。\n请求地址：${endpoint}\n回包：${JSON.stringify(payload, null, 2)}`);
  }
  return keys;
}

function providerModelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim();
  if (!value) throw new Error('请先填写 Base URL。');
  if (/\r|\n/.test(value)) throw new Error('Base URL 不能包含换行符');
  let endpoint;
  try {
    endpoint = new URL(value).toString().replace(/\/+$/, '');
  } catch {
    throw new Error('Base URL 必须是有效的 http:// 或 https:// 地址。');
  }
  if (!/^https?:$/i.test(new URL(endpoint).protocol)) {
    throw new Error('Base URL 必须使用 http:// 或 https://。');
  }
  if (/\/v1\/models$/i.test(endpoint)) return endpoint;
  return `${endpoint}${/\/v1$/i.test(endpoint) ? '' : '/v1'}/models`;
}

function normalizeModels(payload) {
  const items = Array.isArray(payload)
    ? payload
    : [payload?.data, payload?.models, payload?.items, payload?.data?.items]
      .find((value) => Array.isArray(value)) || [];
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.map((item) => {
    if (typeof item === 'string') return { id: item, label: item, raw: null };
    const id = item?.id || item?.model || item?.name || item?.slug || '';
    return id ? {
      id: String(id),
      label: String(item?.name || item?.label || item?.display_name || id),
      raw: item
    } : null;
  }).filter((item) => item && !seen.has(item.id) && seen.add(item.id));
}

function modelCachePath() {
  return path.join(os.homedir(), '.codex', 'models_cache.json');
}

function modelCacheEntry(input = {}) {
  const source = input?.raw && typeof input.raw === 'object' ? input.raw : input;
  const slug = String(source?.slug || source?.id || source?.model || source?.name || '').trim();
  if (!slug || /[\r\n]/.test(slug)) throw new Error('模型名称不能为空或包含换行符');
  const displayName = String(source?.display_name || source?.label || source?.name || slug).trim() || slug;
  return {
    slug,
    display_name: displayName,
    description: String(source?.description || `${displayName} routed through Sub2API.`),
    default_reasoning_level: source?.default_reasoning_level || 'medium',
    supported_reasoning_levels: Array.isArray(source?.supported_reasoning_levels)
      ? source.supported_reasoning_levels
      : [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balanced reasoning for most coding tasks' },
        { effort: 'high', description: 'Greater reasoning depth for coding and agent tasks' },
        { effort: 'xhigh', description: 'Extra-high reasoning depth for difficult tasks' }
      ],
    shell_type: source?.shell_type || 'unified_exec',
    visibility: source?.visibility || 'list',
    supported_in_api: source?.supported_in_api !== false,
    priority: Number.isFinite(source?.priority) ? source.priority : 50,
    additional_speed_tiers: Array.isArray(source?.additional_speed_tiers) ? source.additional_speed_tiers : [],
    service_tiers: Array.isArray(source?.service_tiers) ? source.service_tiers : [],
    default_service_tier: source?.default_service_tier ?? null,
    availability_nux: source?.availability_nux ?? null,
    upgrade: source?.upgrade ?? null,
    model_messages: source?.model_messages || { instructions_template: '' },
    include_skills_usage_instructions: source?.include_skills_usage_instructions ?? false,
    include_plugin_usage_instructions: source?.include_plugin_usage_instructions ?? false,
    include_apps_usage_instructions: source?.include_apps_usage_instructions ?? false,
    supports_reasoning_summary_parameter: source?.supports_reasoning_summary_parameter ?? true,
    default_reasoning_summary: source?.default_reasoning_summary ?? 'auto',
    support_verbosity: source?.support_verbosity ?? false,
    default_verbosity: source?.default_verbosity ?? null,
    apply_patch_tool_type: source?.apply_patch_tool_type ?? null,
    web_search_tool_type: source?.web_search_tool_type || 'text',
    truncation_policy: source?.truncation_policy || 'auto',
    supports_image_detail_original: source?.supports_image_detail_original ?? false,
    supports_parallel_tool_calls: source?.supports_parallel_tool_calls ?? true,
    context_window: source?.context_window ?? 500000,
    max_context_window: source?.max_context_window ?? 500000,
    auto_compact_token_limit: source?.auto_compact_token_limit ?? null,
    comp_hash: source?.comp_hash ?? null,
    effective_context_window_percent: source?.effective_context_window_percent ?? 95,
    experimental_supported_tools: Array.isArray(source?.experimental_supported_tools) ? source.experimental_supported_tools : [],
    input_modalities: Array.isArray(source?.input_modalities) ? source.input_modalities : ['text'],
    supports_search_tool: source?.supports_search_tool ?? false,
    use_responses_lite: source?.use_responses_lite ?? false,
    node_repl_auto_review_required: source?.node_repl_auto_review_required ?? false,
    node_repl_disabled: source?.node_repl_disabled ?? false,
    auto_review_model_override: source?.auto_review_model_override ?? null,
    model_specialty: source?.model_specialty ?? null,
    tool_mode: source?.tool_mode ?? null,
    multi_agent_version: source?.multi_agent_version ?? null,
    ...source,
    slug,
    display_name: displayName,
    truncation_policy: {
      mode: 'bytes',
      limit: 10000
    }
  };
}

async function saveModelCache(payload = {}) {
  const target = modelCachePath();
  const inputs = Array.isArray(payload.models) ? payload.models : [];
  if (!inputs.length) throw new Error('没有可保存的模型');
  const models = [];
  const seen = new Set();
  for (const input of inputs) {
    const entry = modelCacheEntry(input);
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    models.push(entry);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ models }, null, 2)}\n`, 'utf8');
  return { ok: true, path: target, count: models.length };
}

async function fetchProviderModels(payload = {}) {
  const endpoint = providerModelsEndpoint(payload.baseUrl);
  allowLocalOidcCertificate(endpoint);
  const apiKey = String(payload.apiKey || '').trim();
  if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行符');
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint, { headers });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`模型列表请求失败（HTTP ${response.status}）。\n请求地址：${endpoint}\n回包：${rawBody || '(空响应)'}`);
  }
  let payloadJson;
  try {
    payloadJson = JSON.parse(rawBody);
  } catch {
    throw new Error(`模型列表回包不是有效 JSON。\n请求地址：${endpoint}\n回包：${rawBody || '(空响应)'}`);
  }
  return normalizeModels(payloadJson);
}

async function readConfig(targetPath) {
  const filePath = targetPath || findConfigPath();
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const stat = await fs.stat(filePath);
    return {
      ok: true,
      exists: true,
      path: filePath,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      format: path.extname(filePath).slice(1).toUpperCase() || 'TEXT'
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        ok: true,
        exists: false,
        path: filePath,
        content: '',
        size: 0,
        modifiedAt: null,
        format: path.extname(filePath).slice(1).toUpperCase() || 'TEXT'
      };
    }
    throw error;
  }
}

async function saveConfig(targetPath, content) {
  const filePath = targetPath || findConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let backupPath = null;
  try {
    const [existingContent, existingStat] = await Promise.all([
      fs.readFile(filePath, 'utf8'),
      fs.stat(filePath)
    ]);
    if (existingContent === content) {
      return {
        ok: true, path: filePath, size: existingStat.size,
        modifiedAt: existingStat.mtime.toISOString(), backupPath: null, unchanged: true
      };
    }
    backupPath = `${filePath}.opentk-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.writeFile(filePath, content, 'utf8');
  const stat = await fs.stat(filePath);
  return { ok: true, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString(), backupPath, unchanged: false };
}

async function listBackups(targetPath) {
  const filePath = targetPath || findConfigPath();
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  let names = [];
  try { names = await fs.readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const backupPrefix = `${baseName}.opentk-backup-`;
  const backups = await Promise.all(names.filter((name) => name.startsWith(backupPrefix)).map(async (name) => {
    const backupPath = path.join(directory, name);
    const stat = await fs.stat(backupPath);
    return { path: backupPath, name, modifiedAt: stat.mtime.toISOString(), size: stat.size };
  }));
  return backups.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

async function readBackup(backupPath) {
  const filePath = String(backupPath || '');
  if (!path.basename(filePath).includes('.opentk-backup-')) throw new Error('无效的 OpenTk 备份文件。');
  const content = await fs.readFile(filePath, 'utf8');
  const stat = await fs.stat(filePath);
  return { path: filePath, name: path.basename(filePath), content, modifiedAt: stat.mtime.toISOString(), size: stat.size };
}

async function deleteBackup(targetPath, backupPath) {
  const target = path.resolve(String(targetPath || ''));
  const backup = path.resolve(String(backupPath || ''));
  const suffix = path.basename(backup).slice(`${path.basename(target)}.opentk-backup-`.length);
  if (!targetPath || !backupPath || path.dirname(target) !== path.dirname(backup) ||
      !path.basename(backup).startsWith(`${path.basename(target)}.opentk-backup-`) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(suffix)) {
    throw new Error('只能删除当前配置文件的 OpenTk 备份。');
  }
  const stat = await fs.lstat(backup);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('无效的备份文件。');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: '删除备份',
    message: '将此备份移到回收站？',
    detail: path.basename(backup),
    buttons: ['取消', '移到回收站'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (result.response !== 1) return { canceled: true };
  await shell.trashItem(backup);
  return { canceled: false };
}

async function createLoopbackListener(redirectUri) {
  const redirect = validateRedirectUri(redirectUri);
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let closed = false;
  const server = http.createServer((request, response) => {
    const currentUrl = new URL(request.url, redirect.origin);
    if (currentUrl.pathname !== redirect.pathname) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录完成</title><style>body{font-family:system-ui;background:#101417;color:#edf2f3;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}p{color:#93a1a7}</style><main><h1>登录请求已返回应用</h1><p>现在可以关闭这个页面并回到 OpenTk Codex配置工具。</p></main></html>');
    resolveCallback(new URL(currentUrl.href));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(redirect.port), redirect.hostname, resolve);
  });
  const timer = setTimeout(() => rejectCallback(new Error('登录等待超时，请重新尝试。')), 5 * 60 * 1000);
  const close = (reason = new Error('登录已取消。')) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    rejectCallback(reason);
    if (server.listening) server.close();
    if (activeLoginServer === server) activeLoginServer = null;
  };
  activeLoginServer = server;
  return { callback, close };
}

function cancelOidcLogin() {
  if (!activeLoginServer) return { canceled: false };
  activeLoginServer.close(new Error('登录已取消。'));
  return { canceled: true };
}

function oidcErrorMessage(error, phase) {
  const status = error?.status || error?.response?.status || error?.cause?.status;
  const suffix = status ? `（HTTP ${status}）` : '';
  if (error?.name === 'WWWAuthenticateChallengeError' || error?.constructor?.name === 'WWWAuthenticateChallengeError') {
    return `OIDC ${phase}失败${suffix}：Provider 拒绝了公开客户端请求。请检查 Client ID 是否启用了 token_endpoint_auth_method=none 和 PKCE S256。`;
  }
  return `OIDC ${phase}失败${suffix}：${error?.message || String(error)}`;
}

async function startOidcLogin() {
  const settings = await readOidcSettings();
  if (!settings.issuer || !settings.clientId) {
    throw new Error('请先在配置页填写 Issuer URL 和 Client ID。');
  }

  const oidc = await import('openid-client');

  let config;
  try {
    config = await discoverPublicClient(oidc, settings.issuer, settings.clientId);
  } catch (error) {
    throw new Error(oidcErrorMessage(error, 'Provider Discovery '));
  }
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const requestedScopes = Array.from(new Set(`${settings.scopes} offline_access sub2api:apikey`.trim().split(/\s+/))).join(' ');
  const listener = await createLoopbackListener(settings.redirectUri);
  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: requestedScopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce
  });
  lastAuthorizationUrl = authorizationUrl.href;
  try {
    await shell.openExternal(authorizationUrl.href);
    const callbackUrl = await listener.callback;
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true
      });
    } catch (error) {
      throw new Error(oidcErrorMessage(error, 'Token 交换 '));
    }
    const claims = tokens.claims() || {};
    let userInfo = {};
    try {
      userInfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    } catch {
      userInfo = {};
    }
    const session = {
      issuer: settings.issuer,
      clientId: settings.clientId,
      userinfoEndpoint: config.serverMetadata().userinfo_endpoint || `${settings.issuer.replace(/\/$/, '')}/oidc/userinfo`,
      claims,
      userInfoProtected: protect(JSON.stringify(userInfo)),
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      tokenSetProtected: protect(JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        token_type: tokens.token_type,
        scope: tokens.scope,
        expires_in: tokens.expires_in
      }))
    };
    authRevision += 1;
    fsSync.writeFileSync(authSessionPath(), JSON.stringify(session, null, 2), 'utf8');
    return getAuthStatus();
  } finally {
    listener.close();
  }
}

async function getAuthStatus() {
  let session = await readJson(authSessionPath(), null);
  if (session?.expiresAt && Date.now() >= session.expiresAt - 60000) {
    try { await readStoredAccessToken(); } catch { /* Preserve sessions on transient failures. */ }
    session = await readJson(authSessionPath(), null);
  }
  if (!session) return { authenticated: false };
  const claims = session.claims || {};
  return {
    authenticated: true,
    expired: Boolean(session.expiresAt && Date.now() >= session.expiresAt),
    issuer: session.issuer,
    expiresAt: session.expiresAt,
    user: {
      subject: claims.sub || '',
      name: claims.name || claims.preferred_username || claims.email || claims.sub || '已登录用户',
      email: claims.email || '',
      picture: claims.picture || ''
    }
  };
}

async function logout() {
  authRevision += 1;
  try { await fs.unlink(authSessionPath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mainWindow?.webContents.send('auth:changed', { authenticated: false });
  return { authenticated: false };
}

function createWindow() {
  if (process.platform === 'darwin') app.dock?.show();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 650,
    backgroundColor: '#101417',
    title: 'OpenTk',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void requestWindowClose();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('config:list-files', listConfigFiles);
ipcMain.handle('config:directory', () => configDirectoryInfo());
ipcMain.handle('config:choose-directory', chooseConfigDirectory);
ipcMain.handle('config:reset-directory', resetConfigDirectory);
ipcMain.handle('config:read', (_event, targetPath) => readConfig(targetPath));
ipcMain.handle('config:save', (_event, payload) => saveConfig(payload?.path, String(payload?.content ?? '')));
ipcMain.handle('config:list-backups', (_event, targetPath) => listBackups(targetPath));
ipcMain.handle('config:read-backup', (_event, backupPath) => readBackup(backupPath));
ipcMain.handle('config:delete-backup', (_event, targetPath, backupPath) => deleteBackup(targetPath, backupPath));
ipcMain.handle('config:save-model-cache', (_event, payload) => saveModelCache(payload || {}));
ipcMain.handle('config:open-folder', async (_event, targetPath) => {
  const filePath = targetPath || findConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await shell.openPath(path.dirname(filePath));
  return { path: filePath };
});
ipcMain.handle('config:choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Codex 配置文件',
    properties: ['openFile'],
    filters: [{ name: '配置文件', extensions: ['toml', 'json', 'txt'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf8');
  const stat = await fs.stat(filePath);
  return {
    ok: true, exists: true, path: filePath, content, size: stat.size,
    modifiedAt: stat.mtime.toISOString(), format: path.extname(filePath).slice(1).toUpperCase() || 'TEXT'
  };
});
ipcMain.handle('oidc:read-settings', () => readOidcSettings());
ipcMain.handle('oidc:save-settings', (_event, settings) => saveOidcSettings(settings || {}));
ipcMain.handle('oidc:api-keys', fetchApiKeys);
ipcMain.handle('provider:models', (_event, payload) => fetchProviderModels(payload || {}));
ipcMain.handle('auth:status', getAuthStatus);
ipcMain.handle('auth:login', startOidcLogin);
ipcMain.handle('auth:cancel-login', cancelOidcLogin);
ipcMain.handle('auth:logout', logout);
ipcMain.handle('auth:open-provider', async () => {
  const settings = await readOidcSettings();
  if (!settings.issuer) throw new Error('请先在设置中填写 Issuer URL。');
  await shell.openExternal(settings.issuer);
  return { ok: true, url: settings.issuer };
});
ipcMain.handle('auth:open-last-url', async () => {
  if (!lastAuthorizationUrl) throw new Error('当前没有可重新打开的登录地址，请先发起一次登录。');
  await shell.openExternal(lastAuthorizationUrl);
  return { ok: true, url: lastAuthorizationUrl };
});
async function findRunningChatGPT() {
  try {
    if (process.platform === 'win32') {
      const command = "(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Select-Object -First 1).Id";
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', command
      ], { windowsHide: true });
      return stdout.trim() ? { processName: CHATGPT_PROCESS_NAME } : null;
    }
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('pgrep', ['-x', 'ChatGPT']);
        if (stdout.trim()) return { processName: 'ChatGPT' };
      } catch {
        // The packaged macOS process can report its full application path.
      }
      const { stdout } = await execFileAsync('pgrep', ['-f', '/ChatGPT.app/Contents/MacOS/ChatGPT']);
      return stdout.trim() ? { processName: 'ChatGPT' } : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function waitForChatGPTStart(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findRunningChatGPT()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return Boolean(await findRunningChatGPT());
}

async function startChatGPT() {
  if (process.platform === 'darwin') {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await execFileAsync('open', ['-a', 'ChatGPT']);
      } catch {
        // Launch Services can briefly refuse the reopen while the previous
        // instance is still shutting down, so retry below.
      }
      if (await waitForChatGPTStart(5000)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }
  try {
    await shell.openExternal('codex://');
    return waitForChatGPTStart();
  } catch {
    return false;
  }
}

async function waitForChatGPTExit(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findRunningChatGPT())) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !(await findRunningChatGPT());
}

async function stopChatGPT() {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/IM', CHATGPT_PROCESS_NAME, '/T', '/F'], { windowsHide: true });
    } catch {
      // The process may have exited between detection and taskkill.
    }
    return waitForChatGPTExit();
  }
  if (process.platform !== 'darwin') return true;

  const processPatterns = [
    ['-x', 'ChatGPT'],
    ['-f', '/ChatGPT.app/Contents/MacOS/ChatGPT']
  ];
  await Promise.all(processPatterns.map((args) =>
    execFileAsync('pkill', ['-TERM', ...args]).catch(() => null)));
  if (await waitForChatGPTExit(7000)) return true;

  await Promise.all(processPatterns.map((args) =>
    execFileAsync('pkill', ['-KILL', ...args]).catch(() => null)));
  return waitForChatGPTExit(3000);
}

let restartChatGPTPromise = null;

ipcMain.handle('codex:restart', () => {
  if (restartChatGPTPromise) return restartChatGPTPromise;
  restartChatGPTPromise = (async () => {
    const runningChatGPT = await findRunningChatGPT();
    if (runningChatGPT) {
      if (!(await stopChatGPT())) {
        return { restarted: false, started: false, processName: CHATGPT_PROCESS_NAME };
      }
    }
    const startedChatGPT = await startChatGPT();
    return { restarted: startedChatGPT, started: startedChatGPT, processName: CHATGPT_PROCESS_NAME };
  })().finally(() => {
    restartChatGPTPromise = null;
  });
  return restartChatGPTPromise;
});
ipcMain.handle('update:status', () => updateState);
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('update:download', downloadUpdate);
ipcMain.handle('update:install', () => {
  if (updateState.status !== 'downloaded') throw new Error('更新尚未下载完成。');
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});
ipcMain.handle('window:read-settings', () => readWindowSettings());
ipcMain.handle('window:save-settings', (_event, settings) => saveWindowSettings({
  minimizeToTray: Boolean(settings?.minimizeToTray)
}));
ipcMain.handle('window:resolve-close', async (_event, choice) => {
  if (!closePromptInFlight || !['tray', 'quit'].includes(choice)) return { ok: false };
  try {
    const settings = await saveWindowSettings({
      minimizeToTray: choice === 'tray',
      closeChoiceSet: true
    });
    closePromptInFlight = false;
    applyWindowClose(settings.minimizeToTray);
    return { ok: true };
  } catch (error) {
    closePromptInFlight = false;
    throw error;
  }
});
ipcMain.on('window:cancel-close', () => { closePromptInFlight = false; });
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => { void requestWindowClose(); });

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await migrateLegacyUserData();
  if (process.platform === 'darwin') {
    app.dock?.show();
    app.dock?.setIcon(createMacDockIcon());
  }
  Menu.setApplicationMenu(null);
  // Keep the macOS status-bar item alive for the lifetime of the app. Creating
  // it only after the first close is unreliable in some packaged macOS builds.
  try {
    ensureTray();
  } catch (error) {
    dialog.showErrorBox('macOS 菜单栏图标初始化失败', `${error.message}\n\n日志：${path.join(os.tmpdir(), 'opentk-tray.log')}`);
  }
  createWindow();
  configureAutoUpdater();
  if (app.isPackaged) setTimeout(checkForUpdates, 5000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (process.platform === 'darwin') app.dock?.show();
  if (activeLoginServer?.listening) activeLoginServer.close();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
