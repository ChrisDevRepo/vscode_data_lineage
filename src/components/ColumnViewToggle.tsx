import { memo } from 'react';
import { Tooltip } from './ui/Tooltip';

interface ColumnViewToggleProps {
  /** Whether the column view is the one currently rendered. */
  active?: boolean;
  /** Switches between the object view and the column view of the same scope. */
  onToggle: (columnView: boolean) => void;
}

/** Objects/Detail switch shared by the live AI preview banner and the restored-bookmark banner. */
export const ColumnViewToggle = memo(function ColumnViewToggle({ active, onToggle }: ColumnViewToggleProps) {
  return (
    <Tooltip content={'Objects shows dependencies between objects.\nDetail shows the column-level findings of this analysis.'} placement="bottom" multiline>
      <div className="flex items-center gap-0.5" role="group" aria-label="View detail level">
        <button
          onClick={() => onToggle(false)}
          aria-pressed={!active}
          className={`ln-mode-banner__btn-sm ${active ? 'ln-btn-secondary' : 'ln-btn-primary'}`}
        >
          Objects
        </button>
        <button
          onClick={() => onToggle(true)}
          aria-pressed={!!active}
          className={`ln-mode-banner__btn-sm ${active ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
        >
          Detail
        </button>
      </div>
    </Tooltip>
  );
});
