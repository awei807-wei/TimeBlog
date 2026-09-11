'use client';

import { useId, useState } from 'react';
import { Link2, Unlink, X } from 'lucide-react';
import { useEditor } from 'novel';
import { Dialog } from 'radix-ui';
import { validateEditorLinkURL } from './novel-url';

type NovelLinkDialogProps = {
  open: boolean;
  editorPortalElement?: Element | null;
  onOpenChange: (open: boolean) => void;
};

export default function NovelLinkDialog({ open, editorPortalElement, onOpenChange }: NovelLinkDialogProps) {
  const { editor } = useEditor();
  const [url, setURL] = useState(() => String(editor?.getAttributes('link').href || ''));
  const [error, setError] = useState('');
  const titleID = useId();
  const descriptionID = useId();
  const urlID = useId();
  const hasLink = Boolean(editor?.isActive('link'));
  const contained = Boolean(editorPortalElement);

  const changeOpen = (nextOpen: boolean) => onOpenChange(nextOpen);
  const applyLink = () => {
    const result = validateEditorLinkURL(url);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (!editor?.chain().extendMarkRange('link').setLink({ href: result.value }).run()) {
      setError('请先在正文中选择要添加链接的文字。');
      return;
    }
    changeOpen(false);
  };
  const removeLink = () => {
    editor?.chain().extendMarkRange('link').unsetLink().run();
    changeOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal container={(editorPortalElement as HTMLElement | null) || undefined}>
        <Dialog.Overlay className={`novel-insert-dialog-overlay${contained ? ' is-contained' : ''}`} />
        <Dialog.Content
          className={`novel-insert-dialog novel-link-dialog${contained ? ' is-contained' : ''}`}
          aria-labelledby={titleID}
          aria-describedby={descriptionID}
          onCloseAutoFocus={event => {
            event.preventDefault();
            editor?.commands.focus();
          }}
        >
          <header className="novel-insert-dialog-header">
            <div>
              <Dialog.Title id={titleID}><Link2 aria-hidden="true" />添加链接</Dialog.Title>
              <Dialog.Description id={descriptionID}>为当前选中的文字设置网页、站内路径或页内锚点。</Dialog.Description>
            </div>
            <Dialog.Close type="button" className="novel-insert-dialog-close" aria-label="关闭链接面板"><X aria-hidden="true" /></Dialog.Close>
          </header>
          <form className="novel-image-link-form" noValidate onSubmit={event => { event.preventDefault(); applyLink(); }}>
            <label htmlFor={urlID}>
              <span>链接地址</span>
              <input
                id={urlID}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={url}
                placeholder="https://example.com 或 /article/example"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${urlID}-error` : undefined}
                onChange={event => { setURL(event.target.value); setError(''); }}
              />
            </label>
            {error && <p id={`${urlID}-error`} className="novel-insert-dialog-error" role="alert">{error}</p>}
            <div className="novel-insert-dialog-actions">
              {hasLink && <button type="button" className="danger-quiet" onClick={removeLink}><Unlink aria-hidden="true" />移除链接</button>}
              <Dialog.Close type="button" className="secondary">取消</Dialog.Close>
              <button type="submit" className="primary" disabled={!url.trim()}>应用链接</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
