# Third-Party Notices

This project incorporates material from the projects listed below. The original
copyright notices and licenses under which that material was received are set out
in full.

---

## Visual Studio Code

- **Source**: https://github.com/microsoft/vscode
- **File**: `src/vs/workbench/contrib/markdown/common/markedKatexExtension.ts`
- **Destination**: `src/components/markdown/markedKatexExtension.ts`
- **License**: MIT

Itself derived from [marked-katex-extension](https://github.com/UziTech/marked-katex-extension) (MIT).

**Why**: this is the extension VS Code applies to chat responses. Vendoring it makes the
AI description overlay render math identically to the chat panel, using the same
delimiter rules rather than a reimplementation.

**Modifications**:
- The `MarkedKatexExtension` namespace was flattened to module exports, and the exported
  factory renamed from `extension` to `markedKatexExtension`.
- VS Code-internal imports (`base/common/marked/marked.js`, `base/common/strings.js`) were
  replaced with the `marked` and `katex` packages plus a local `htmlAttributeEncodeValue`.
- Unused `options` parameters were dropped from the two tokenizer factories.

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
