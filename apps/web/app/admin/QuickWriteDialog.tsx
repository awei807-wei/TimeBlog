'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import { useSession } from '../SessionContext';
import AdminEditorView from './AdminEditorView';
import { useAdminPageController } from './useAdminPageController';

export type QuickWriteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The opener to restore focus to after a normal close. */
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  /** The home FAB uses this to remove the editor after a confirmed session loss. */
  onSessionInvalid?: () => void;
};

function hasAuthoredContent(controller: ReturnType<typeof useAdminPageController>) {
  const markdown = controller.editorRef.current?.getMarkdown() ?? controller.markdown;
  return Boolean(
    markdown.trim()
    || controller.title.trim()
    || controller.summary.trim()
    || controller.slug.trim()
    || controller.tags.length
    || controller.categories.length !== 1
    || controller.categories[0] !== '日常',
  );
}

/**
 * The controller remains alive after a normal close so reopening resumes the
 * same draft. Its persistence timers are paused while hidden, preventing the
 * inactive snapshot from overwriting another tab's newer work.
 */
export default function QuickWriteDialog({ open, onOpenChange, returnFocusRef, onSessionInvalid }: QuickWriteDialogProps) {
  const controller = useAdminPageController({ editEntryID: null, active: open });
  const { state } = useSession();
  const editorPortalRef = useRef<HTMLDivElement>(null);
  const sessionCloseAttemptedRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [closeMessage, setCloseMessage] = useState('');

  const requestClose = useCallback(async (sessionInvalid = false) => {
    if (closing) return;
    if (!sessionInvalid && controller.mediaStillProcessing) {
      setCloseMessage('上传中，请等待附件完成或先取消上传后再关闭。');
      return;
    }
    if (!sessionInvalid && controller.saving) {
      setCloseMessage('保存中，请等待保存完成后再关闭。');
      return;
    }

    setClosing(true);
    setCloseMessage(sessionInvalid ? '登录状态已失效，正在安全保存草稿…' : '正在保存草稿…');
    try {
      // A close is an explicit user boundary: bypass the 500ms debounce and
      // use the same IndexedDB + tray + working-copy path immediately.
      const persisted = await controller.persistNow();
      if (!persisted && hasAuthoredContent(controller)) {
        if (sessionInvalid) {
          setCloseMessage('登录已失效，且本地保存失败；内容仍保留在窗口中，请先复制正文再关闭。');
          return;
        }
        setCloseMessage('本地保存失败，请保持窗口打开并检查浏览器存储后重试。');
        return;
      }
      if (sessionInvalid) {
        onSessionInvalid?.();
      } else {
        setCloseMessage('');
        onOpenChange(false);
      }
    } catch {
      if (sessionInvalid) {
        setCloseMessage('登录已失效，且草稿无法落盘；内容仍保留在窗口中，请先复制正文。');
      } else {
        setCloseMessage('本地保存失败，请保持窗口打开并重试。');
      }
    } finally {
      setClosing(false);
    }
  }, [closing, controller, onOpenChange, onSessionInvalid]);

  useEffect(() => {
    if (!open || state === 'authenticated' || state === 'loading') {
      sessionCloseAttemptedRef.current = false;
      return;
    }
    if (sessionCloseAttemptedRef.current) return;
    sessionCloseAttemptedRef.current = true;
    const timer = window.setTimeout(() => { void requestClose(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [open, requestClose, state]);

  const handleEditorReady = useCallback((ready: boolean) => {
    controller.onEditorReady(ready);
    if (!ready || !open) return;
    window.requestAnimationFrame(() => controller.editorRef.current?.focus());
  }, [controller, open]);

  const blockOutsideClose = controller.mediaStillProcessing || controller.saving || closing;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={nextOpen => {
        if (nextOpen) {
          setCloseMessage('');
          onOpenChange(true);
        } else {
          void requestClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="quick-write-dialog-overlay" />
        <Dialog.Content
          ref={editorPortalRef}
          className="quick-write-dialog-content"
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (!sessionCloseAttemptedRef.current) returnFocusRef?.current?.focus();
          }}
          onEscapeKeyDown={event => {
            if (blockOutsideClose) event.preventDefault();
          }}
          onPointerDownOutside={event => {
            if (blockOutsideClose) event.preventDefault();
          }}
        >
          <header className="quick-write-dialog-header">
            <div className="quick-write-dialog-heading">
              <Dialog.Title>快速写作</Dialog.Title>
              <Dialog.Description>先记下来，草稿会保存在本机；准备好后再发布。</Dialog.Description>
            </div>
            <button
              type="button"
              className="quick-write-dialog-close"
              aria-label={closing ? '正在保存草稿' : '关闭快速写作'}
              disabled={closing}
              onClick={() => void requestClose()}
            >
              {closing ? <LoaderCircle className="spin" aria-hidden="true" /> : <X aria-hidden="true" />}
            </button>
          </header>
          {closeMessage && <p className="quick-write-dialog-status" role="status">{closeMessage}</p>}
          <div className="quick-write-dialog-scroll" inert={closing || undefined} aria-busy={closing || undefined}>
            <AdminEditorView {...controller} saving={controller.saving || closing} presentation="dialog" editorPortalRef={editorPortalRef} onEditorReady={handleEditorReady} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
