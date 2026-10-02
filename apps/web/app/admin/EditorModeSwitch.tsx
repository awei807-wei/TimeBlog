'use client';

import { Code2, Type } from 'lucide-react';
import type { KeyboardEvent } from 'react';

type EditorMode = 'rich' | 'markdown';
type Props = { id: string; mode: EditorMode; onModeChange: (mode: EditorMode) => void; disabled?: boolean };

/** 为正文双模式提供键盘可达、单一 Tab 停靠点的切换入口。 */
export default function EditorModeSwitch({ id, mode, onModeChange, disabled }: Props) {
  const hint = mode === 'rich'
    ? '所见即所得：请使用格式工具栏排版；粘贴的 Markdown 文本会按普通文字处理。'
    : '源码模式：粘贴 Markdown、代码围栏和其他语法时会按原文保存，发布时统一渲染。';
  const switchWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'rich' : event.key === 'End' ? 'markdown' : mode === 'rich' ? 'markdown' : 'rich';
    onModeChange(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  return (
    <div className="markdown-workspace-modebar">
      <div className="markdown-workspace-tabs" role="tablist" aria-label="正文编辑模式" onKeyDown={switchWithKeyboard}>
        {(['rich', 'markdown'] as const).map(value => (
          <button key={value} id={`${id}-${value}-tab`} className="markdown-workspace-tab"
            type="button" role="tab" aria-selected={mode === value} aria-controls={`${id}-panel`}
            tabIndex={mode === value ? 0 : -1} disabled={disabled} onClick={() => onModeChange(value)}>
            {value === 'rich' ? <Type aria-hidden="true" /> : <Code2 aria-hidden="true" />}
            <span><strong>{value === 'rich' ? '富文本' : 'Markdown'}</strong><small>{value === 'rich' ? '所见即所得' : '源码编辑'}</small></span>
          </button>
        ))}
      </div>
      <p className="markdown-workspace-hint">{hint}</p>
    </div>
  );
}
