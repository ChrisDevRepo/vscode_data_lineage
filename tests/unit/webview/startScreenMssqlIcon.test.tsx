// @vitest-environment jsdom
/**
 * Pins the "! Old connection" badge on saved projects that still connect through the SQL Server (mssql)
 * extension: shown for provider-less and mssql-extension database projects, never for built-in or DACPAC ones.
 * A row shows the project details, with the migration advice, on focus or hover.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StartScreen } from '../../../src/components/StartScreen';
import { MSSQL_PROJECT_HINT } from '../../../src/components/mssqlRetiring';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const noop = () => {};
const database = (id: string, provider?: 'builtIn' | 'mssqlExtension') => ({
  id, name: id, updatedAt: '2026-09-01T00:00:00Z', filterProfiles: [],
  connection: {
    type: 'database', sourceName: 'srv / db', schemas: ['dbo'],
    connectionInfo: { server: 'srv', database: 'db', ...(provider ? { provider } : {}) },
  },
});
const dacpac = { id: 'dac', name: 'dac', updatedAt: '2026-09-01T00:00:00Z', filterProfiles: [], connection: { type: 'dacpac', path: '/tmp/x.dacpac', schemas: [] } };

function rowsWithIcon(): string[] {
  return Array.from(host.querySelectorAll(`[aria-label="${MSSQL_PROJECT_HINT}"]`))
    .map((icon) => icon.closest('.ln-list-item')?.querySelector('.font-medium')?.textContent ?? '');
}

describe('saved projects show the retiring mssql connection', () => {
  it('marks provider-less and mssql-extension database projects only', () => {
    const projects = [database('legacy'), database('viaMssql', 'mssqlExtension'), database('builtIn', 'builtIn'), dacpac];
    act(() => {
      root.render(
        <StartScreen projects={projects as never} lastOpenedId={null} initialShowProjects loadingProjectId={null} startMessage={null}
          onCreateNew={noop} onOpenProject={noop} onOpenLatest={noop} onDeleteProject={noop} onDeleteAllProjects={noop} onDemo={noop} />,
      );
    });
    expect(rowsWithIcon().sort()).toEqual(['legacy', 'viaMssql']);
    const badges = Array.from(host.querySelectorAll('.ln-provider-warning-badge')).map((badge) => badge.textContent);
    expect(badges).toEqual(['! Old connection', '! Old connection']);
  });

  it('focusing an old project row shows the migration advice', () => {
    act(() => {
      root.render(
        <StartScreen projects={[database('legacy')] as never} lastOpenedId={null} initialShowProjects loadingProjectId={null} startMessage={null}
          onCreateNew={noop} onOpenProject={noop} onOpenLatest={noop} onDeleteProject={noop} onDeleteAllProjects={noop} onDemo={noop} />,
      );
    });
    expect(document.querySelector('.ln-tooltip')).toBeNull();
    act(() => { host.querySelector<HTMLButtonElement>('.ln-list-item > button')!.focus(); });
    expect(document.querySelector('.ln-tooltip')?.textContent).toContain(MSSQL_PROJECT_HINT);
  });
});
