(function () {
  const PROVIDER_FIELDS = new Map([
    ['requires_openai_auth', 'requires_openai_auth = false'],
    ['http_headers', 'http_headers = { "x-openai-actor-authorization" = "local-image-extension" }'],
    ['env_key', 'env_key = "OPENAI_API_KEY"']
  ]);

  function newlineFor(content) {
    return content.includes('\r\n') ? '\r\n' : '\n';
  }

  function updateTomlProvider(content) {
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
      if (!PROVIDER_FIELDS.has(key)) {
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

  window.ConfigApply = { updateTomlProvider, updateEnv };
})();
