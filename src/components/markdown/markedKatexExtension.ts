/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  Vendored from microsoft/vscode:
 *    src/vs/workbench/contrib/markdown/common/markedKatexExtension.ts
 *  which is itself derived from https://github.com/UziTech/marked-katex-extension (MIT).
 *
 *  Modifications: namespace flattened to module exports, VS Code-internal imports replaced
 *  with the `marked`/`katex` packages and a local `htmlAttributeEncodeValue`.
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

/**
 * Matches inline math delimited by one or two dollars.
 *
 * @remarks
 * Non-standard, but ensures the opening `$` is not preceded and the closing `$` is not followed
 * by a word/number character, and the opening `$` is not followed by `.`, `("`, or `('`. That is
 * what keeps prose amounts such as `$20,000 and $30,000` from parsing as math while a genuine
 * `$\rightarrow$` still does.
 */
const mathInlineRegExp =
  /(?<![a-zA-Z0-9])(?<dollars>\${1,2})(?!\.|\(["'])((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\k<dollars>(?![a-zA-Z0-9])/;

const katexContainerClassName = 'vscode-katex-container';
const katexContainerLatexAttributeName = 'data-latex';

const inlineRule = new RegExp('^' + mathInlineRegExp.source);
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

interface MarkedKatexOptions extends KatexOptions { }

function htmlAttributeEncodeValue(value: string): string {
  return value.replace(/[<>"'&]/g, ch => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&apos;';
      case '&': return '&amp;';
      default: return ch;
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

      // Container attribute keeps the original LaTeX retrievable even without the annotation element.
      out = `<span class="${katexContainerClassName}" ${katexContainerLatexAttributeName}="${htmlAttributeEncodeValue(token.text)}">${html}</span>`;
    } catch {
      // On failure, degrade to the original source including the wrapping $ or $$. Text-escaped:
      // the raw markdown is emitted into an HTML stream, so `<` in `$a < b$` must survive as `<`.
      out = htmlAttributeEncodeValue(token.raw);
    }
    return out + (isBlock ? '\n' : '');
  };
}

function inlineKatex(renderer: RendererExtensionFunction): TokenizerAndRendererExtension {
  const ruleReg = inlineRule;
  return {
    name: 'inlineKatex',
    level: 'inline',
    start(src: string) {
      let index;
      let indexSrc = src;

      while (indexSrc) {
        index = indexSrc.indexOf('$');
        if (index === -1) {
          return;
        }

        const possibleKatex = indexSrc.substring(index);
        if (possibleKatex.match(ruleReg)) {
          return index;
        }

        indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, '');
      }
      return;
    },
    tokenizer(src: string, _tokens: Token[]) {
      const match = src.match(ruleReg);
      if (match) {
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

function blockKatex(renderer: RendererExtensionFunction): TokenizerAndRendererExtension {
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

/**
 * Builds the `marked` extension that renders `$…$` and `$$…$$` math through KaTeX.
 *
 * @param katexInstance - The KaTeX module used to render each expression.
 * @param options - KaTeX options applied to every expression.
 * @returns The extension to pass to `marked.use()`.
 */
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
