import { memo, useState, type ReactNode } from 'react';
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
}

/**
 * Themed tooltip that replaces native `title` attributes.
 * Uses `--ln-*` CSS variables — correct in light, dark, and HC themes.
 */
export const Tooltip = memo(function Tooltip({ content, children, delay = 600 }: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom',
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

  return (
    <>
      <span ref={refs.setReference} {...getReferenceProps()} style={{ display: 'contents' }}>
        {children}
      </span>
      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={floatingStyles}
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
