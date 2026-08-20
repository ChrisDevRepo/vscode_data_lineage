import type { LogFn } from '../../engine/graphGuards';
import type { Logger } from '../../utils/log';

/**
 * Adapter from the host {@link Logger} to the engine's injected {@link LogFn}.
 *
 * @remarks
 * Sole bridge between the AI layer's concrete logger and `NavigationEngine`'s
 * logging callback. Every engine construction site must use it so engine-level
 * error routing (which levels reach the Output channel, how caught errors are
 * wrapped) cannot drift between call sites.
 */
export function toEngineLog(logger: Logger | undefined): LogFn {
  return (level, msg, err) => {
    const line = `[Engine] ${msg}`;
    if (level === 'error') logger?.error('engine', err ?? new Error(msg));
    else if (level === 'warn') logger?.warn(line);
    else if (level === 'info') logger?.info(line);
    else logger?.debug(line);
  };
}
