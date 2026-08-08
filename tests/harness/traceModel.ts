/**
 * Pure parser and serializer for the AI diagnostic NDJSON trace `aiTraceWriter.ts` writes.
 *
 * @remarks
 * Every line the writer appends is `JSON.stringify({at, ...record})` for one
 * {@link AiTraceRecord} — the lifecycle union (`turn-start`, `turn-terminal`, `gate`, `phase`,
 * `tool`) plus the wire union (`wire-request`, `wire-response`, `wire-error`, `generation`,
 * `provider-raw`). This module turns that byte stream back into typed buckets without ever
 * touching a filesystem, `vscode`, or a network socket — callers (a CLI, a test, the Langfuse
 * exporter) own I/O; this module owns only the mapping from bytes to structure and back.
 *
 * The round trip is the load-bearing property: {@link serializeRun} applied to
 * {@link parseTrace}'s output reproduces the original bytes line-for-line for every well-formed
 * record, because each entry carries its source `lineIndex` and serialization replays lines in
 * that order rather than in bucket-iteration order. A record whose shape this module does not
 * recognize is never dropped — an unknown `type` lands in {@link ParsedRun.raw} verbatim, and a
 * line that is not even valid JSON lands in {@link ParsedRun.malformed} — so one bad line never
 * aborts the parse of an otherwise-readable trace.
 */
import type { RuntimeLifecycleRecord } from '../../src/ai/observability/aiTraceWriter';
import type { GenerationRecord, WireRecord } from '../../src/ai/observability/wireLog';

/** Bumped when the bucket shape below changes in a way a consumer must branch on. */
export const TRACE_MODEL_SCHEMA_VERSION = 1;

/** One parsed line: the record fields, the writer's `at` timestamp, and the 0-based source line. */
export type TraceEntry<T> = T & { readonly at: string; readonly lineIndex: number };

type Lifecycle<TType extends RuntimeLifecycleRecord['type']> =
  Extract<RuntimeLifecycleRecord, { readonly type: TType }>;

export type TurnStartEntry = TraceEntry<Lifecycle<'turn-start'>>;
export type TurnTerminalEntry = TraceEntry<Lifecycle<'turn-terminal'>>;
export type GateEntry = TraceEntry<Lifecycle<'gate'>>;
export type PhaseEntry = TraceEntry<Lifecycle<'phase'>>;
export type ToolEntry = TraceEntry<Lifecycle<'tool'>>;
export type TurnEntry = TurnStartEntry | TurnTerminalEntry;
export type GenerationEntry = TraceEntry<GenerationRecord>;
/** Every {@link WireRecord} variant except `generation`, which gets its own bucket — see {@link ParsedRun.generations}. */
export type WireEntry = TraceEntry<Exclude<WireRecord, GenerationRecord>>;
/** A structurally valid `{at, type, ...}` line whose `type` this schema version does not recognize. */
export type UnknownEntry = TraceEntry<{ readonly type: string } & Record<string, unknown>>;

/** One line that could not be read back as a trace record, kept verbatim rather than dropped. */
export interface MalformedLine {
  /** 0-based source line index, matching {@link TraceEntry.lineIndex} on well-formed neighbors. */
  readonly line: number;
  /** The original line text, unparsed — this is what {@link serializeRun} replays. */
  readonly text: string;
  /** `Error.name` from the failed `JSON.parse`, or a synthetic name for valid JSON of the wrong shape. */
  readonly errorName: string;
}

/** The whole trace, bucketed by record kind, with nothing dropped and nothing reordered within a bucket. */
export interface ParsedRun {
  readonly schemaVersion: typeof TRACE_MODEL_SCHEMA_VERSION;
  readonly turns: readonly TurnEntry[];
  readonly generations: readonly GenerationEntry[];
  readonly tools: readonly ToolEntry[];
  readonly gates: readonly GateEntry[];
  readonly phases: readonly PhaseEntry[];
  readonly wire: readonly WireEntry[];
  readonly raw: readonly UnknownEntry[];
  readonly malformed: readonly MalformedLine[];
}

/** One `turn-start` joined with its `turn-terminal`, when both exist in the run. */
export interface JoinedTurn {
  readonly requestId: string;
  readonly runFingerprint: string;
  /** Absent when the trace was cut off — cancelled process, truncated copy — before the turn started. */
  readonly start?: TurnStartEntry;
  /** Absent when the turn never reached a terminal state in this trace (e.g. an in-flight capture). */
  readonly terminal?: TurnTerminalEntry;
}

/**
 * Parses one NDJSON trace file's content into typed buckets.
 *
 * @param ndjson - Full file content, one JSON object per line (a single trailing newline, the
 *   convention every {@link AiTraceWriter} write leaves, is tolerated and not counted as a line).
 * @returns A {@link ParsedRun} in which every input line is accounted for exactly once, either as
 *   a typed entry, a `raw` entry, or a `malformed` entry.
 */
export function parseTrace(ndjson: string): ParsedRun {
  const lines = ndjson.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const turns: TurnEntry[] = [];
  const generations: GenerationEntry[] = [];
  const tools: ToolEntry[] = [];
  const gates: GateEntry[] = [];
  const phases: PhaseEntry[] = [];
  const wire: WireEntry[] = [];
  const raw: UnknownEntry[] = [];
  const malformed: MalformedLine[] = [];

  lines.forEach((text, lineIndex) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      malformed.push({ line: lineIndex, text, errorName: error instanceof Error ? error.name : 'Error' });
      return;
    }
    if (!isRecordShape(parsed)) {
      malformed.push({ line: lineIndex, text, errorName: 'NotATraceRecord' });
      return;
    }
    const entry = { ...parsed, lineIndex } as TraceEntry<Record<string, unknown>>;
    switch (entry.type) {
      case 'turn-start':
      case 'turn-terminal':
        turns.push(entry as TurnEntry);
        return;
      case 'gate':
        gates.push(entry as GateEntry);
        return;
      case 'phase':
        phases.push(entry as PhaseEntry);
        return;
      case 'tool':
        tools.push(entry as ToolEntry);
        return;
      case 'generation':
        generations.push(entry as GenerationEntry);
        return;
      case 'wire-request':
      case 'wire-response':
      case 'wire-error':
      case 'provider-raw':
        wire.push(entry as WireEntry);
        return;
      default:
        raw.push(entry as UnknownEntry);
    }
  });

  return { schemaVersion: TRACE_MODEL_SCHEMA_VERSION, turns, generations, tools, gates, phases, wire, raw, malformed };
}

/** A line parses as JSON but is not a `{at, type, ...}` object — never a valid trace record shape. */
function isRecordShape(value: unknown): value is { readonly at: string; readonly type: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === 'string' && typeof record.type === 'string';
}

/**
 * Re-emits a {@link ParsedRun} as NDJSON text, replaying every line — typed, raw, and malformed —
 * in its original source order.
 *
 * @remarks
 * Well-formed lines round-trip byte-identically: `serializeRun(parseTrace(text)) === text`
 * whenever `text` ends in a single trailing newline (or is empty), because each entry is
 * re-stringified from the exact object `JSON.parse` produced (key order included) minus only the
 * `lineIndex` this module added, and malformed lines are replayed from their stored `text`
 * unchanged. A trace with zero lines serializes back to the empty string.
 */
export function serializeRun(run: ParsedRun): string {
  const positioned: Array<{ readonly index: number; readonly text: string }> = [];
  const typed: ReadonlyArray<TraceEntry<Record<string, unknown>>> = [
    ...run.turns, ...run.generations, ...run.tools, ...run.gates, ...run.phases, ...run.wire, ...run.raw,
  ];
  for (const entry of typed) {
    const { lineIndex, ...record } = entry;
    positioned.push({ index: lineIndex, text: JSON.stringify(record) });
  }
  for (const bad of run.malformed) {
    positioned.push({ index: bad.line, text: bad.text });
  }
  if (positioned.length === 0) return '';
  positioned.sort((a, b) => a.index - b.index);
  return `${positioned.map((entry) => entry.text).join('\n')}\n`;
}

/**
 * Joins `turn-start` and `turn-terminal` lifecycle entries by `(requestId, runFingerprint)`.
 *
 * @remarks
 * The pairing key is the pair, not `requestId` alone: `runFingerprint` changes across a retried
 * run against the same native chat request, so requestId alone can silently merge two unrelated
 * turns. Preserves first-seen order across the trace; a start with no terminal (a cut-off
 * capture) and a terminal with no start (a trace beginning mid-turn) both surface with the
 * missing half left `undefined` rather than being dropped.
 */
export function joinTurns(run: ParsedRun): readonly JoinedTurn[] {
  const order: string[] = [];
  const byKey = new Map<string, { requestId: string; runFingerprint: string; start?: TurnStartEntry; terminal?: TurnTerminalEntry }>();
  for (const entry of run.turns) {
    const key = `${entry.requestId} ${entry.runFingerprint}`;
    let joined = byKey.get(key);
    if (!joined) {
      joined = { requestId: entry.requestId, runFingerprint: entry.runFingerprint };
      byKey.set(key, joined);
      order.push(key);
    }
    if (entry.type === 'turn-start') joined.start = entry;
    else joined.terminal = entry;
  }
  return order.map((key) => byKey.get(key) as JoinedTurn);
}
