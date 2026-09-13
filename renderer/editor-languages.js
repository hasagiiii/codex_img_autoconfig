(() => {
  function languageForPath(filePath = '') {
    const name = filePath.split(/[\\/]/).pop().toLowerCase();
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.toml')) return 'toml';
    if (name === '.env' || name.startsWith('.env.')) return 'dotenv';
    return 'plaintext';
  }

  function register(monaco) {
    monaco.languages.register({ id: 'toml', extensions: ['.toml'] });
    monaco.languages.setMonarchTokensProvider('toml', {
      tokenizer: {
        root: [
          [/\s+/, 'white'],
          [/#.*$/, 'comment'],
          [/^\s*\[\[?[^\]\r\n]+\]\]?(?=\s*(?:#.*)?$)/, 'type'],
          [/(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?=\s*[.=])/, 'key'],
          [/"""/, 'string', '@multilineBasic'],
          [/'''/, 'string', '@multilineLiteral'],
          [/"/, 'string', '@basic'],
          [/'/, 'string', '@literal'],
          [/\b(?:true|false)\b/, 'keyword'],
          [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, 'number.date'],
          [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number.date'],
          [/[+-]?(?:inf|nan)\b/, 'number'],
          [/0[xob][0-9a-fA-F_]+/, 'number'],
          [/[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?/, 'number'],
          [/[=.,[\]{}]/, 'delimiter']
        ],
        basic: [
          [/\\(?:[btnfr"\\]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/, 'string.escape'],
          [/\\./, 'invalid'],
          [/"/, 'string', '@pop'],
          [/[^"\\]+/, 'string']
        ],
        literal: [[/'/, 'string', '@pop'], [/[^']+/, 'string']],
        multilineBasic: [
          [/"""/, 'string', '@pop'],
          [/\\(?:[btnfr"\\]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|\s*$)/, 'string.escape'],
          [/[^"\\]+/, 'string'],
          [/./, 'string']
        ],
        multilineLiteral: [[/'''/, 'string', '@pop'], [/[^']+/, 'string'], [/./, 'string']]
      }
    });
    monaco.languages.register({ id: 'dotenv', filenames: ['.env'] });
    monaco.languages.setMonarchTokensProvider('dotenv', {
      includeLF: true,
      tokenizer: {
        root: [
          [/\s+/, 'white'],
          [/#[^\r\n]*/, 'comment'],
          [/\bexport\b/, 'keyword'],
          [/[A-Za-z_][\w.-]*(?=\s*=)/, 'key'],
          [/=/, 'delimiter', '@value']
        ],
        value: [
          [/\n/, '', '@pop'],
          [/[ \t\r]+/, 'white'],
          [/#[^\r\n]*/, 'comment', '@pop'],
          [/"/, 'string', '@double'],
          [/'/, 'string', '@single'],
          [/`/, 'string', '@backtick'],
          [/\$\{[^}]*\}|\$[A-Za-z_]\w*/, 'variable.parameter'],
          [/[^#"'`$\r\n]+/, 'string'],
          [/./, 'string']
        ],
        double: [
          [/\\./, 'string.escape'],
          [/\$\{[^}]*\}|\$[A-Za-z_]\w*/, 'variable.parameter'],
          [/"/, 'string', '@pop'],
          [/[^"\\$]+/, 'string'],
          [/./, 'string']
        ],
        single: [[/'/, 'string', '@pop'], [/[^']+/, 'string']],
        backtick: [[/`/, 'string', '@pop'], [/[^`]+/, 'string']]
      }
    });
    for (const language of ['toml', 'dotenv']) {
      monaco.languages.setLanguageConfiguration(language, {
        comments: { lineComment: '#' },
        brackets: [['[', ']'], ['{', '}']],
        autoClosingPairs: [
          { open: '[', close: ']' }, { open: '{', close: '}' },
          { open: '"', close: '"', notIn: ['string', 'comment'] },
          { open: "'", close: "'", notIn: ['string', 'comment'] }
        ]
      });
    }
  }
  window.ConfigLanguages = { languageForPath, register };
})();
