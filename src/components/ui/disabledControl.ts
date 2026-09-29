/** onClick/disabled/tooltip triplet a control renders when disabled with a reason. */
export interface DisabledControlState<H> {
  onClick: H | undefined;
  disabled: boolean | undefined;
  tooltip: string | undefined;
}

/**
 * Derives the onClick/disabled/tooltip triplet for a control that stays visible but disables with
 * a reason: the handler is withheld exactly when `disabled` is set, the tooltip shows `reason` in
 * that case, and falls back to `activeTooltip` otherwise.
 */
export function disabledControl<H>(
  onClick: H,
  disabled: boolean | undefined,
  reason: string | undefined,
  activeTooltip?: string,
): DisabledControlState<H> {
  return {
    onClick: disabled ? undefined : onClick,
    disabled,
    tooltip: disabled && reason ? reason : activeTooltip,
  };
}
