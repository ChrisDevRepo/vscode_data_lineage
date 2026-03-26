import { memo, useState, useRef, useCallback, useEffect } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { Button } from './ui/Button';
import { useDropdown } from '../hooks/useDropdown';
import { compileExclusionPattern } from '../utils/sql';

interface ExclusionDropdownProps {
  exclusionPatterns: string[];
  onAddPattern: (pattern: string) => void;
  onRemovePattern: (pattern: string) => void;
}

export const ExclusionDropdown = memo(function ExclusionDropdown({
  exclusionPatterns,
  onAddPattern,
  onRemovePattern,
}: ExclusionDropdownProps) {
  const { isOpen, toggle, refs, floatingStyles, getFloatingProps } = useDropdown('bottom-end');
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50); // defer past dropdown paint
    } else {
      setInputValue('');
      setInputError(false);
    }
  }, [isOpen]);

  const validate = useCallback((value: string): boolean => {
    if (!value.trim()) return false;
    try { compileExclusionPattern(value); return true; } catch { return false; }
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInputValue(v);
    if (inputError && v) setInputError(false);
  }, [inputError]);

  const handleAdd = useCallback(() => {
    const v = inputValue.trim();
    if (!v) return;
    if (!validate(v)) { setInputError(true); return; }
    onAddPattern(v);
    setInputValue('');
    setInputError(false);
  }, [inputValue, validate, onAddPattern]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
  }, [handleAdd]);

  const count = exclusionPatterns.length;

  return (
    <>
      <div className="relative inline-flex">
        <Button
          ref={refs.setReference}
          onClick={toggle}
          variant="icon"
          title="Exclusion Rules — hide nodes matching patterns"
          aria-expanded={isOpen}
          aria-haspopup="true"
          style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
        >
          {/* no-symbol icon */}
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </Button>
        {count > 0 && (
          <span
            className="absolute -top-1 -right-1 flex items-center justify-center rounded-full pointer-events-none"
            style={{
              minWidth: '14px',
              height: '14px',
              fontSize: '9px',
              fontWeight: 700,
              padding: '0 3px',
              background: 'var(--ln-button-bg)',
              color: 'var(--ln-button-fg)',
              lineHeight: 1,
            }}
            aria-label={`${count} exclusion rule${count === 1 ? '' : 's'} active`}
          >
            {count}
          </span>
        )}
      </div>

      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, width: '288px', boxShadow: 'var(--ln-dropdown-shadow)' }}
            className="rounded-md shadow-lg z-30 ln-dropdown"
            role="dialog"
            aria-label="Exclusion rules"
            {...getFloatingProps()}
          >
            {/* Input row */}
            <div className="p-2 flex gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Pattern, e.g. %tmp% or ^dbo\.stg_"
                className="flex-1 text-sm rounded px-2 py-1 min-w-0 ln-input"
                style={inputError ? { outline: '1px solid var(--vscode-inputValidation-errorBorder, #f44)' } : undefined}
                aria-label="Enter exclusion pattern"
                aria-invalid={inputError}
                spellCheck={false}
              />
              <button
                onClick={handleAdd}
                className="px-2.5 py-1 text-sm rounded font-medium transition-colors ln-btn-primary"
                title="Add pattern (Enter)"
              >
                Add
              </button>
            </div>
            {inputError && (
              <p className="px-3 pb-1.5 text-[11px]" style={{ color: 'var(--vscode-inputValidation-errorForeground, #f44)' }}>
                Invalid pattern — check regex syntax
              </p>
            )}

            {/* Quick Tips */}
            <div className="px-2 pb-1">
              <button
                onClick={() => setTipsOpen(prev => !prev)}
                className="w-full flex items-center gap-1 px-1 py-1 text-xs rounded ln-list-item ln-text-muted"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                  className="w-3 h-3 flex-shrink-0 transition-transform"
                  style={{ transform: tipsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
                Quick Tips
              </button>
              {tipsOpen && (
                <div className="mt-1 px-2 pb-1.5 text-[11px] space-y-0.5 ln-text-muted font-mono">
                  <div className="grid grid-cols-2 gap-x-2">
                    <span className="font-medium" style={{ color: 'var(--ln-fg)' }}>%word%</span>
                    <span>contains "word"</span>
                    <span className="font-medium" style={{ color: 'var(--ln-fg)' }}>schema.%</span>
                    <span>whole schema</span>
                    <span className="font-medium" style={{ color: 'var(--ln-fg)' }}>^dbo\.tmp_</span>
                    <span>starts with dbo.tmp_</span>
                    <span className="font-medium" style={{ color: 'var(--ln-fg)' }}>(tmp|stg)</span>
                    <span>regex alternation</span>
                  </div>
                  <p className="pt-0.5 font-sans" style={{ color: 'var(--ln-fg-dim)' }}>
                    Matched against <em>schema.name</em>. Case-insensitive.
                  </p>
                </div>
              )}
            </div>

            <div className="mx-2 ln-border-top" />

            {/* Rules list */}
            <div className="p-1.5 max-h-52 overflow-y-auto">
              {count === 0 ? (
                <p className="px-2 py-2 text-xs text-center ln-text-muted">No exclusion rules</p>
              ) : (
                exclusionPatterns.map((pattern) => {
                  const isWildcard = pattern.includes('%');
                  return (
                    <div
                      key={pattern}
                      className="flex items-center gap-1.5 px-2 py-1 rounded ln-list-item group"
                    >
                      <span
                        className="flex-1 text-xs font-mono truncate ln-text"
                        title={pattern}
                      >
                        {pattern}
                      </span>
                      {isWildcard && (
                        <span
                          className="text-[10px] px-1 rounded flex-shrink-0"
                          style={{ background: 'var(--ln-bg-secondary)', color: 'var(--ln-fg-dim)' }}
                          title="Uses % wildcard"
                        >
                          %
                        </span>
                      )}
                      <button
                        onClick={() => onRemovePattern(pattern)}
                        className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors ln-text-muted hover:opacity-80"
                        title={`Remove: ${pattern}`}
                        aria-label={`Remove exclusion pattern: ${pattern}`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </FloatingPortal>
    </>
  );
});
