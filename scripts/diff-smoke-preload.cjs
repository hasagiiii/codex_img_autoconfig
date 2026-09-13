const { contextBridge } = require('electron');
const path = 'C:\\test\\config.toml';
const original = 'model = "old"\nremoved_a = true\nremoved_b = true\nanchor = "same"\nlast = "same"\n';
const modified = 'model = "new"\nadded = true\nanchor = "same"\nlast = "same"\n';
let loggedIn = false;
const authPath = 'C:\\test\\auth.json';
const envPath = 'C:\\test\\.env';
const files = new Map([
  [path, modified],
  [authPath, JSON.stringify({ OPENAI_API_KEY: 'fake-existing-key', tokens: { preserved: true } }, null, 2)]
]);
const authStatus = () => loggedIn
  ? { authenticated: true, user: { name: 'Test User', subject: 'test-user' } }
  : { authenticated: false };
contextBridge.exposeInMainWorld('desktopApi', {
  config: {
    listFiles: async () => [
      { name: 'auth.json', path: authPath, exists: true },
      { name: 'config.toml', path, exists: true },
      ...(files.has(envPath) ? [{ name: '.env', path: envPath, exists: true }] : [])
    ],
    read: async (target = path) => ({ path: target, exists: files.has(target), content: files.get(target) || '', size: (files.get(target) || '').length }),
    listBackups: async () => [
      { path: 'backup', name: 'config.toml.opentk-backup-2026-09-12T08-10-35-237Z', modifiedAt: '2026-09-12T08:10:35.237Z' },
      { path: 'backup-previous', name: 'config.toml.opentk-backup-2026-09-11T08-10-35-237Z', modifiedAt: '2026-09-11T08:10:35.237Z' }
    ],
    readBackup: async () => ({ path: 'backup', name: 'config.toml.opentk-backup-test', content: original, modifiedAt: '2026-09-12' }),
    save: async (target, content) => { files.set(target, content); return { path: target, size: content.length, backupPath: 'fixture-backup' }; },
    openFolder: async () => {},
    deleteBackup: async () => ({ canceled: true })
  },
  oidc: {
    readSettings: async () => ({ issuer: 'https://identity.example.test', clientId: 'opentk-test', redirectUri: 'http://localhost:53682/oauth/callback' }),
    status: async () => authStatus(),
    login: async () => { loggedIn = true; return authStatus(); },
    logout: async () => { loggedIn = false; return authStatus(); },
    apiKeys: async () => [{ id: 'test', label: 'Test API Key', value: 'fake-test-key' }],
    onStatusChanged: () => {}
  },
  update: {
    status: async () => ({ supported: false, status: 'unsupported', unsupportedReason: 'development', currentVersion: '0.1.0' }),
    check: async () => ({ supported: false, status: 'unsupported', unsupportedReason: 'development', currentVersion: '0.1.0' }),
    download: async () => ({ supported: false, status: 'unsupported', unsupportedReason: 'development', currentVersion: '0.1.0' }),
    install: async () => ({ ok: true }),
    onChanged: () => {}
  },
  codex: {
    restart: async () => ({ restarted: false })
  },
  window: {}
});
contextBridge.exposeInMainWorld('testFixture', { removeEnv: () => files.delete(envPath) });
