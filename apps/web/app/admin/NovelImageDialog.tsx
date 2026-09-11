'use client';

import { useId, useState } from 'react';
import { ImagePlus, Link2, Upload, X } from 'lucide-react';
import { useEditor } from 'novel';
import { Dialog } from 'radix-ui';
import { validateExternalImageURL } from './novel-url';

type NovelImageDialogProps = {
  open: boolean;
  uploadEnabled: boolean;
  uploadMessage?: string;
  editorPortalElement?: Element | null;
  onOpenChange: (open: boolean) => void;
  onChooseFile: () => void;
};

export default function NovelImageDialog({ open, uploadEnabled, uploadMessage, editorPortalElement, onOpenChange, onChooseFile }: NovelImageDialogProps) {
  const { editor } = useEditor();
  const [url, setURL] = useState('');
  const [alt, setAlt] = useState('');
  const [error, setError] = useState('');
  const titleID = useId();
  const descriptionID = useId();
  const urlID = useId();
  const altID = useId();
  const contained = Boolean(editorPortalElement);

  const changeOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
  };

  const insertExternalImage = () => {
    const result = validateExternalImageURL(url);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (!editor?.chain().setImage({ src: result.value, alt: alt.trim() }).run()) {
      setError('当前光标位置无法插入图片，请返回正文后重试。');
      return;
    }
    changeOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal container={(editorPortalElement as HTMLElement | null) || undefined}>
        <Dialog.Overlay className={`novel-insert-dialog-overlay${contained ? ' is-contained' : ''}`} />
        <Dialog.Content
          className={`novel-insert-dialog${contained ? ' is-contained' : ''}`}
          aria-labelledby={titleID}
          aria-describedby={descriptionID}
          onCloseAutoFocus={event => {
            event.preventDefault();
            editor?.commands.focus();
          }}
        >
          <header className="novel-insert-dialog-header">
            <div>
              <Dialog.Title id={titleID}><ImagePlus aria-hidden="true" />插入图片</Dialog.Title>
              <Dialog.Description id={descriptionID}>上传到站点媒体库，或直接使用图床公开链接。</Dialog.Description>
            </div>
            <Dialog.Close type="button" className="novel-insert-dialog-close" aria-label="关闭图片面板"><X aria-hidden="true" /></Dialog.Close>
          </header>

          <section className="novel-image-upload-option" aria-labelledby={`${titleID}-upload`}>
            <div>
              <strong id={`${titleID}-upload`}><Upload aria-hidden="true" />从设备上传</strong>
              <span>{uploadEnabled ? '保留本地规范原件，并继续使用现有媒体发布链。' : uploadMessage || '媒体存储暂不可用。'}</span>
            </div>
            <button type="button" disabled={!uploadEnabled} onClick={onChooseFile}>选择图片</button>
          </section>

          <div className="novel-insert-dialog-divider"><span>或使用图片链接</span></div>

          <form className="novel-image-link-form" noValidate onSubmit={event => { event.preventDefault(); insertExternalImage(); }}>
            <label htmlFor={urlID}>
              <span><Link2 aria-hidden="true" />图片地址</span>
              <input
                id={urlID}
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={url}
                placeholder="https://image.example.com/photo.webp"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${urlID}-error` : undefined}
                onChange={event => { setURL(event.target.value); setError(''); }}
              />
            </label>
            <label htmlFor={altID}>
              <span>替代文字 <small>可选，用于无障碍与图片加载失败时说明内容</small></span>
              <input id={altID} value={alt} maxLength={240} placeholder="例如：湖边日落" onChange={event => setAlt(event.target.value)} />
            </label>
            {error && <p id={`${urlID}-error`} className="novel-insert-dialog-error" role="alert">{error}</p>}
            <div className="novel-insert-dialog-actions">
              <Dialog.Close type="button" className="secondary">取消</Dialog.Close>
              <button type="submit" className="primary" disabled={!url.trim()}>插入链接图片</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
