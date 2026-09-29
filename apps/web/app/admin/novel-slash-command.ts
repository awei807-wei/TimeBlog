import { Command, type SuggestionItem } from 'novel';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import tippy, { type Instance } from 'tippy.js';
import { NovelEditorSlashMenu, type NovelSlashMenuProps } from './NovelEditorMenus';

const MENU_KEYS = new Set(['Enter', 'ArrowUp', 'ArrowDown', 'Escape']);

function isComposing(view: EditorView, event: KeyboardEvent) {
  return view.composing || event.isComposing || event.keyCode === 229;
}

/** Novel 1.0.2's renderItems uses a document listener, a global #slash-command
 * and shared query/range atoms. Reuse its Command extension and cmdk UI, but
 * keep the renderer, suggestion range and keyboard routing inside each editor. */
export function createNovelSlashCommand(editorPortalElement?: Element | null) {
  return Command.extend({
    priority: 1000,
    addProseMirrorPlugins() {
      const editor = this.editor;
      const pluginKey = new PluginKey('timeblog-slash-command');
      let renderer: ReactRenderer<unknown, NovelSlashMenuProps> | null = null;
      let popup: Instance | null = null;
      let dismissed = false;
      let destroyed = false;

      const active = (view: EditorView) => !destroyed && !dismissed && editor.isEditable
        && Boolean(pluginKey.getState(view.state)?.active);
      const destroyMenu = () => {
        popup?.destroy();
        popup = null;
        renderer?.destroy();
        renderer = null;
      };
      const dismiss = () => {
        dismissed = true;
        destroyMenu();
      };
      const menuProps = (props: SuggestionProps<SuggestionItem>): NovelSlashMenuProps => ({
        items: props.items,
        query: props.query,
        onDismiss: dismiss,
        isComposing: () => editor.view.composing,
        onCommand: item => {
          const state = pluginKey.getState(editor.state);
          if (!active(editor.view) || state.query !== props.query) return;
          // Read the live range, never Novel's shared range atom or an old render.
          const range = { ...state.range };
          dismiss();
          item.command?.({ editor, range });
        },
      });
      const handleKeyDown = (view: EditorView, event: KeyboardEvent) => {
        if (!active(view) || !MENU_KEYS.has(event.key)) return false;
        event.stopPropagation();
        if (isComposing(view, event)) return true;
        event.preventDefault();
        if (event.key === 'Escape') {
          dismiss();
          return true;
        }
        const menu = renderer?.element.querySelector<HTMLElement>('[cmdk-root]');
        // Consume even when empty or awaiting a React commit: never split the doc
        // or execute an item rendered for the previous query.
        if (menu && menu.dataset.query === pluginKey.getState(view.state)?.query) {
          const KeyboardEvent = view.dom.ownerDocument.defaultView?.KeyboardEvent;
          if (KeyboardEvent) menu.dispatchEvent(new KeyboardEvent('keydown', {
            key: event.key, code: event.code, bubbles: true, cancelable: true,
            shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          }));
        }
        return true;
      };

      return [
        new Plugin({
          props: {
            handleDOMEvents: {
              keydown(view, event) {
                if (!active(view) || (!MENU_KEYS.has(event.key) && event.keyCode !== 229)) return false;
                event.stopPropagation();
                // Do not preventDefault: the IME must still confirm/cancel its text.
                // Non-IME keys go through PM's own near-composition guard first.
                return isComposing(view, event);
              },
              blur(_view, event) {
                if (!renderer?.element.contains(event.relatedTarget as Node | null)) dismiss();
                return false;
              },
            },
          },
          view(view) {
            const window = view.dom.ownerDocument.defaultView;
            const escape = (event: KeyboardEvent) => {
              if (event.key !== 'Escape' || !active(view)) return;
              const target = event.target as Node | null;
              if (target && (view.dom.contains(target) || renderer?.element.contains(target))) {
                // Radix Dialog listens on document capture; editor bubbling is too late.
                // Only this editor's active menu owns Escape, including in a Portal.
                handleKeyDown(view, event);
              }
            };
            window?.addEventListener('keydown', escape, true);
            return { destroy() {
              destroyed = true;
              window?.removeEventListener('keydown', escape, true);
              destroyMenu();
            } };
          },
        }),
        Suggestion<SuggestionItem>({
          ...this.options.suggestion,
          editor,
          pluginKey,
          allow: ({ state }) => !state.selection.$from.parent.type.spec.code,
          render: () => ({
            onBeforeStart: () => { dismissed = false; },
            onStart(props) {
              if (!active(editor.view) || !props.clientRect) return;
              // Suggestion awaits items: rapid exit/re-entry can finish two starts
              // for the same live query. Never leave an orphan renderer/listener.
              destroyMenu();
              renderer = new ReactRenderer(NovelEditorSlashMenu, { editor, props: menuProps(props) });
              popup = tippy(editor.view.dom, {
                getReferenceClientRect: () => props.clientRect?.() || editor.view.dom.getBoundingClientRect(),
                appendTo: () => editorPortalElement || editor.view.dom.ownerDocument.body,
                content: renderer.element, showOnCreate: true, interactive: true,
                trigger: 'manual', placement: 'bottom-start',
              });
            },
            onUpdate(props) {
              if (!active(editor.view)) return;
              renderer?.updateProps(menuProps(props));
              popup?.setProps({ getReferenceClientRect: () => props.clientRect?.() || editor.view.dom.getBoundingClientRect() });
            },
            onKeyDown: ({ view, event }) => handleKeyDown(view, event),
            onExit: destroyMenu,
          }),
        }),
      ];
    },
  });
}
