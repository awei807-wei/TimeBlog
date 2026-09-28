'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';

type TagInputProps = {
  label: string;
  values: string[];
  suggestions?: string[];
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
export default function TagInput({ label, values, suggestions = [], onChange, placeholder, ariaLabel, prefix = '' }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const composingRef = useRef(false);
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputId = useId();
  const suggestionListId = `${inputId}-suggestions`;

  useEffect(() => {
    if (editingIndex !== null) editingInputRef.current?.focus();
  }, [editingIndex]);

  useEffect(() => () => {
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

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

  const selectedKeys = new Set(values.map(value => cleanTag(value, prefix).toLocaleLowerCase()));
  const suggestionValues = dedupeTags(suggestions.map(value => cleanTag(value, prefix)))
    .filter(value => !selectedKeys.has(value.toLocaleLowerCase()));
  const filteredSuggestions = suggestionValues.filter(value => {
    const query = cleanTag(draft, prefix).toLocaleLowerCase();
    return !query || value.toLocaleLowerCase().includes(query);
  }).slice(0, 12);

  const commitSuggestion = (suggestion: string) => {
    const value = cleanTag(suggestion, prefix);
    if (!value) return;
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    onChange(dedupeTags([...values, value]));
    setDraft('');
    setSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
    inputRef.current?.focus();
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

  const isComposingKey = (event: React.KeyboardEvent<HTMLElement>) => (
    event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229
  );

  const isEnterKey = (event: React.KeyboardEvent<HTMLElement>) => event.key === 'Enter' || event.keyCode === 13;

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape' && suggestionsOpen) {
      event.preventDefault();
      setSuggestionsOpen(false);
      setActiveSuggestionIndex(-1);
      return;
    }
    if (event.key === 'ArrowDown' && filteredSuggestions.length > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestionIndex(index => index < filteredSuggestions.length - 1 ? index + 1 : 0);
      return;
    }
    if (event.key === 'ArrowUp' && filteredSuggestions.length > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestionIndex(index => index <= 0 ? filteredSuggestions.length - 1 : index - 1);
      return;
    }
    if (isEnterKey(event) && suggestionsOpen && activeSuggestionIndex >= 0 && filteredSuggestions[activeSuggestionIndex]) {
      event.preventDefault();
      event.stopPropagation();
      commitSuggestion(filteredSuggestions[activeSuggestionIndex]);
      return;
    }
    if (event.key === 'Backspace' && !draft && values.length > 0) {
      removeTag(values.length - 1);
    }
  };

  const handleEditingKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  };

  const handleTagInputKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (!isEnterKey(event) || isComposingKey(event)) return;
    const target = event.target as HTMLInputElement;
    if (target?.tagName !== 'INPUT') return;
    if (target.classList.contains('taxonomy-tag-edit')) {
      event.preventDefault();
      event.stopPropagation();
      commitEdit();
    } else if (target.classList.contains('tag-input-editor')) {
      event.preventDefault();
      event.stopPropagation();
      commitDraft();
    }
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
  };

  const openSuggestions = () => {
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setSuggestionsOpen(true);
    setActiveSuggestionIndex(-1);
  };

  const closeSuggestionsSoon = () => {
    if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      setSuggestionsOpen(false);
      setActiveSuggestionIndex(-1);
      blurTimerRef.current = null;
    }, 0);
  };

  return (
    <div className="taxonomy-field">
      <label className="taxonomy-label" htmlFor={inputId}>{label}</label>
      <div className="tag-input" role="group" aria-label={ariaLabel} onKeyDown={handleTagInputKeyDown}>
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
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              enterKeyHint="done"
            />
          ) : (
            <span
              key={`${value}-${index}`}
              className="taxonomy-tag"
              title={`${prefix}${value} · 双击编辑`}
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
              <button type="button" className="taxonomy-tag-remove" aria-label={`删除${label}${value}`} onClick={() => removeTag(index)}><X aria-hidden="true" /></button>
            </span>
          ))}
          <input
            ref={inputRef}
            className="tag-input-editor"
            id={inputId}
            value={draft}
            onChange={event => {
              setDraft(event.target.value);
              setSuggestionsOpen(true);
              setActiveSuggestionIndex(-1);
            }}
            onKeyDown={handleInputKeyDown}
            onFocus={openSuggestions}
            onBlur={closeSuggestionsSoon}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder={placeholder}
            aria-label={ariaLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={suggestionsOpen && filteredSuggestions.length > 0 ? suggestionListId : undefined}
            aria-expanded={suggestionsOpen && filteredSuggestions.length > 0}
            aria-activedescendant={suggestionsOpen && activeSuggestionIndex >= 0 ? `${suggestionListId}-${activeSuggestionIndex}` : undefined}
            enterKeyHint="done"
          />
        </div>
        {suggestionsOpen && filteredSuggestions.length > 0 && (
          <div id={suggestionListId} className="taxonomy-suggestions" role="listbox" aria-label={`${label}历史值`}>
            {filteredSuggestions.map((suggestion, index) => (
              <button
                key={suggestion}
                type="button"
                role="option"
                id={`${suggestionListId}-${index}`}
                aria-selected={index === activeSuggestionIndex}
                className={`taxonomy-suggestion${index === activeSuggestionIndex ? ' is-active' : ''}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => commitSuggestion(suggestion)}
              >
                {prefix}{suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
