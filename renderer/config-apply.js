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

  function updateTomlProvider(content) {
    content = normalizeTomlContent(content);
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();

    const headerPattern = /^\s*\[\s*model_providers\.custom\s*\]\s*(?:#.*)?$/;
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    const start = lines.findIndex((line) => headerPattern.test(line));

    if (start < 0) {
      if (lines.length && lines.at(-1).trim()) lines.push('');
      lines.push('[model_providers.custom]', ...PROVIDER_FIELDS.values());
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

  function updateEnv(content, apiKey) {
    if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行符');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const assignment = `OPENAI_API_KEY = ${apiKey}`;
    let found = false;
    const updated = lines.filter((line) => {
      if (!/^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line)) return true;
      if (found) return false;
      found = true;
      return true;
    }).map((line) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(line) ? assignment : line);
    if (!found) updated.push(assignment);
    return `${updated.join(newline)}${newline}`;
  }

  function updateBaseUrl(content, baseUrl) {
    content = normalizeTomlContent(content);
    const value = String(baseUrl || '').trim();
    if (/\r|\n/.test(value)) throw new Error('Base URL 不能包含换行符');
    if (!/^https?:\/\//i.test(value)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
    const newline = newlineFor(content);
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content ? content.split(/\r?\n/) : [];
    if (hadTrailingNewline) lines.pop();
    const headerPattern = /^\s*\[\s*model_providers\.custom\s*\]\s*(?:#.*)?$/;
    const tablePattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
    let start = lines.findIndex((line) => headerPattern.test(line));
    if (start < 0) {
      if (lines.length && lines.at(-1).trim()) lines.push('');
      lines.push('[model_providers.custom]', `base_url = "${value}"`);
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

  window.ConfigApply = { updateTomlProvider, updateBaseUrl, updateModel, updateModelCatalogJson, updateEnv };
})();
