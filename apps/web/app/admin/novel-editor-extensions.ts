import { mediaContentUrl } from '@/lib/media-resolver';
import { API } from '@/lib/api';
import { isSafeMediaReference } from './markdown-compat';
import {
  Command,
  Placeholder,
  StarterKit,
  TaskItem,
  TaskList,
  TiptapImage,
  TiptapLink,
  createSuggestionItems,
  renderItems,
  type SuggestionItem,
} from 'novel';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { isAllowedUri as isTiptapAllowedUri } from '@tiptap/extension-link';
import { Markdown, type MarkdownNodeSpec } from 'tiptap-markdown';

/** Keep media:// as the persisted image source while showing an authenticated URL in the DOM. */
export const MediaImage = TiptapImage.extend({
  name: 'image',
  addStorage() {
    return {
      markdown: {
        serialize(state: Parameters<MarkdownNodeSpec['serialize']>[0], node: Parameters<MarkdownNodeSpec['serialize']>[1]) {
          const alt = state.esc(String(node.attrs.alt || ''));
          const source = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
          const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
          state.write(`![${alt}](${source}${title})`);
          // Tiptap Image is a block node by default, while prosemirror-markdown's
          // stock serializer assumes an inline image and omits the block break.
          if (node.isBlock) state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const source = String(HTMLAttributes.src || '');
    const attributes: Record<string, string> = {
      src: source,
      ...(HTMLAttributes.alt !== null && HTMLAttributes.alt !== undefined ? { alt: String(HTMLAttributes.alt) } : {}),
      ...(HTMLAttributes.title ? { title: String(HTMLAttributes.title) } : {}),
    };
    if (isSafeMediaReference(source)) {
      attributes['data-media-source'] = source;
      attributes.src = mediaContentUrl(source.slice('media://'.length), API);
    } else if (source.startsWith('media://')) {
      attributes['data-media-invalid'] = 'true';
      attributes.src = '#';
    }
    return ['img', attributes];
  },
});

/** Render safe media links as authenticated downloads without mutating their Markdown attrs. */
export const MediaLink = TiptapLink.extend({
  name: 'link',
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: element => element.getAttribute('title'),
        renderHTML: attributes => attributes.title ? { title: String(attributes.title) } : {},
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const source = String(HTMLAttributes.href || '');
    const allowed = this.options.isAllowedUri(source, {
      defaultValidate: href => Boolean(isTiptapAllowedUri(href, this.options.protocols)),
      protocols: this.options.protocols,
      defaultProtocol: this.options.defaultProtocol,
    });
    const attributes: Record<string, string> = {
      href: allowed ? source : '',
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
      ...(HTMLAttributes.title ? { title: String(HTMLAttributes.title) } : {}),
    };
    if (isSafeMediaReference(source)) {
      attributes['data-media-source'] = source;
      attributes.href = mediaContentUrl(source.slice('media://'.length), API);
    } else if (source.startsWith('media://')) {
      attributes['data-media-invalid'] = 'true';
      attributes.href = '#';
    }
    return ['a', attributes, 0];
  },
});

export type NovelExtensionOptions = {
  editorPortalElement?: Element | null;
  suggestions: SuggestionItem[];
};

/**
 * Build the editor extensions once per stable suggestion/portal configuration.
 * Keeping this list in one module prevents business hooks from depending on
 * Tiptap types and makes the editor's supported Markdown surface explicit.
 */
export function createNovelExtensions({ editorPortalElement, suggestions }: NovelExtensionOptions): any[] {
  const slashCommand = Command.configure({
    suggestion: {
      char: '/',
      items: () => createSuggestionItems(suggestions),
      render: () => renderItems(editorPortalElement ? { current: editorPortalElement } : null),
    },
  });

  return [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    MediaImage.configure({ allowBase64: false }),
    MediaLink.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      protocols: ['media'],
      isAllowedUri: (url, context) => url.startsWith('media:')
        ? isSafeMediaReference(url)
        : context.defaultValidate(url),
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({
      html: false,
      tightLists: true,
      bulletListMarker: '-',
      linkify: false,
      breaks: false,
      transformPastedText: false,
      transformCopiedText: false,
    }),
    Placeholder.configure({ placeholder: '从一句话开始。使用工具栏排版，输入 / 打开更多格式。', includeChildren: true }),
    slashCommand,
  ];
}

export const createNovelEditorExtensions = createNovelExtensions;
