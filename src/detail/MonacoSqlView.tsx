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

/** 
 * Configure the @monaco-editor/react loader to use our lightweight ESM bundle.
 * This prevents the extension from bundling massive language workers (TS/HTML/JSON)
 * while still providing robust SQL syntax highlighting.
 */
loader.config({ monaco: monacoEditor });

/**
 * Maps the current VS Code theme kind to a corresponding Monaco Editor theme.
 * 
 * @returns 'vs', 'vs-dark', 'hc-black', or 'hc-light'.
 */
function getMonacoTheme(): string {
  const kind = document.body.getAttribute('data-vscode-theme-kind');
  if (kind === 'vscode-high-contrast') return 'hc-black';
  if (kind === 'vscode-high-contrast-light') return 'hc-light';
  if (kind === 'vscode-dark') return 'vs-dark';
  return 'vs';
}

/**
 * Props for the `MonacoSqlView` component.
 */
interface MonacoSqlViewProps {
  /** The SQL lineage node containing the DDL script to display. */
  node: LineageNode;
  /** An optional search query for highlighting specific terms within the script. */
  findQuery?: string;
}

/**
 * A read-only SQL editor component powered by Monaco.
 * 
 * This component provides:
 * - High-fidelity SQL syntax highlighting.
 * - Dynamic theme synchronization with VS Code.
 * - Automatic search term highlighting using the Monaco Decorations API.
 * - Automatic scrolling to the first match when a search query is provided.
 * 
 * @param props - Component properties.
 * @returns A containerized Monaco editor for SQL DDL viewing.
 */
export function MonacoSqlView({ node, findQuery }: MonacoSqlViewProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const contentListenerRef = useRef<Monaco.IDisposable | null>(null);
  const [monacoTheme, setMonacoTheme] = useState(getMonacoTheme);

  // Synchronize Monaco theme whenever the VS Code environment triggers a theme change.
  useEffect(() => {
    const observer = new MutationObserver(() => setMonacoTheme(getMonacoTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
    return () => observer.disconnect();
  }, []);

  /**
   * Applies inline highlights to the editor based on the provided search query.
   * 
   * @param ed - The active Monaco editor instance.
   * @param query - The search term to highlight.
   */
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
    // Automatically scroll the first match into the center of the viewport.
    if (matches.length > 0) {
      ed.revealRangeInCenterIfOutsideViewport(matches[0].range);
    }
  }

  // Reactive effect to re-apply highlights whenever the findQuery prop changes.
  useEffect(() => {
    if (editorRef.current) {
      applyHighlights(editorRef.current, findQuery);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery]);

  // Ensure decorations and listeners are correctly disposed of when the component unmounts.
  useEffect(() => {
    return () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      contentListenerRef.current?.dispose();
      contentListenerRef.current = null;
    };
  }, []);

  /** 
   * Callback invoked when the Monaco editor instance has mounted successfully.
   */
  function handleEditorMount(ed: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = ed;
    // Monitor model content changes to ensure highlights are persistent.
    contentListenerRef.current?.dispose();
    contentListenerRef.current = ed.onDidChangeModelContent(() => {
      applyHighlights(ed, findQuery);
    });
    // Apply initial highlights immediately if a query is already provided.
    applyHighlights(ed, findQuery);
  }

  const sql = node.bodyScript ?? `-- No SQL body available for ${node.fullName}`;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ln-bg)' }}>
      {/* Detail Header showing qualified name and object type */}
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

      {/* Primary Editor Surface */}
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
