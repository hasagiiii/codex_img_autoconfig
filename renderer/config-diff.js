(() => {
  let loading;
  function load() {
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
        window.require(['vs/editor/editor.main'], () => {
          window.ConfigLanguages.register(window.monaco);
          resolve(window.monaco);
        }, reject);
      }).catch((error) => { loading = null; throw error; });
    }
    return loading;
  }

  function create(monaco, container, horizontal, spacer, onChange, onStatus, onCursor, onSave) {
    const view = monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark',
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: false,
      originalEditable: false,
      readOnly: false,
      diffAlgorithm: 'advanced',
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false },
      renderIndicators: true,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: false,
      wordWrap: 'off',
      diffWordWrap: 'off',
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontFamily: 'Consolas, monospace',
      fontSize: 13,
      lineHeight: 21,
      lineNumbersMinChars: 3,
      folding: false,
      padding: { top: 12, bottom: 12 },
      scrollbar: { horizontal: 'hidden', vertical: 'auto', alwaysConsumeMouseWheel: false }
    });
    const left = view.getOriginalEditor();
    const right = view.getModifiedEditor();
    let models;
    let changeListener;
    let syncing = false;
    const subscriptions = [];

    function syncHorizontal(offset) {
      if (syncing) return;
      syncing = true;
      horizontal.scrollLeft = offset;
      left.setScrollLeft(offset);
      right.setScrollLeft(offset);
      syncing = false;
    }
    function measureHorizontal() {
      const overflow = Math.max(0,
        left.getScrollWidth() - left.getLayoutInfo().contentWidth,
        right.getScrollWidth() - right.getLayoutInfo().contentWidth);
      spacer.style.width = `${horizontal.clientWidth + overflow}px`;
    }
    const scroll = () => syncHorizontal(horizontal.scrollLeft);
    horizontal.addEventListener('scroll', scroll);
    for (const pane of [left, right]) {
      subscriptions.push(pane.onDidContentSizeChange(measureHorizontal));
      subscriptions.push(pane.onDidLayoutChange(measureHorizontal));
      subscriptions.push(pane.onDidScrollChange((event) => {
        if (event.scrollLeftChanged) syncHorizontal(event.scrollLeft);
      }));
      pane.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    }
    subscriptions.push(right.onDidChangeCursorPosition((event) => onCursor(event.position)));
    subscriptions.push(view.onDidUpdateDiff(() => {
      const changes = view.getLineChanges();
      onStatus(changes ? (changes.length ? `${changes.length} 处差异` : '内容相同') : '正在计算差异...');
    }));

    return {
      view,
      setContents(original, modified, filePath) {
        changeListener?.dispose();
        view.setModel(null);
        models?.original.dispose();
        models?.modified.dispose();
        const language = window.ConfigLanguages.languageForPath(filePath);
        models = {
          original: monaco.editor.createModel(original, language),
          modified: monaco.editor.createModel(modified, language)
        };
        view.setModel(models);
        changeListener = models.modified.onDidChangeContent(() => onChange(models.modified.getValue()));
        onStatus('正在计算差异...');
        horizontal.scrollLeft = 0;
        view.layout();
        left.render(true);
        right.render(true);
        measureHorizontal();
      },
      restore(content) {
        if (!models) return;
        right.pushUndoStop();
        right.executeEdits('restore-backup', [{ range: models.modified.getFullModelRange(), text: content }]);
        right.pushUndoStop();
        right.focus();
      },
      clear() {
        changeListener?.dispose();
        view.setModel(null);
        models?.original.dispose();
        models?.modified.dispose();
        models = null;
      },
      dispose() {
        this.clear();
        horizontal.removeEventListener('scroll', scroll);
        subscriptions.forEach((subscription) => subscription.dispose());
        view.dispose();
      }
    };
  }
  window.ConfigDiff = { load, create };
})();
