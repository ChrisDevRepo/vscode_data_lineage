/** Parses diagnostic NDJSON into typed buckets for test tools and trace export. Unknown records and malformed lines retain their original positions so partial traces remain inspectable. Callers own filesystem and network I/O. */
import type { RuntimeLifecycleRecord } from '../../src/ai/observability/aiTraceWriter';
import type { GenerationRecord, WireRecord } from '../../src/ai/observability/wireLog';

/** Bumped when the bucket shape below changes in a way a consumer must branch on. */
export const TRACE_MODEL_SCHEMA_VERSION = 2;

/** One parsed line: the record fields, the writer's `at` timestamp, and the 0-based source line. */
type TraceEntry<T> = T & { readonly at: string; readonly lineIndex: number };

type Lifecycle<TType extends RuntimeLifecycleRecord['type']> =
  Extract<RuntimeLifecycleRecord, { readonly type: TType }>;

type TraceOpenEntry = TraceEntry<Lifecycle<'trace-open'>>;
type TurnStartEntry = TraceEntry<Lifecycle<'turn-start'>>;
type TurnTerminalEntry = TraceEntry<Lifecycle<'turn-terminal'>>;
type GateEntry = TraceEntry<Lifecycle<'gate'>>;
type PhaseEntry = TraceEntry<Lifecycle<'phase'>>;
export type ToolEntry = TraceEntry<Lifecycle<'tool'>>;
type TurnEntry = TurnStartEntry | TurnTerminalEntry;
export type GenerationEntry = TraceEntry<GenerationRecord>;
/** Every {@link WireRecord} variant except `generation`, which gets its own bucket — see {@link ParsedRun.generations}. */
type WireEntry = TraceEntry<Exclude<WireRecord, GenerationRecord>>;
/** A structurally valid `{at, type, ...}` line whose `type` this schema version does not recognize. */
type UnknownEntry = TraceEntry<{ readonly type: string } & Record<string, unknown>>;

/** One line that could not be read back as a trace record, kept verbatim rather than dropped. */
interface MalformedLine {
  /** 0-based source line index, matching {@link TraceEntry.lineIndex} on well-formed neighbors. */
  readonly line: number;
  /** The original malformed line text, preserved for diagnosis. */
  readonly text: string;
  /** `Error.name` from the failed `JSON.parse`, or a synthetic name for valid JSON of the wrong shape. */
  readonly errorName: string;
}

/** The whole trace, bucketed by record kind, with nothing dropped and nothing reordered within a bucket. */
export interface ParsedRun {
  readonly schemaVersion: typeof TRACE_MODEL_SCHEMA_VERSION;
  /** The producer stamp(s) — the writer emits exactly one as the file's first line; concatenated captures may carry more. */
  readonly traceOpen: readonly TraceOpenEntry[];
  readonly turns: readonly TurnEntry[];
  readonly generations: readonly GenerationEntry[];
  readonly tools: readonly ToolEntry[];
  readonly gates: readonly GateEntry[];
  readonly phases: readonly PhaseEntry[];
  readonly wire: readonly WireEntry[];
  readonly raw: readonly UnknownEntry[];
  readonly malformed: readonly MalformedLine[];
}

/** One request identity, spanning its first start through its last completed resume. */
export interface JoinedTurn {
  readonly requestId: string;
  readonly runFingerprint: string;
  /** Absent when the trace was cut off — cancelled process, truncated copy — before the turn started. */
  readonly start?: TurnStartEntry;
  /** Absent when the turn never reached a terminal state in this trace (e.g. an in-flight capture). */
  readonly terminal?: TurnTerminalEntry;
}

/** Parses one NDJSON trace file's content into typed buckets. */
export function parseTrace(ndjson: string): ParsedRun {
  const lines = ndjson.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const traceOpen: TraceOpenEntry[] = [];
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
      case 'trace-open':
        traceOpen.push(entry as TraceOpenEntry);
        return;
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

  return { schemaVersion: TRACE_MODEL_SCHEMA_VERSION, traceOpen, turns, generations, tools, gates, phases, wire, raw, malformed };
}

/** A line parses as JSON but is not a `{at, type, ...}` object — never a valid trace record shape. */
function isRecordShape(value: unknown): value is { readonly at: string; readonly type: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === 'string' && typeof record.type === 'string';
}

/** Joins a request's pause/resume lifecycle by `(requestId, runFingerprint)`, retaining its first start and clearing an earlier terminal on resume. */
export function joinTurns(run: ParsedRun): readonly JoinedTurn[] {
  const order: string[] = [];
  const byKey = new Map<string, { requestId: string; runFingerprint: string; start?: TurnStartEntry; terminal?: TurnTerminalEntry }>();
  for (const entry of run.turns) {
    const key = `${entry.requestId}\0${entry.runFingerprint}`;
    let joined = byKey.get(key);
    if (!joined) {
      joined = { requestId: entry.requestId, runFingerprint: entry.runFingerprint };
      byKey.set(key, joined);
      order.push(key);
    }
    if (entry.type === 'turn-start') {
      joined.start ??= entry;
      joined.terminal = undefined;
    } else joined.terminal = entry;
  }
  return order.map((key) => byKey.get(key) as JoinedTurn);
}
