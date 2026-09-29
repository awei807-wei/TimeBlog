type FileTransfer = { files: ArrayLike<File>; types: readonly string[]; items?: ArrayLike<{ kind: string }> };
type FileEvent = {
  clipboardData?: FileTransfer;
  dataTransfer?: FileTransfer;
  preventDefault: () => void;
  stopPropagation: () => void;
};

export function isFileDrag(transfer: FileTransfer): boolean {
  return Array.from(transfer.types).includes('Files')
    || Array.from(transfer.items || []).some(item => item.kind === 'file');
}

export function captureEditorFiles(event: FileEvent, onFiles: ((files: File[]) => void) | undefined, onUnavailable: () => void, disabled = false): boolean {
  const transfer = event.clipboardData || event.dataTransfer;
  if (!transfer) return false;
  const files = Array.from(transfer.files);
  if (!files.length && !(event.dataTransfer && isFileDrag(transfer))) return false;
  event.preventDefault();
  event.stopPropagation();
  if (disabled) return true;
  if (!onFiles) onUnavailable();
  else if (files.length) onFiles(files);
  return true;
}
