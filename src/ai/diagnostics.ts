import * as vscode from 'vscode';
import { AiSession } from './session';
import { Logger } from '../utils/log';
import type { SmState } from './smTypes';

/**
 * Telemetry data for a single agentic loop iteration (hop).
 */
export interface RoundTelemetry {
  round: number;
  phase: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  tools: string[];
  focusNode?: string;
  cacheHit: boolean;
  error?: string;
}

/**
 * Aggregated performance diagnostics for the entire chat turn.
 */
export interface PerformanceDiagnostics {
  summary: {
    model: string;
    mode: string;
    totalRounds: number;
    totalLatencyMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    peakBudgetUtilization: string;
  };
  rounds: RoundTelemetry[];
  system: {
    evictionEvents: number;
    detailArchiveSlots: number;
    finalAgendaSize: number;
  };
}

/**
 * PerformanceCollector - OOP Diagnostic Utility
 * 
 * Encapsulates the collection, calculation, and formatting of AI performance metrics.
 * Designed to be injected into the LineageParticipant loop and easily removed later.
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
    const cacheHint = cacheHit ? ' cache=hit' : ' cache=miss';
    const errHint = error ? ` ERROR=${error}` : '';
    
    // Standardized pair naming: [Hop X] Metrics — phase=... latency=...
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

    // Standardized summary naming
    this.logger.info(`[Hop] Performance Final — total_latency=${totalLatency}ms hops=${this.rounds.length} tokens=${totalIn}in/${totalOut}out utilization=${utilization} evictions=${this.evictionCount}`);
    
    return diag;
  }
}
