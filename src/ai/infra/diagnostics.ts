import * as vscode from 'vscode';
import { AiSession } from '../session/session';
import { Logger } from '../../utils/log';
import type { SmState } from '../sm/smTypes';

/**
 * Telemetry data for a single agentic loop iteration (hop).
 */
export interface RoundTelemetry {
  /** 1-based round index within the turn. */
  round: number;
  /** Session phase active at the time the round ran (`discover` / `active` / `synthesis` / `completed`). */
  phase: string;
  /** Wall-clock latency of the LM round in milliseconds. */
  latencyMs: number;
  /** Input tokens reported by `model.countTokens` for the assembled envelope. */
  tokensIn: number;
  /** Output tokens reported by `model.countTokens` for the assistant response. */
  tokensOut: number;
  /** Tool names invoked during this round (without the `lineage_` prefix). */
  tools: string[];
  /** Focus node id, when the round drove an SM hop (`submit_findings`). */
  focusNode?: string;
  /** True when at least one tool result was served from the per-turn dedup cache. */
  cacheHit: boolean;
  /** Short error code captured from the round, when something rejected. */
  error?: string;
}

/**
 * Aggregated performance diagnostics for the entire chat turn.
 */
export interface PerformanceDiagnostics {
  /** Whole-turn rollups computed at finalize time. */
  summary: {
    /** Friendly model name from `request.model.name` or its id. */
    model: string;
    /** Engine mode at finalize (`column_trace` / `blackboard` / `idle`). */
    mode: string;
    /** Number of LM rounds executed this turn. */
    totalRounds: number;
    /** Cumulative wall-clock latency across all rounds. */
    totalLatencyMs: number;
    /** Sum of input tokens across all rounds. */
    totalTokensIn: number;
    /** Sum of output tokens across all rounds. */
    totalTokensOut: number;
    /** Peak round-input tokens as a percentage of `model.maxInputTokens`. */
    peakBudgetUtilization: string;
  };
  /** Per-round entries in chronological order. */
  rounds: RoundTelemetry[];
  /** Session-level counters captured at finalize. */
  system: {
    /** Count of context-pressure eviction triggers fired this turn. */
    evictionEvents: number;
    /** Detail-archive slot count at finalize (one per analyzed node). */
    detailArchiveSlots: number;
    /** Engine agenda length at finalize (typically 0 when SM completed cleanly). */
    finalAgendaSize: number;
  };
}

/**
 * Collects per-round and aggregate performance metrics for one chat turn.
 *
 * @remarks
 * Single-instance per turn, owned by the participant loop. Each LM round calls
 * {@link startRound} on entry and {@link recordRound} on exit; the participant
 * calls {@link finalize} at end of turn to produce the structured diagnostics
 * payload returned in `ChatResult.metadata`.
 */
export class PerformanceCollector {
  private readonly tStart: number = Date.now();
  private tRoundStart: number = 0;
  private rounds: RoundTelemetry[] = [];
  private evictionCount: number = 0;

  constructor(private readonly logger: Logger) {}

  /** Signals the start of a new LLM request round. */
  public startRound(): void {
    this.tRoundStart = Date.now();
  }

  /** Records a context eviction event (history wipe). */
  public recordEviction(): void {
    this.evictionCount++;
    this.logger.debug('[Hop] Context eviction event recorded');
  }

  /**
   * Records the results of a completed round (hop).
   */
  public recordRound(
    round: number,
    phase: string,
    tokensIn: number,
    tokensOut: number,
    tools: string[],
    focusNode?: string,
    cacheHit: boolean = false,
    error?: string
  ): void {
    const latency = Date.now() - this.tRoundStart;
    
    this.rounds.push({
      round,
      phase,
      latencyMs: latency,
      tokensIn,
      tokensOut,
      tools,
      focusNode,
      cacheHit,
      error
    });

    const toolNames = tools.join(',');
    const focusHint = focusNode ? ` node=${focusNode}` : '';
    const cacheHint = cacheHit ? ' dedup=hit' : '';
    const errHint = error ? ` ERROR=${error}` : '';

    this.logger.debug(`[Hop ${round}] [${phase.toUpperCase()}] Metrics — latency=${latency}ms tokens=${tokensIn}in/${tokensOut}out tools=[${toolNames}]${focusHint}${cacheHint}${errHint}`);
  }

  /**
   * Aggregates all collected data into the final VS Code Chat metadata format.
   * Also prints a final high-level summary to our internal debug channel.
   */
  public finalize(sess: AiSession, peakInput: number): PerformanceDiagnostics {
    const totalLatency = Date.now() - this.tStart;
    const totalIn = this.rounds.reduce((sum, r) => sum + r.tokensIn, 0);
    const totalOut = this.rounds.reduce((sum, r) => sum + r.tokensOut, 0);
    const utilization = sess.maxInputTokens > 0 
      ? `${((peakInput / sess.maxInputTokens) * 100).toFixed(0)}%`
      : '0%';

    const smState: SmState | null = sess.stateMachine ? sess.stateMachine.toJSON() : null;

    const diag: PerformanceDiagnostics = {
      summary: {
        model: sess.modelName || 'unknown',
        mode: sess.stateMachine ? (sess.stateMachine.columnAspect ? 'column_trace' : 'blackboard') : 'idle',
        totalRounds: this.rounds.length,
        totalLatencyMs: totalLatency,
        totalTokensIn: totalIn,
        totalTokensOut: totalOut,
        peakBudgetUtilization: utilization
      },
      rounds: this.rounds,
      system: {
        evictionEvents: this.evictionCount,
        detailArchiveSlots: sess.memory.slotCount,
        finalAgendaSize: smState?.agendaSize ?? 0
      }
    };

    this.logger.info(`[AI] [Hop] Performance Final — total_latency=${totalLatency}ms hops=${this.rounds.length} tokens=${totalIn}in/${totalOut}out utilization=${utilization} evictions=${this.evictionCount}`);
    
    return diag;
  }
}

