const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const source = main.slice(main.indexOf('let tokenRefreshPromise'), main.indexOf('function normalizeApiKeys'))
  .replace("await import('openid-client')", 'oidcMock');

function setup(grant, tokenOverrides = {}) {
  let stored = {
    issuer: 'https://example.test', clientId: 'app', expiresAt: 1,
    tokenSetProtected: JSON.stringify({ access_token: 'old', refresh_token: 'refresh', ...tokenOverrides })
  };
  let calls = 0;
  let discovery;
  const context = vm.createContext({
    Date, URL, JSON, Error,
    readJson: async () => stored,
    authSessionPath: () => 'session',
    unprotect: (value) => value,
    protect: (value) => value,
    readOidcSettings: async () => ({ issuer: 'https://example.test', clientId: 'app', clientAuthMethod: 'none' }),
    allowLocalOidcCertificate: () => {},
    fsSync: { writeFileSync: (_path, value) => { stored = JSON.parse(value); } },
    logout: async () => { stored = null; vm.runInContext('authRevision += 1', context); },
    oidcErrorMessage: (error) => error.message,
    oidcMock: {
      discovery: async (_issuer, _clientId, metadata, authentication) => {
        discovery = { metadata, authentication };
        return { serverMetadata: () => ({ token_endpoint_auth_methods_supported: ['none'] }) };
      },
      None: () => 'none',
      refreshTokenGrant: async () => { calls++; return grant(); }
    }
  });
  vm.runInContext(source, context);
  return {
    read: (rejected) => context.readStoredAccessToken(rejected),
    session: () => stored,
    calls: () => calls,
    discovery: () => discovery,
    logout: context.logout
  };
}

test('concurrent refresh is shared and rotated token is persisted', async () => {
  const env = setup(async () => ({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }));
  assert.deepEqual(await Promise.all([env.read(), env.read()]), ['new', 'new']);
  assert.equal(env.calls(), 1);
  assert.equal(env.discovery().metadata.token_endpoint_auth_method, 'none');
  assert.equal(env.discovery().authentication, 'none');
  assert.equal(JSON.parse(env.session().tokenSetProtected).refresh_token, 'rotated');
  assert.equal(await env.read('old'), 'new');
  assert.equal(env.calls(), 1);
});

test('legacy OIDC settings are rewritten without Client Secret', async () => {
  const writes = [];
  const legacy = {
    issuer: 'https://example.test', clientId: 'desktop', scopes: 'openid',
    redirectUri: 'http://localhost:53682/oauth/callback',
    clientAuthMethod: 'client_secret_post', clientSecretProtected: 'encrypted-secret'
  };
  const context = vm.createContext({
    URL, Object,
    DEFAULT_OIDC_SETTINGS: { issuer: 'https://opentk.ai', clientId: 'rp_f226saroedw7mluvsqg5co4mlm', clientAuthMethod: 'none', scopes: 'openid profile email offline_access sub2api:apikey', redirectUri: 'http://localhost:53682/oauth/callback' },
    DEFAULT_REDIRECT_URI: 'http://localhost:53682/oauth/callback',
    readJson: async () => legacy,
    oidcSettingsPath: () => 'settings.json',
    path: { dirname: () => '.' },
    fs: {
      mkdir: async () => {},
      writeFile: async (_path, value) => writes.push(JSON.parse(value))
    }
  });
  const settingsSource = main.slice(main.indexOf('async function readOidcSettings('), main.indexOf('let tokenRefreshPromise'));
  vm.runInContext(settingsSource, context);
  const settings = await context.readOidcSettings();
  assert.equal(settings.clientAuthMethod, 'none');
  assert.equal('clientSecret' in settings, false);
  assert.equal('clientSecretProtected' in settings, false);
  assert.equal(writes.length, 1);
  assert.equal('clientSecretProtected' in writes[0], false);

  writes.length = 0;
  await context.saveOidcSettings({ ...settings, clientSecret: 'must-not-be-saved' });
  assert.equal('clientSecret' in writes[0], false);
  assert.equal(writes[0].clientAuthMethod, 'none');
});

test('missing replacement refresh token preserves original', async () => {
  const env = setup(async () => ({ access_token: 'new', expires_in: 3600 }));
  await env.read();
  assert.equal(JSON.parse(env.session().tokenSetProtected).refresh_token, 'refresh');
});

test('expired refresh token clears session', async () => {
  const env = setup(async () => { throw Object.assign(new Error('expired'), { error: 'invalid_grant' }); });
  await assert.rejects(env.read());
  assert.equal(env.session(), null);
});

test('missing refresh token clears session', async () => {
  const env = setup(async () => {}, { refresh_token: undefined });
  await assert.rejects(env.read());
  assert.equal(env.session(), null);
  assert.equal(env.calls(), 0);
});

test('temporary failure preserves session', async () => {
  const env = setup(async () => { throw new Error('network unavailable'); });
  await assert.rejects(env.read());
  assert.ok(env.session());
});

test('logout during refresh cannot recreate session', async () => {
  let finish;
  const env = setup(() => new Promise((resolve) => { finish = resolve; }));
  const pending = env.read();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await env.logout();
  finish({ access_token: 'new', expires_in: 3600 });
  await assert.rejects(pending);
  assert.equal(env.session(), null);
});
