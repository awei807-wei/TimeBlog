import { LinkNode, type LinkAttributes, type SerializedLinkNode } from '@lexical/link';
import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from '@mdxeditor/editor';
import type { Link } from 'mdast';
import type { NodeKey } from 'lexical';

const MEDIA_LINK_URL = /^media:\/\/[A-Za-z0-9._~-]+$/;

/**
 * Media references are Markdown links whose URL is intentionally not one of
 * Lexical's standard web protocols. Keep the accepted shape deliberately
 * narrow so arbitrary custom schemes cannot bypass LinkNode's URL sanitizer.
 */
export function isMediaLinkUrl(url: string): boolean {
  return MEDIA_LINK_URL.test(url);
}

/**
 * A LinkNode variant that preserves safe `media://<id>` hrefs in the editor
 * DOM. Every other URL still goes through Lexical's default allowlist.
 */
export class MediaLinkNode extends LinkNode {
  static getType(): string {
    return 'media-link';
  }

  static clone(node: MediaLinkNode): MediaLinkNode {
    return new MediaLinkNode(node.__url, {
      rel: node.__rel,
      target: node.__target,
      title: node.__title,
    }, node.__key);
  }

  constructor(url = '', attributes: LinkAttributes = {}, key?: NodeKey) {
    super(url, attributes, key);
  }

  static importJSON(serializedNode: SerializedLinkNode): MediaLinkNode {
    return new MediaLinkNode().updateFromJSON(serializedNode);
  }

  sanitizeUrl(url: string): string {
    return isMediaLinkUrl(url) ? url : super.sanitizeUrl(url);
  }
}

const mediaLinkImportVisitor: MdastImportVisitor<Link> = {
  testNode: (mdastNode): mdastNode is Link => mdastNode.type === 'link' && isMediaLinkUrl(mdastNode.url),
  visitNode({ mdastNode, actions }) {
    actions.addAndStepInto(new MediaLinkNode(mdastNode.url, { title: mdastNode.title }));
  },
  priority: 100,
};

const mediaLinkExportVisitor: LexicalExportVisitor<MediaLinkNode, Link> = {
  testLexicalNode: (lexicalNode): lexicalNode is MediaLinkNode => lexicalNode instanceof MediaLinkNode,
  visitLexicalNode({ lexicalNode, actions }) {
    actions.addAndStepInto('link', {
      url: lexicalNode.getURL(),
      title: lexicalNode.getTitle(),
    });
  },
  priority: 100,
};

/** Registers media links without replacing MDXEditor's standard link plugin. */
export const mediaLinkPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addImportVisitor$]: mediaLinkImportVisitor,
      [addLexicalNode$]: MediaLinkNode,
      [addExportVisitor$]: mediaLinkExportVisitor,
    });
  },
});
