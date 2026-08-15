'use client';

import { useEffect, useId, useRef, useState } from 'react';

type TagInputProps = {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  ariaLabel: string;
  prefix?: string;
};

function cleanTag(value: string, prefix = '') {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return prefix === '#' ? trimmed.replace(/^#+/, '').trim() : trimmed;
}

function dedupeTags(values: string[]) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * A small accessible tag editor. Enter commits one complete tag, while a
 * double-click on an existing chip switches that chip into an inline editor.
 * The composition guard is important for Chinese IME input: pressing Enter to
 * confirm a composed character must not create a tag prematurely.
 */
export default function TagInput({ label, values, onChange, placeholder, ariaLabel, prefix = '' }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [composing, setComposing] = useState(false);
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (editingIndex !== null) editingInputRef.current?.focus();
  }, [editingIndex]);

  const commitDraft = () => {
    const value = cleanTag(draft, prefix);
    if (!value) {
      setDraft('');
      return;
    }
    onChange(dedupeTags([...values, value]));
    setDraft('');
  };

  const commitEdit = () => {
    if (editingIndex === null) return;
    const value = cleanTag(editingValue, prefix);
    const next = values.slice();
    if (value) next[editingIndex] = value;
    else next.splice(editingIndex, 1);
    onChange(dedupeTags(next));
    setEditingIndex(null);
    setEditingValue('');
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingValue('');
  };

  const removeTag = (index: number) => {
    onChange(values.filter((_, current) => current !== index));
    if (editingIndex === index) cancelEdit();
    else if (editingIndex !== null && index < editingIndex) setEditingIndex(editingIndex - 1);
  };

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditingValue(values[index] || '');
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
    } else if (event.key === 'Backspace' && !draft && values.length > 0) {
      removeTag(values.length - 1);
    }
  };

  const handleEditingKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="taxonomy-field">
      <label className="taxonomy-label" htmlFor={inputId}>{label}</label>
      <div className="tag-input" role="group" aria-label={ariaLabel}>
        <div className="tag-input-list">
          {values.map((value, index) => editingIndex === index ? (
            <input
              key={`${value}-${index}`}
              ref={editingInputRef}
              className="taxonomy-tag-edit"
              value={editingValue}
              aria-label={`编辑${label}`}
              onChange={event => setEditingValue(event.target.value)}
              onKeyDown={handleEditingKeyDown}
              onBlur={commitEdit}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            />
          ) : (
            <span
              key={`${value}-${index}`}
              className="taxonomy-tag"
              title="双击编辑"
              tabIndex={0}
              aria-label={`${label}${value}，按 Enter、F2 或空格编辑`}
              onDoubleClick={event => {
                if ((event.target as HTMLElement).closest('button')) return;
                startEditing(index);
              }}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' || event.key === 'F2' || event.key === ' ') {
                  event.preventDefault();
                  startEditing(index);
                }
              }}
            >
              <span className="taxonomy-tag-value">{prefix}{value}</span>
              <button type="button" className="taxonomy-tag-remove" aria-label={`删除${label}${value}`} onClick={() => removeTag(index)}>×</button>
            </span>
          ))}
          <input
            className="tag-input-editor"
            id={inputId}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={handleInputKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            placeholder={placeholder}
            aria-label={ariaLabel}
          />
        </div>
      </div>
    </div>
  );
}
