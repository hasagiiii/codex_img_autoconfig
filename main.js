const { app, BrowserWindow, dialog, ipcMain, shell, Menu, safeStorage } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const dns = require('dns');
const { autoUpdater } = require('electron-updater');

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

const DEFAULT_REDIRECT_URI = 'http://localhost:53682/oauth/callback';
const DEFAULT_OIDC_SETTINGS = {
  issuer: 'https://opentk.ai',
  clientId: 'rp_f226saroedw7mluvsqg5co4mlm',
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

let mainWindow;
let activeLoginServer;
let lastAuthorizationUrl = '';
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
const hasSingleInstanceLock = app.requestSingleInstanceLock();

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

function authSessionPath() {
  return path.join(app.getPath('userData'), 'oidc-session.json');
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
    if (new URL(issuer).hostname.toLowerCase() === 'localhost') {
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
  const existing = CONFIG_CANDIDATES.find((filePath) => {
    try { return fsSync.statSync(filePath).isFile(); } catch { return false; }
  });
  return existing || CONFIG_CANDIDATES[1];
}

function configGroupDirectory() {
  const configured = process.env.CODEX_CONFIG_PATH;
  if (configured) return path.dirname(configured);
  const existing = CONFIG_CANDIDATES.find((filePath) => {
    try { return fsSync.statSync(filePath).isFile(); } catch { return false; }
  });
  return existing ? path.dirname(existing) : path.join(os.homedir(), '.codex');
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
  const storedRedirectUri = stored.redirectUri === 'http://127.0.0.1:53682/oauth/callback'
    ? DEFAULT_REDIRECT_URI
    : stored.redirectUri;
  const settings = {
    issuer: String(stored.issuer || DEFAULT_OIDC_SETTINGS.issuer),
    clientId: String(stored.clientId || DEFAULT_OIDC_SETTINGS.clientId),
    clientAuthMethod: 'none',
    scopes: String(stored.scopes || DEFAULT_OIDC_SETTINGS.scopes),
    redirectUri: storedRedirectUri || DEFAULT_REDIRECT_URI
  };
  const hasLegacySecret = Object.prototype.hasOwnProperty.call(stored, 'clientSecretProtected') ||
    Object.prototype.hasOwnProperty.call(stored, 'clientSecret');
  if (hasLegacySecret || (stored.clientAuthMethod && stored.clientAuthMethod !== 'none')) {
    await fs.mkdir(path.dirname(oidcSettingsPath()), { recursive: true });
    await fs.writeFile(oidcSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
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
  const issuer = String(input.issuer || '').trim().replace(/\/$/, '');
  const clientId = String(input.clientId || '').trim();
  const scopes = String(input.scopes || DEFAULT_OIDC_SETTINGS.scopes).trim();
  const redirectUri = String(input.redirectUri || DEFAULT_REDIRECT_URI).trim();

  validateRedirectUri(redirectUri);
  if (issuer) new URL(issuer);

  const stored = { issuer, clientId, clientAuthMethod: 'none', scopes, redirectUri };
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
  const request = () => fetch(endpoint, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
  });
  let response = await request();
  if (response.status === 401) {
    await response.text();
    accessToken = await readStoredAccessToken(accessToken);
    response = await request();
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
  const close = () => {
    clearTimeout(timer);
    if (server.listening) server.close();
    if (activeLoginServer === server) activeLoginServer = null;
  };
  activeLoginServer = server;
  return { callback, close };
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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 650,
    backgroundColor: '#101417',
    title: 'OpenTk',
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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('config:list-files', listConfigFiles);
ipcMain.handle('config:read', (_event, targetPath) => readConfig(targetPath));
ipcMain.handle('config:save', (_event, payload) => saveConfig(payload?.path, String(payload?.content ?? '')));
ipcMain.handle('config:list-backups', (_event, targetPath) => listBackups(targetPath));
ipcMain.handle('config:read-backup', (_event, backupPath) => readBackup(backupPath));
ipcMain.handle('config:delete-backup', (_event, targetPath, backupPath) => deleteBackup(targetPath, backupPath));
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
ipcMain.handle('auth:status', getAuthStatus);
ipcMain.handle('auth:login', startOidcLogin);
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
  if (process.platform !== 'win32') return null;
  try {
    const command = "(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Select-Object -First 1).Id";
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', command
    ], { windowsHide: true });
    return stdout.trim() ? { processName: CHATGPT_PROCESS_NAME } : null;
  } catch {
    return null;
  }
}

async function waitForChatGPTStart(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await findRunningChatGPT()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return Boolean(await findRunningChatGPT());
}

async function startChatGPT() {
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

ipcMain.handle('codex:restart', async () => {
  const runningChatGPT = await findRunningChatGPT();
  if (runningChatGPT) {
    try {
      await execFileAsync('taskkill.exe', ['/IM', CHATGPT_PROCESS_NAME, '/T', '/F'], { windowsHide: true });
    } catch {
      // The process may have exited between detection and taskkill.
    }
    if (!(await waitForChatGPTExit())) {
      return { restarted: false, started: false, processName: CHATGPT_PROCESS_NAME };
    }
  }
  const startedChatGPT = await startChatGPT();
  return { restarted: startedChatGPT, started: startedChatGPT, processName: CHATGPT_PROCESS_NAME };
});
ipcMain.handle('update:status', () => updateState);
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('update:download', downloadUpdate);
ipcMain.handle('update:install', () => {
  if (updateState.status !== 'downloaded') throw new Error('更新尚未下载完成。');
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  createWindow();
  configureAutoUpdater();
  if (app.isPackaged) setTimeout(checkForUpdates, 5000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (activeLoginServer?.listening) activeLoginServer.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
