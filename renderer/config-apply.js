(function () {
  const PROVIDER_FIELDS = new Map([
    ['requires_openai_auth', 'requires_openai_auth = false'],
    ['http_headers', 'http_headers = { "x-openai-actor-authorization" = "local-image-extension" }'],
    ['env_key', 'env_key = "OPENAI_API_KEY"']
  ]);

  function newlineFor(content) {
    return content.includes('\r\n') ? '\r\n' : '\n';
  }

  function normalizeTomlContent(content) {
    // A previous write could concatenate a new table header to the preceding
    // assignment when the source file had no trailing newline. Split that
    // header before any further section edits so fields stay in their table.
    return String(content || '')
      .replace(/[ \t]+(?=\[\[?[A-Za-z_])/g, '\n')
      .replace(/^(\s*\[\[?[^\r\n\]]+\]\]?)[ \t]+(?=[A-Za-z0-9_-]+\s*=)/gm, '$1\n');
  }

  function providerKeyValue(providerKey) {
    const value = String(providerKey || 'custom').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('供应商标识只能包含字母、数字、下划线和短横线');
    return value;
  }

  function providerHeader(providerKey) {
    return `[model_providers.${providerKeyValue(providerKey)}]`;
  }

  function updateTomlProvider(content, providerKey = 'custom') {
    content = normalizeTomlContent(content);
    const key = providerKeyValue(providerKey);
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();

    const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]\\s*(?:#.*)?$`);
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const start = lines.findIndex((line) => headerPattern.test(line));

    if (start < 0) {
      if (lines.length && lines.at(-1).trim()) lines.push('');
      lines.push(providerHeader(key), ...PROVIDER_FIELDS.values());
      return `${lines.join(newline)}${newline}`;
    }

    let end = lines.findIndex((line, index) => index > start && tablePattern.test(line));
    if (end < 0) end = lines.length;
    const seen = new Set();
    const section = [];
    for (const line of lines.slice(start + 1, end)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      const key = match?.[1];
      if (!PROVIDER_FIELDS.has(key) && key !== 'base_url') {
        section.push(line);
      } else if (!seen.has(key)) {
        section.push(PROVIDER_FIELDS.get(key));
        seen.add(key);
      }
    }
    for (const [key, assignment] of PROVIDER_FIELDS) {
      if (!seen.has(key)) section.push(assignment);
    }
    lines.splice(start + 1, end - start - 1, ...section);
    return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`;
  }

  function updateEnv(content, apiKey, envKey = 'OPENAI_API_KEY') {
    if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行符');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) throw new Error('环境变量名称无效');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const envPattern = new RegExp(`^\\s*(?:export\\s+)?${envKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    const assignment = `${envKey} = ${apiKey}`;
    let found = false;
    const updated = lines.filter((line) => {
      if (!envPattern.test(line)) return true;
      if (found) return false;
      found = true;
      return true;
    }).map((line) => envPattern.test(line) ? assignment : line);
    if (!found) updated.push(assignment);
    return `${updated.join(newline)}${newline}`;
  }

  function updateBaseUrl(content, baseUrl, providerKey = 'custom') {
    content = normalizeTomlContent(content);
    const key = providerKeyValue(providerKey);
    const value = String(baseUrl || '').trim();
    if (/\r|\n/.test(value)) throw new Error('Base URL 不能包含换行符');
    if (!/^https?:\/\//i.test(value)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]\\s*(?:#.*)?$`);
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    let start = lines.findIndex((line) => headerPattern.test(line));
    if (start < 0) {
      if (lines.length && lines.at(-1).trim()) lines.push('');
      lines.push(providerHeader(key), `base_url = "${value}"`);
      return `${lines.join(newline)}${newline}`;
    }
    let end = lines.findIndex((line, index) => index > start && tablePattern.test(line));
    if (end < 0) end = lines.length;
    let found = false;
    const section = lines.slice(start + 1, end).map((line) => {
      if (!/^\s*base_url\s*=/.test(line)) return line;
      if (found) return null;
      found = true;
      return `base_url = "${value}"`;
    }).filter((line) => line !== null);
    if (!found) section.push(`base_url = "${value}"`);
    lines.splice(start + 1, end - start - 1, ...section);
    return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`;
  }

  function createTomlProvider(content, providerKey, name, baseUrl, envKey = 'OPENAI_API_KEY') {
    const key = providerKeyValue(providerKey);
    const cleanName = String(name || '').trim();
    if (!cleanName || /[\r\n]/.test(cleanName)) throw new Error('供应商名称不能为空或包含换行符');
    let output = updateTomlProvider(content, key);
    output = updateBaseUrl(output, baseUrl, key);
    output = updateProviderEnvKey(output, key, envKey);
    const escapedName = cleanName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const newline = newlineFor(output);
    const lines = output.split(/\r?\n/);
    const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]\\s*(?:#.*)?$`);
    const start = lines.findIndex((line) => headerPattern.test(line));
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    let end = lines.findIndex((line, index) => index > start && tablePattern.test(line));
    if (end < 0) end = lines.length;
    const section = lines.slice(start + 1, end);
    const nameIndex = section.findIndex((line) => /^\s*name\s*=/.test(line));
    if (nameIndex >= 0) section[nameIndex] = `name = "${escapedName}"`;
    else section.unshift(`name = "${escapedName}"`);
    lines.splice(start + 1, end - start - 1, ...section);
    return lines.join(newline);
  }

  function updateModel(content, model) {
    const value = String(model || '').trim();
    if (!value) throw new Error('模型不能为空');
    if (/\r|\n/.test(value)) throw new Error('模型不能包含换行符');
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const topLevelEnd = lines.findIndex((line) => tablePattern.test(line));
    const topLevelLimit = topLevelEnd < 0 ? lines.length : topLevelEnd;
    let found = false;
    const updated = lines.map((line, index) => {
      if (index >= topLevelLimit || !/^\s*model\s*=/.test(line)) return line;
      if (found) return null;
      found = true;
      return `model = "${escaped}"`;
    }).filter((line) => line !== null);
    if (!found) updated.unshift(`model = "${escaped}"`);
    return `${updated.join(newline)}${newline}`;
  }

  function updateProviderModel(content, model, providerKey) {
    const value = String(model || '').trim();
    if (!value) throw new Error('模型不能为空');
    if (/\r|\n/.test(value)) throw new Error('模型不能包含换行符');
    const key = providerKeyValue(providerKey);
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = normalizeTomlContent(content).split(/\r?\n/);
    if (hadTrailingNewline) lines.pop();
    const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]\\s*(?:#.*)?$`);
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const start = lines.findIndex((line) => headerPattern.test(line));
    if (start < 0) throw new Error('没有找到当前供应商配置');
    let end = lines.findIndex((line, index) => index > start && tablePattern.test(line));
    if (end < 0) end = lines.length;
    const section = lines.slice(start + 1, end);
    const modelIndex = section.findIndex((line) => /^\s*model\s*=/.test(line));
    if (modelIndex >= 0) section[modelIndex] = `model = "${escaped}"`;
    else section.unshift(`model = "${escaped}"`);
    lines.splice(start + 1, end - start - 1, ...section);
    return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`;
  }

  function updateProviderEnvKey(content, providerKey, envKey) {
    const key = providerKeyValue(providerKey);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) throw new Error('环境变量名称无效');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = normalizeTomlContent(content).split(/\r?\n/);
    if (hadTrailingNewline) lines.pop();
    const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]\\s*(?:#.*)?$`);
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const start = lines.findIndex((line) => headerPattern.test(line));
    if (start < 0) throw new Error('没有找到当前供应商配置');
    let end = lines.findIndex((line, index) => index > start && tablePattern.test(line));
    if (end < 0) end = lines.length;
    const section = lines.slice(start + 1, end);
    const envIndex = section.findIndex((line) => /^\s*env_key\s*=/.test(line));
    if (envIndex >= 0) section[envIndex] = `env_key = "${envKey}"`;
    else section.push(`env_key = "${envKey}"`);
    lines.splice(start + 1, end - start - 1, ...section);
    return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`;
  }

  function updateActiveProvider(content, providerKey) {
    const value = providerKeyValue(providerKey);
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const topLevelLimit = lines.findIndex((line) => tablePattern.test(line));
    const limit = topLevelLimit < 0 ? lines.length : topLevelLimit;
    let found = false;
    const updated = lines.map((line, index) => {
      if (index >= limit || !/^\s*model_provider\s*=/.test(line)) return line;
      if (found) return null;
      found = true;
      return `model_provider = "${value}"`;
    }).filter((line) => line !== null);
    if (!found) updated.unshift(`model_provider = "${value}"`);
    return `${updated.join(newline)}${newline}`;
  }

  function updateModelCatalogJson(content, catalogPath = '~/.codex/models_cache.json') {
    const value = String(catalogPath || '').trim();
    if (!value || /[\r\n]/.test(value)) throw new Error('模型缓存路径不能为空或包含换行符');
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const topLevelLimit = lines.findIndex((line) => tablePattern.test(line));
    const limit = topLevelLimit < 0 ? lines.length : topLevelLimit;
    let found = false;
    const updated = lines.map((line, index) => {
      if (index >= limit || !/^\s*model_catalog_json\s*=/.test(line)) return line;
      if (found) return null;
      found = true;
      return `model_catalog_json = "${escaped}"`;
    }).filter((line) => line !== null);
    if (!found) updated.unshift(`model_catalog_json = "${escaped}"`);
    return `${updated.join(newline)}${newline}`;
  }

  window.ConfigApply = { updateTomlProvider, updateBaseUrl, createTomlProvider, updateModel, updateProviderModel, updateProviderEnvKey, updateActiveProvider, updateModelCatalogJson, updateEnv };
})();
