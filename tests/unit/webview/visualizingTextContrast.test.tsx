// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { VisualizingScreen } from '../../../src/components/VisualizingScreen';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Installed Modern theme description colors; wizard tokens come from the owning stylesheet.
const css = readFileSync('src/index.css', 'utf8');
const wizardMuted = css.match(/--ln-wizard-fg-muted:\s*([^;]+)/)![1];
function contrastOnBlack(color: string): number {
  const rgba = color.match(/rgba\(([^)]+)\)/)?.[1].split(',').map(Number);
  const channels = rgba
    ? rgba.slice(0, 3).map(channel => channel * rgba[3] / 255)
    : color.replace('#', '').match(/../g)!.map(hex => parseInt(hex, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05) / 0.05;
}
const cases = [
  { theme: 'Dark Modern', muted: '#9d9d9d', phase: 'load' },
  { theme: 'Dark Modern', muted: '#9d9d9d', phase: 'generate' },
  { theme: 'Light Modern', muted: '#3b3b3b', phase: 'load' },
  { theme: 'Light Modern', muted: '#3b3b3b', phase: 'generate' },
] as const;

describe('VisualizingScreen readable progress information', () => {
  it.each(cases)('keeps $phase-phase information at AA contrast in $theme', ({ phase, muted }) => {
    const themeColors: Record<string, string> = { '--ln-fg-muted': muted, '--ln-wizard-fg-muted': wizardMuted };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<VisualizingScreen sourceName="Demo" phase={phase} progressText={null} stats="148 nodes · 170 edges · 8 schemas" error={null} onCancel={() => {}} onBack={() => {}} />));
      const texts = phase === 'load' ? ['Reading file…', 'Parse', 'Generate'] : ['148 nodes · 170 edges · 8 schemas', 'Calculating layout…'];
      for (const text of texts) {
        const element = [...host.querySelectorAll<HTMLElement>('span,div')].find(node => node.childElementCount === 0 && node.textContent === text);
        expect(element, `visible progress text ${text}`).toBeDefined();
        const variable = element!.style.color.match(/var\(([^,)]+)/)?.[1];
        expect(variable && themeColors[variable], `theme color for ${text}`).toBeDefined();
        expect(contrastOnBlack(themeColors[variable!]), `${text} contrast`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
