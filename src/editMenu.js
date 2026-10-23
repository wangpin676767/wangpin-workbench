function template(params = {}) {
  const flags = params.editFlags || {};
  const items = [];
  if (params.isEditable) items.push(
    { label: '復原', role: 'undo', enabled: !!flags.canUndo },
    { label: '重做', role: 'redo', enabled: !!flags.canRedo },
    { type: 'separator' },
    { label: '剪下', role: 'cut', enabled: !!flags.canCut },
  );
  items.push({ label: '複製', role: 'copy', enabled: !!flags.canCopy || !!params.selectionText });
  if (params.isEditable) items.push({ label: '貼上', role: 'paste', enabled: !!flags.canPaste });
  items.push({ type: 'separator' }, { label: '全選', role: 'selectAll' });
  return items;
}
module.exports = { template };
