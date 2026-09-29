type AttachmentDevice = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
};

// iPadOS may request desktop sites while retaining a multi-touch MacIntel platform.
// Viewport width is deliberately irrelevant: a narrow desktop still selects files.
export function isMobileAttachmentDevice(device?: AttachmentDevice): boolean {
  if (!device) return false;
  return /Android|iPhone|iPad/i.test(device.userAgent || '')
    || (device.platform === 'MacIntel' && (device.maxTouchPoints || 0) > 1);
}
