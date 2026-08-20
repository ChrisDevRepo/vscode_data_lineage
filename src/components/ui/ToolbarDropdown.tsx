import type { ReactNode } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
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
  /** ARIA role for the floating panel; narrowed so a typo cannot ship an invalid role to assistive tech. */
  panelRole: 'listbox' | 'menu';
  /** Accessible label for the floating panel. */
  ariaLabel: string;
  /** `aria-haspopup` value for the trigger button (default `'listbox'`). */
  ariaHaspopup?: boolean | 'true' | 'false' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
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
 * (positioning, outside-click, `isNarrowed` dot, shadow, `isOpen` style) is here.
 */
export function ToolbarDropdown({
  tooltipContent,
  isNarrowed = false,
  icon,
  panelWidth,
  panelRole,
  ariaLabel,
  ariaHaspopup = 'listbox',
  panelClassName = '',
  children,
}: ToolbarDropdownProps) {
  const { isOpen, toggle, refs, floatingStyles, getFloatingProps } = useDropdown();

  return (
    <>
      <div className={`relative inline-flex${isNarrowed ? ' ln-filter-dot' : ''}`}>
        <Tooltip content={tooltipContent}>
          <Button
            ref={refs.setReference}
            onClick={toggle}
            variant="icon"
            aria-expanded={isOpen}
            aria-haspopup={ariaHaspopup}
            style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
          >
            {icon}
          </Button>
        </Tooltip>
      </div>

      <FloatingPortal>
        {isOpen && (
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
        )}
      </FloatingPortal>
    </>
  );
}
