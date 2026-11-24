import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions,
} from '@floating-ui/react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/** One control of the toolbar that moves into the "…" menu when the bar is too narrow for it. */
export interface ToolbarItem {
  key: string;
  node: ReactNode;
  /** A divider stands before the control while it is in the bar. */
  divider?: boolean;
  className?: string;
}

/** Width of the "…" button before it has been measured. */
const MORE_BUTTON_WIDTH = 36;

/**
 * How many leading items stay in a bar `available` px wide. Each item is `gap` px away from the
 * one before; when not every item fits, the "…" button (`reserve` px) takes the last place. @internal
 */
export function fitItems(widths: readonly number[], available: number, gap: number, reserve: number): number {
  const all = widths.reduce((sum, width) => sum + gap + width, 0);
  if (all <= available) return widths.length;
  let used = gap + reserve;
  let count = 0;
  for (const width of widths) {
    if (used + gap + width > available) break;
    used += gap + width;
    count += 1;
  }
  return count;
}

/**
 * Splits `items` into those that fit in the bar and those that go into the "…" menu, as VS Code's
 * toolbars do. The bar holds fixed parts (`data-bar-fixed`, a search box counts for its
 * `data-bar-min` width) and the items (`data-bar-item`); an item's width is read while it is in the
 * bar and remembered while it is in the menu. Until every item has been measured, all stay in the
 * bar.
 */
export function useToolbarOverflow(barRef: RefObject<HTMLElement | null>, items: ToolbarItem[]) {
  const widths = useRef(new Map<string, number>());
  const [kept, setKept] = useState<number | null>(null);
  const keys = items.map(item => item.key).join('\n');

  const measure = useCallback(() => {
    const bar = barRef.current;
    // Not laid out (a hidden view): leave the items where they are.
    if (!bar || bar.clientWidth === 0) return;
    for (const el of bar.querySelectorAll<HTMLElement>('[data-bar-item]')) widths.current.set(el.dataset.barItem ?? '', el.getBoundingClientRect().width);
    const known = keys.split('\n').map(key => widths.current.get(key));
    if (known.some(width => width === undefined)) { setKept(null); return; }
    const style = getComputedStyle(bar);
    const fixed = [...bar.querySelectorAll<HTMLElement>('[data-bar-fixed]')];
    const fixedWidth = fixed.reduce((sum, el) => sum + (Number(el.dataset.barMin) || el.getBoundingClientRect().width), 0);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const room = bar.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - fixedWidth - gap * (fixed.length - 1);
    const reserve = bar.querySelector<HTMLElement>('[data-bar-more]')?.getBoundingClientRect().width || MORE_BUTTON_WIDTH;
    const fit = fitItems(known as number[], room, gap, reserve);
    setKept(fit >= known.length ? null : fit);
  }, [barRef, keys]);

  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef, measure]);

  return kept === null ? { inBar: items, overflowed: [] } : { inBar: items.slice(0, kept), overflowed: items.slice(kept) };
}

/**
 * The "…" button and the menu of the controls that did not fit in the bar. The controls stay live
 * (their own dropdowns open from the menu); a press inside any floating layer is not outside the
 * menu.
 */
export function ToolbarOverflowMenu({ items }: { items: ToolbarItem[] }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const dismiss = useDismiss(context, { outsidePress: event => !(event.target instanceof Element && event.target.closest('[data-floating-ui-portal]')) });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  return (
    <div className="ml-auto flex shrink-0 items-center" data-bar-more="">
      <Tooltip content="More toolbar actions">
        <Button
          ref={refs.setReference}
          {...getReferenceProps({ onClick: () => setOpen(prev => !prev) })}
          variant="icon"
          aria-label="More toolbar actions"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </Button>
      </Tooltip>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)', maxWidth: 'min(22rem, calc(100vw - 16px))' }}
              className="ln-dropdown z-50 flex flex-wrap items-center gap-2 rounded-md p-2"
              role="dialog"
              aria-label="More toolbar actions"
              {...getFloatingProps()}
            >
              {items.map(item => <div key={item.key} className="flex items-center gap-2">{item.node}</div>)}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
