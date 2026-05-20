import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { AiDescriptionOverlay } from '../../../src/components/AiDescriptionOverlay';

afterEach(cleanup);

describe('AiDescriptionOverlay', () => {
  it('maximizes and restores without breaking KaTeX rendering', () => {
    render(
      <AiDescriptionOverlay
        viewName="AI Trace"
        description={'Revenue formula:\n\n$$\\text{TotalRevenue}=\\text{Qty}\\times\\text{UnitPrice}$$'}
        defaultExpanded
      />,
    );

    expect(document.querySelector('.katex')).not.toBeNull();
    expect(document.querySelector('.ln-ai-description-overlay-maximized')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Maximize description' }));

    expect(document.querySelector('.ln-ai-description-anchor-maximized')).not.toBeNull();
    expect(document.querySelector('.ln-ai-description-overlay-maximized')).not.toBeNull();
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Restore original description size' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore original description size' }));

    expect(document.querySelector('.ln-ai-description-anchor-maximized')).toBeNull();
    expect(document.querySelector('.ln-ai-description-overlay-maximized')).toBeNull();
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('increases description font scale without switching markdown modes', () => {
    render(
      <AiDescriptionOverlay
        viewName="AI Trace"
        description={'Fallback uses $0$ when no price exists.'}
        defaultExpanded
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Increase description text size' }));

    expect(document.querySelector('.ln-ai-description-font-1')).not.toBeNull();
    expect(document.querySelector('.katex')).not.toBeNull();
  });
});
