(() => {
  function create(monaco, container, onChange, onCursor, onSave) {
    const view = monaco.editor.create(container, {
      theme: 'vs-dark', automaticLayout: true,
      wordWrap: 'off', scrollBeyondLastLine: false,
      fontFamily: 'Consolas, monospace', fontSize: 13, lineHeight: 21,
      minimap: { enabled: false }, lineNumbersMinChars: 3,
      padding: { top: 12, bottom: 12 },
      scrollbar: { horizontal: 'auto', vertical: 'auto' }
    });
    let model;
    let listener;
    view.onDidChangeCursorPosition((event) => onCursor(event.position));
    view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    return {
      view,
      setContents(content, filePath) {
        listener?.dispose();
        view.setModel(null);
        model?.dispose();
        model = monaco.editor.createModel(content, window.ConfigLanguages.languageForPath(filePath));
        view.setModel(model);
        listener = model.onDidChangeContent(() => onChange(model.getValue()));
        view.layout();
      },
      setValue(content) {
        if (!model || model.getValue() === content) return;
        view.pushUndoStop();
        view.executeEdits('sync-diff', [{ range: model.getFullModelRange(), text: content }]);
        view.pushUndoStop();
      },
      dispose() {
        listener?.dispose();
        view.dispose();
        model?.dispose();
      }
    };
  }
  window.ConfigEditor = { create };
})();
