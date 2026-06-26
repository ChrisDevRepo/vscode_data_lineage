import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useKeyboardShortcut } from '../../../src/hooks/useKeyboardShortcut';
import { APP_LEVEL_SHORTCUTS, CONTEXTUAL_SHORTCUTS, SHORTCUT_KEYS } from '../../../src/ui/keyboardShortcuts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..', '..', '..');

describe('keyboard shortcut registry', () => {
  it('documents every app-level shortcut currently registered in code', () => {
    expect(APP_LEVEL_SHORTCUTS.map(shortcut => shortcut.id)).toEqual([
      'quickJump',
      'fitView',
      'openHelp',
      'excludeHighlightedNode',
      'exitMode',
      'toggleSchemaView',
      'hideExpandedSchemaClusters',
    ]);
    expect(SHORTCUT_KEYS.quickJump).toBe('/');
    expect(SHORTCUT_KEYS.fitView).toBe('f');
    expect(SHORTCUT_KEYS.openHelp).toBe('?');
    expect(SHORTCUT_KEYS.excludeHighlightedNode).toBe('Delete');
    expect(SHORTCUT_KEYS.exitMode).toBe('Escape');
    expect(SHORTCUT_KEYS.toggleSchemaView).toBe('s');
    expect(SHORTCUT_KEYS.hideExpandedSchemaClusters).toBe('h');
  });

  it('keeps user docs aligned with the shortcut registry', () => {
    const docs = readFileSync(resolve(root, 'docs', 'FEATURES.md'), 'utf8');
    for (const shortcut of [...APP_LEVEL_SHORTCUTS, ...CONTEXTUAL_SHORTCUTS]) {
      for (const key of shortcut.keys) {
        expect(docs).toContain(`<kbd>${key}</kbd>`);
      }
      expect(docs).toContain(shortcut.label);
    }
    expect(docs).not.toContain('<kbd>Del</kbd>');
  });

  it('keeps registered app-level shortcuts wired through the canonical constants', () => {
    const graphCanvas = readFileSync(resolve(root, 'src', 'components', 'GraphCanvas.tsx'), 'utf8');
    const search = readFileSync(resolve(root, 'src', 'components', 'SearchWithAutocomplete.tsx'), 'utf8');
    const toolbar = readFileSync(resolve(root, 'src', 'components', 'Toolbar.tsx'), 'utf8');
    const app = readFileSync(resolve(root, 'src', 'components', 'App.tsx'), 'utf8');
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

    expect(graphCanvas).toContain('useKeyboardShortcut(SHORTCUT_KEYS.fitView');
    expect(search).toContain('useKeyboardShortcut(SHORTCUT_KEYS.quickJump');
    expect(toolbar).toContain('useKeyboardShortcut(SHORTCUT_KEYS.openHelp');
    expect(app).toContain('useKeyboardShortcut(SHORTCUT_KEYS.excludeHighlightedNode');
    expect(app).toContain('useKeyboardShortcut(SHORTCUT_KEYS.exitMode');
    expect(packageJson.contributes.keybindings).toEqual([]);
  });

  it('fires explicit Fit View shortcut from the shared registry', () => {
    const onFit = vi.fn();
    renderHook(() => useKeyboardShortcut(SHORTCUT_KEYS.fitView, onFit));

    fireEvent.keyDown(document, { key: 'F' });
    fireEvent.keyDown(document, { key: 'f' });

    expect(onFit).toHaveBeenCalledTimes(2);
  });

  it('ignores bare-key shortcuts while typing in a text input', () => {
    const onFit = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useKeyboardShortcut(SHORTCUT_KEYS.fitView, onFit));

    fireEvent.keyDown(input, { key: 'F' });

    expect(onFit).not.toHaveBeenCalled();
    input.remove();
  });
});
