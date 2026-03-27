import { useEffect, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
// Core editor API only — avoids bundling ts/css/html/json language workers (~9MB)
// Same pattern as microsoft/vscode-cosmosdb
// eslint-disable-next-line import/no-internal-modules
import * as monacoEditor from 'monaco-editor/esm/vs/editor/editor.api';
// SQL tokenizer (basic language, no worker) — required for syntax highlighting.
// editor.api excludes all language contributions; this registers the SQL tokenizer only.
// eslint-disable-next-line import/no-internal-modules
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import type * as Monaco from 'monaco-editor';
import type { LineageNode } from '../engine/types';

loader.config({ monaco: monacoEditor });

// ─── Theme mapping ────────────────────────────────────────────────────────────

function getMonacoTheme(): string {
  const kind = document.body.getAttribute('data-vscode-theme-kind');
  if (kind === 'vscode-high-contrast') return 'hc-black';
  if (kind === 'vscode-high-contrast-light') return 'hc-light';
  if (kind === 'vscode-dark') return 'vs-dark';
  return 'vs';
}

// ─── Component ────────────────────────────────────────────────────────────────

interface MonacoSqlViewProps {
  node: LineageNode;
  findQuery?: string;
}

export function MonacoSqlView({ node, findQuery }: MonacoSqlViewProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const contentListenerRef = useRef<Monaco.IDisposable | null>(null);
  const [monacoTheme, setMonacoTheme] = useState(getMonacoTheme);

  // Sync Monaco theme when VS Code theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => setMonacoTheme(getMonacoTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
    return () => observer.disconnect();
  }, []);

  // Apply inline search highlights using decorations API
  function applyHighlights(ed: Monaco.editor.IStandaloneCodeEditor, query: string | undefined) {
    if (!decorationsRef.current) {
      decorationsRef.current = ed.createDecorationsCollection([]);
    }
    if (!query) {
      decorationsRef.current.set([]);
      return;
    }
    const model = ed.getModel();
    if (!model) return;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = model.findMatches(escaped, true, true, false, null, false);
    decorationsRef.current.set(
      matches.map(m => ({
        range: m.range,
        options: { inlineClassName: 'monaco-search-highlight' },
      }))
    );
    // Scroll to first match
    if (matches.length > 0) {
      ed.revealRangeInCenterIfOutsideViewport(matches[0].range);
    }
  }

  // When findQuery changes, apply highlights immediately if editor is ready
  useEffect(() => {
    if (editorRef.current) {
      applyHighlights(editorRef.current, findQuery);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery]);

  // Dispose decorations and content listener on unmount
  useEffect(() => {
    return () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      contentListenerRef.current?.dispose();
      contentListenerRef.current = null;
    };
  }, []);

  function handleEditorMount(ed: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = ed;
    // After model content settles (e.g. new node), re-apply highlights.
    contentListenerRef.current?.dispose();
    contentListenerRef.current = ed.onDidChangeModelContent(() => {
      applyHighlights(ed, findQuery);
    });
    // Apply immediately if query is already set
    applyHighlights(ed, findQuery);
  }

  const sql = node.bodyScript ?? `-- No SQL body available for ${node.fullName}`;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ln-bg)' }}>
      {/* Header */}
      <div
        style={{
          padding: '6px 12px',
          background: 'var(--ln-sidebar-header-bg)',
          borderBottom: '1px solid var(--ln-border)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ln-fg)',
          flexShrink: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {node.fullName}
        <span style={{ fontWeight: 400, color: 'var(--ln-fg-muted)', marginLeft: 8 }}>
          {node.type.toUpperCase()}
        </span>
      </div>

      {/* Monaco Editor */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          language="sql"
          value={sql}
          theme={monacoTheme}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            automaticLayout: true,
            fontSize: 13,
            lineNumbers: 'on',
            renderLineHighlight: 'all',
            folding: true,
          }}
          onMount={handleEditorMount}
        />
      </div>
    </div>
  );
}
