import type { ReactNode } from 'react';
import { FloatingFocusManager, FloatingPortal } from '@floating-ui/react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
import { disabledControl } from './disabledControl';
import { useDropdown } from '../../hooks/useDropdown';

/** Props for the {@link ToolbarDropdown} component. */
interface ToolbarDropdownProps {
  /** Tooltip text shown on the trigger button. */
  tooltipContent: string;
  /** When true, shows the blue filter-active dot on the trigger. */
  isNarrowed?: boolean;
  /** SVG icon element rendered inside the trigger button. */
  icon: ReactNode;
  /** Tailwind width class for the floating panel; narrowed so only classes Tailwind emitted are reachable. */
  panelWidth: 'w-56' | 'w-96';
  /** ARIA role for the floating panel: a non-modal dialog, since every panel holds form controls. */
  panelRole?: 'dialog';
  /** Accessible label for the floating panel. */
  ariaLabel: string;
  /** When true, the trigger renders disabled and never opens the panel. */
  disabled?: boolean;
  /** Tooltip text shown on the trigger in place of {@link tooltipContent} while {@link disabled}. */
  disabledReason?: string;
  /** Extra Tailwind classes appended to the panel element. */
  panelClassName?: string;
  /** Rows and controls for the panel body; positioning and dismissal are not their concern. */
  children: ReactNode;
}

/**
 * Shared structural wrapper for toolbar filter dropdowns.
 *
 * @remarks
 * Owns the {@link useDropdown} hook, the trigger `Button`, and the `FloatingPortal`
 * panel frame. Callers supply the icon and the panel content — everything else
 * (positioning, outside-click, focus into the panel and back to the trigger, `isNarrowed` dot,
 * shadow, `isOpen` style) is here.
 */
export function ToolbarDropdown({
  tooltipContent,
  isNarrowed = false,
  icon,
  panelWidth,
  panelRole = 'dialog',
  ariaLabel,
  panelClassName = '',
  disabled = false,
  disabledReason,
  children,
}: ToolbarDropdownProps) {
  const { isOpen, toggle, refs, floatingStyles, context, getFloatingProps } = useDropdown();
  const trigger = disabledControl(toggle, disabled, disabledReason, tooltipContent);

  return (
    <>
      <div className={`relative inline-flex${isNarrowed ? ' ln-filter-dot' : ''}`}>
        <Tooltip content={trigger.tooltip}>
          <Button
            ref={refs.setReference}
            onClick={trigger.onClick}
            variant="icon"
            disabled={trigger.disabled}
            aria-label={ariaLabel}
            aria-expanded={isOpen}
            aria-haspopup={panelRole}
            style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
          >
            {icon}
          </Button>
        </Tooltip>
      </div>

      <FloatingPortal>
        {!disabled && isOpen && (
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)' }}
              className={`${panelWidth} rounded-md shadow-lg z-50 p-2 ln-dropdown${panelClassName ? ` ${panelClassName}` : ''}`}
              role={panelRole}
              aria-label={ariaLabel}
              {...getFloatingProps()}
            >
              {children}
            </div>
          </FloatingFocusManager>
        )}
      </FloatingPortal>
    </>
  );
}
