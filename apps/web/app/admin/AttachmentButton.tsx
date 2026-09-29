'use client';

import { useRef, useSyncExternalStore, type ChangeEvent } from 'react';
import { Camera, FolderOpen, Paperclip } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { DropdownMenu, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from '@/app/components/ui/dropdown-menu';
import { isMobileAttachmentDevice } from './attachment-device';
import './attachment-button.css';

type AttachmentButtonProps = {
  disabled: boolean;
  imageUploadDisabled: boolean;
  disabledMessage: string;
  imageUploadUnavailableMessage: string;
  editorPortalElement?: Element | null;
  onFiles: (files: File[]) => void;
};

const subscribeToDevice = () => () => {};
const getServerDevice = () => false;
const getClientDevice = () => isMobileAttachmentDevice(typeof navigator === 'undefined' ? undefined : navigator);

export default function AttachmentButton({ disabled, imageUploadDisabled, disabledMessage, imageUploadUnavailableMessage, editorPortalElement, onFiles }: AttachmentButtonProps) {
  const mobile = useSyncExternalStore(subscribeToDevice, getClientDevice, getServerDevice);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraDisabled = disabled || imageUploadDisabled;

  const chooseFiles = () => {
    if (!disabled) fileInput.current?.click();
  };
  const chooseCamera = () => {
    if (!cameraDisabled) cameraInput.current?.click();
  };
  const receiveFiles = (event: ChangeEvent<HTMLInputElement>, blocked: boolean) => {
    const files = Array.from(event.currentTarget.files || []);
    // Clear before handing off so the same file can be chosen again, even on failure.
    event.currentTarget.value = '';
    if (!blocked && files.length) onFiles(files);
  };
  const button = (
    <button
      type="button"
      className={`writing-media-button${disabled ? ' upload-disabled' : ''}`}
      aria-label="添加媒体"
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? disabledMessage : mobile ? '拍摄照片或选择文件' : '选择附件文件'}
      onClick={mobile ? undefined : chooseFiles}
    >
      <Paperclip aria-hidden="true" />附件
    </button>
  );

  return (
    <>
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden disabled={cameraDisabled} aria-label="拍摄照片" onChange={event => receiveFiles(event, cameraDisabled)} />
      {/* No accept/capture hint: let the OS offer its general file picker. Upload validation stays upstream. */}
      <input ref={fileInput} type="file" multiple hidden disabled={disabled} aria-label="选择附件文件" onChange={event => receiveFiles(event, disabled)} />
      {mobile ? (
        <DropdownMenu key={String(disabled)} modal={false}>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
          <DropdownMenuPortal container={editorPortalElement || undefined}>
            {/* The shared Content wrapper owns a body portal; use its primitive to stay inside the quick-write Dialog. */}
            <DropdownMenuPrimitive.Content className="attachment-picker-menu" align="end" sideOffset={8} collisionPadding={12} aria-label="附件来源">
              <DropdownMenuItem className="attachment-picker-item" disabled={cameraDisabled} title={cameraDisabled ? imageUploadUnavailableMessage : undefined} onSelect={chooseCamera}>
                <Camera aria-hidden="true" />拍摄照片
              </DropdownMenuItem>
              <DropdownMenuItem className="attachment-picker-item" disabled={disabled} onSelect={chooseFiles}>
                <FolderOpen aria-hidden="true" />选择文件
              </DropdownMenuItem>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPortal>
        </DropdownMenu>
      ) : button}
    </>
  );
}
