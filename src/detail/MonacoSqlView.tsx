import { useEffect, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
// Core editor API only — avoids bundling ts/css/html/json language workers (~9MB)
// Same pattern as microsoft/vscode-cosmosdb
// eslint-disable-next-line import/no-internal-modules
import * as monacoEditor from 'monaco-editor/esm/vs/editor/editor.api';
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
  const pendingFindRef = useRef<string | undefined>(undefined);
  const [monacoTheme, setMonacoTheme] = useState(getMonacoTheme);

  // Sync Monaco theme when VS Code theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => setMonacoTheme(getMonacoTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
    return () => observer.disconnect();
  }, []);

  // When findQuery changes, store pending; trigger immediately if editor is ready
  useEffect(() => {
    pendingFindRef.current = findQuery;
    if (editorRef.current && findQuery) {
      triggerFind(editorRef.current, findQuery);
    }
  }, [findQuery]);

  function triggerFind(ed: Monaco.editor.IStandaloneCodeEditor, query: string) {
    requestAnimationFrame(() => {
      ed.trigger('source', 'editor.action.startFindWithArgs', {
        searchString: query,
        isRegex: false,
        isCaseSensitive: false,
        matchWholeWord: false,
      });
    });
  }

  function handleEditorMount(ed: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = ed;
    // After model content settles (e.g. new node), apply any pending find
    ed.onDidChangeModelContent(() => {
      if (pendingFindRef.current) {
        triggerFind(ed, pendingFindRef.current);
      }
    });
    // Apply immediately if query is already set
    if (pendingFindRef.current) {
      triggerFind(ed, pendingFindRef.current);
    }
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
