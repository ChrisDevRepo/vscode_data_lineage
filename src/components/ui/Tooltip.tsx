import { memo, useState, isValidElement, cloneElement, type ReactNode, type ReactElement } from 'react';
import {
  useFloating,
  useInteractions,
  useHover,
  useFocus,
  useDismiss,
  offset,
  flip,
  shift,
  autoUpdate,
} from '@floating-ui/react';
import { FloatingPortal } from '@floating-ui/react';

interface TooltipProps {
  content: string;
  children: ReactNode;
  /** Delay before showing tooltip in ms. Default: 600 */
  delay?: number;
  /** Allow multi-line content (pre-wrap). Default: false */
  multiline?: boolean;
  /** Max width in px for multiline tooltips. Default: 220 */
  maxWidth?: number;
  /** Preferred placement. Default: 'bottom' */
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Merge ref + props onto the single child element (no wrapper span). Default: false */
  asChild?: boolean;
}

/**
 * Themed tooltip that replaces native `title` attributes.
 * Uses `--ln-*` CSS variables — correct in light, dark, and HC themes.
 */
export const Tooltip = memo(function Tooltip({
  content,
  children,
  delay = 600,
  multiline = false,
  maxWidth = 220,
  placement = 'bottom',
  asChild = false,
}: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const hover = useHover(context, { delay: { open: delay, close: 0 }, move: false });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss]);

  const trigger = asChild && isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        ref: refs.setReference,
        ...getReferenceProps(),
      })
    : (
      <span ref={refs.setReference} {...getReferenceProps()} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {children}
      </span>
    );

  return (
    <>
      {trigger}
      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, ...(multiline ? { whiteSpace: 'pre-wrap', maxWidth } : {}) }}
            className="ln-tooltip"
            {...getFloatingProps()}
          >
            {content}
          </div>
        )}
      </FloatingPortal>
    </>
  );
});
