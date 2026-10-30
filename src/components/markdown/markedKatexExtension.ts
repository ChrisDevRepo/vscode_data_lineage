/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  Vendored from microsoft/vscode:
 *    src/vs/workbench/contrib/markdown/common/markedKatexExtension.ts
 *  which is itself derived from https://github.com/UziTech/marked-katex-extension (MIT).
 *
 *  Modifications: namespace flattened to module exports, VS Code-internal imports replaced
 *  with `marked`/`katex`, local HTML-attribute encoding, and contextual inline boundaries.
 *  See THIRD_PARTY_NOTICES.md.
 *--------------------------------------------------------------------------------------------*/
import type { KatexOptions } from 'katex';
import type katex from 'katex';
import type {
  MarkedExtension,
  RendererExtensionFunction,
  Token,
  Tokens,
  TokenizerAndRendererExtension,
} from 'marked';

/** Matches inline math delimited by one or two dollars. */
const mathInlineRegExp =
  /(?<![a-zA-Z0-9])(?<dollars>\${1,2})(?!\.|\(["'])((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\k<dollars>(?![a-zA-Z0-9])/;

const katexContainerClassName = 'vscode-katex-container';
const katexContainerLatexAttributeName = 'data-latex';

const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

type MarkedKatexOptions = KatexOptions;

function htmlAttributeEncodeValue(value: string): string {
  return value.replace(/[<>"'&]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      case '&':
        return '&amp;';
      default:
        return ch;
    }
  });
}

function createRenderer(
  katexInstance: typeof katex,
  options: MarkedKatexOptions,
  isBlock: boolean,
): RendererExtensionFunction {
  return (token: Tokens.Generic) => {
    let out: string;
    try {
      const html = katexInstance.renderToString(token.text, {
        ...options,
        throwOnError: true,
        displayMode: token.displayMode,
      });

      out = `<span class="${katexContainerClassName}" ${katexContainerLatexAttributeName}="${htmlAttributeEncodeValue(token.text)}">${html}</span>`;
    } catch {
      out = htmlAttributeEncodeValue(token.raw);
    }
    return out + (isBlock ? '\n' : '');
  };
}

function inlineKatex(
  renderer: RendererExtensionFunction,
): TokenizerAndRendererExtension {
  return {
    name: 'inlineKatex',
    level: 'inline',
    start(src: string) {
      return mathInlineRegExp.exec(src)?.index;
    },
    tokenizer(src: string, tokens: Token[]) {
      // Marked supplies the unconsumed suffix; restore its preceding raw character for the existing lookbehind.
      const prefix = tokens.at(-1)?.raw.slice(-1) ?? '';
      const match = mathInlineRegExp.exec(prefix + src);
      if (match && match.index === prefix.length) {
        return {
          type: 'inlineKatex',
          raw: match[0],
          text: match[2].trim(),
          displayMode: match[1].length === 2,
        };
      }
      return;
    },
    renderer,
  };
}

function blockKatex(
  renderer: RendererExtensionFunction,
): TokenizerAndRendererExtension {
  return {
    name: 'blockKatex',
    level: 'block',
    start(src: string) {
      return src.match(new RegExp(blockRule.source, 'm'))?.index;
    },
    tokenizer(src: string, _tokens: Token[]) {
      const match = src.match(blockRule);
      if (match) {
        return {
          type: 'blockKatex',
          raw: match[0],
          text: match[2].trim(),
          displayMode: match[1].length === 2,
        };
      }
      return;
    },
    renderer,
  };
}

/** Builds the `marked` extension that renders `$…$` and `$$…$$` math through KaTeX. */
export function markedKatexExtension(
  katexInstance: typeof katex,
  options: MarkedKatexOptions = {},
): MarkedExtension {
  return {
    extensions: [
      inlineKatex(createRenderer(katexInstance, options, false)),
      blockKatex(createRenderer(katexInstance, options, true)),
    ],
  };
}
