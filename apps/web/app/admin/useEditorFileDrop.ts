'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { isFileDrag } from './editor-file-input';

export function useEditorFileDrop(enabled: boolean) {
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);
  const resetDrag = useCallback(() => { depth.current = 0; setDragActive(false); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') resetDrag(); };
    window.addEventListener('drop', resetDrag, true);
    window.addEventListener('dragend', resetDrag);
    window.addEventListener('blur', resetDrag);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('drop', resetDrag, true);
      window.removeEventListener('dragend', resetDrag);
      window.removeEventListener('blur', resetDrag);
      window.removeEventListener('keydown', onKey);
    };
  }, [resetDrag]);

  const onDragEnterCapture = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current += 1;
    if (enabled) setDragActive(true);
  }, [enabled]);
  const onDragOverCapture = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    if (enabled) setDragActive(true);
  }, [enabled]);
  const onDragLeaveCapture = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!depth.current) return;
    event.preventDefault();
    event.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    if (!depth.current || related instanceof Node) resetDrag();
  }, [resetDrag]);

  return { dragActive: enabled && dragActive, resetDrag, onDragEnterCapture, onDragOverCapture, onDragLeaveCapture };
}
