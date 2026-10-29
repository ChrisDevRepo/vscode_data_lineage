/** AI `present_result` contract: input/output types, validation, and the deterministic markdown assembly. Zero VS Code imports. */
import {
  PresentResultModelSchema,
  type PresentResultRepairField,
} from './toolSchemas';
import { normalizeColName, schemaKey } from '../../utils/sql';
import { makeRejection, type IssueCode, type ToolError, type ToolRejection } from '../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { FOCUS_NODE_HREF_PREFIX, type ColumnTransformClass } from '../../engine/shared/bridgeContract';
import type { DetailSlot } from '../session/memoryManager';
import type { z } from 'zod';
import { marked } from 'marked';
import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';

/** The stage `lineage_present_result` is being called from, as classified by the caller. */
export type PresentResultStage = 'visual_preview' | 'synthesis' | 'completed';

/** The state the engine already records for a node id the current result graph cannot link. */
export type PresentNodeIdState =
  | 'not_in_model'
  | 'pruned'
  | 'in_scope_undispositioned'
  | 'out_of_scope';

/** Classifies one unlinkable node id against the engine state the session holds. */
export type PresentNodeIdStateLookup = (nodeId: string) => PresentNodeIdState;

/** What `add_node_ids` reveals; the follow-up instruction and the unknown-id route state it identically. */
export const ADD_NODE_IDS_REVEALS = 'reveals any object in the approved exploration scope';

/** The AI's submission to `lineage_present_result`. */
export type PresentResultInput = z.infer<typeof PresentResultModelSchema>;

/** The validated, engine-assembled result ready for the UI. */
type PresentResultRequest = {
  name: string;
  node_ids: string[];
  summary: string;
  description: string;
  /** Absent when the model omitted it — the view then follows the user's configured direction. */
  layout_direction?: 'LR' | 'TB';
  highlight_groups: NonNullable<PresentResultInput['highlight_groups']>;
  badges: Array<{ node_id: string; text: string }>;
  notes: Array<{ node_id: string; caption: string }>;
};

/** One numbered top-level block of the cached discovery answer, served to the preview stage as `answer_blocks`. */
interface AnswerBlock {
  readonly id: string;
  readonly text: string;
}

/** Splits the cached discovery answer into engine-owned title/summary and numbered source blocks. */
export function discoveryPreviewNarrative(answer: string): {
  title?: string;
  blocks: AnswerBlock[];
  summary?: string;
} {
  const normalized = answer.replace(/\r\n?/g, '\n').trim();
  const [lead] = marked.lexer(normalized);
  const heading = lead?.type === 'heading' && lead.depth === 1 ? lead : undefined;
  const title = heading?.text.trim();
  const body = heading ? normalized.slice(heading.raw.length).trim() : normalized;
  const tokens = marked.lexer(body);
  const first = tokens.find(token => token.type !== 'code' && token.type !== 'hr' && token.type !== 'space');
  const text: string | undefined = first?.type === 'list' ? first.items[0]?.text : first && 'text' in first ? first.text : first?.raw;
  const summary = text?.split('\n').find(line => line.trim())?.trim() || title;
  const texts: string[] = [];
  const leading: string[] = [];
  for (const token of tokens) {
    const raw = token.raw.trim();
    if (token.type === 'space') continue;
    if (token.type !== 'hr') texts.push([...leading.splice(0), raw].join('\n\n'));
    else if (texts.length > 0) texts[texts.length - 1] += `\n\n${raw}`;
    else leading.push(raw);
  }
  if (leading.length > 0) texts.push(leading.join('\n\n'));
  const blocks = texts.map((blockText, index) => ({ id: `B${index + 1}`, text: blockText }));
  return { ...(title ? { title } : {}), blocks, summary };
}

/** The fault of a preview section that does not start strictly after the section before it. */
export const START_ORDER_FAULT = 'Starts ascend strictly; this section starts at or before the one above.';

/** Indexes of preview `sections` that do not start strictly after the section before them. The first section always begins at B1; the served schema constrains the ids, and order depends on the whole (merged) list, so it is checked here. */
export function findStartOrderIssues(starts: ReadonlyMap<number, string>): number[] {
  const block = (index: number, start: string) => index === 0 ? 1 : Number(start.slice(1));
  return [...starts].flatMap(([index, start]) => index > 0 && (index === 1 || starts.has(index - 1))
    && block(index, start) <= (index === 1 ? 1 : block(index - 1, starts.get(index - 1)!)) ? [index] : []);
}

/** The 1-based block a preview section starts at; the first section always begins at B1. */
function startBlock(sections: ReadonlyArray<{ start: string }>, index: number): number {
  return index === 0 ? 1 : Number(sections[index].start.slice(1));
}

/** Builds each preview section's `text` from the blocks between its start and the next section's start (the first from B1, the last to the end), so the joined text is the cached answer in its own words. */
export function assemblePreviewSections(
  blocks: readonly AnswerBlock[],
  sections: ReadonlyArray<{ label: string; node_ids: string[]; start: string }>,
): PresentResultInput['sections'] {
  return sections.map(({ start: _start, ...section }, index) => ({
    ...section,
    text: blocks.slice(startBlock(sections, index) - 1, index + 1 < sections.length ? startBlock(sections, index + 1) - 1 : blocks.length).map(block => block.text).join('\n\n'),
  }));
}

/** A defect found outside {@link inspectPresentResult} but reported through its accumulator. */
export interface PresentResultViolation {
  /** The faults reported through the inspection's accumulator. */
  readonly errors: readonly ToolError[];
  /** Fields this violation authorizes for a repair resend. */
  readonly repairFields: readonly PresentResultRepairField[];
  /** Exact offending entry paths, empty when the violation is about the payload as a whole. */
  readonly paths: readonly string[];
  /** The backend-loaded node ids this violation asks the AI to place (an uncovered detail-slot or CT-chain node); the unexplained-node check skips them. */
  readonly entryIds?: readonly string[];
}

/** Encodes a node id for the `#focus-node:` destination of an engine-assembled object link. */
function encodeFocusNodeId(id: string): string {
  return encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Returns the ```sql fence opening at `openIndex`, tolerant of a one-line fence and of its closing marker sharing a line with the last line of code rather than starting one of its own. */
function sqlFenceAt(text: string, openIndex: number): string | undefined {
  const rest = text.slice(openIndex);
  if (!/^```sql/i.test(rest)) return undefined;
  const close = rest.indexOf('```', '```sql'.length);
  // A following language opener cannot close this SQL block or turn intervening prose into SQL.
  if (close === -1) return undefined;
  // A marker on the opening line closes it: a language opener starts a line of its own.
  if (!rest.slice(0, close).includes('\n')) return rest.slice(0, close + 3);
  const suffix = rest.slice(close + 3);
  const spacedOpener = /^[ \t]+[a-z][\w.+-]*(?:[ \t]+S\d+)?[ \t]*(?:\r?\n|$)/i.test(suffix);
  if (/^[a-z]/i.test(suffix) || spacedOpener) return undefined;
  return rest.slice(0, close + 3);
}

/** One fenced code block captured in a detail slot, addressable by a deterministic citation id. */
interface EvidenceBlock {
  /** Citation id, e.g. `S7` — carried in the fence info string the envelope shows (`sql S7`). */
  readonly id: string;
  /** Owning node id. */
  readonly nodeId: string;
  /** The captured ```sql fence closed on a line of its own — body de-indented out of its list or block-quote container, `sql S7` annotation excluded — rendered verbatim. */
  readonly raw: string;
}

/** Reports captured SQL whose exact fenced body is absent; enclosing Markdown indentation is not SQL content. */
export function evidenceCoverage(
  blocks: ReadonlyMap<string, EvidenceBlock>,
  renderedTexts: readonly string[],
): { readonly served: number; readonly unusedIds: string[] } {
  const rendered = new Set(renderedTexts.flatMap(text => [...locateSqlFences(text)].map(fence => fenceBodyKey(fence.lines))));
  const unusedIds: string[] = [];
  for (const block of blocks.values()) {
    const body = block.raw.split('\n').slice(1, -1).join('\n');
    if (!rendered.has(body)) unusedIds.push(block.id);
  }
  return { served: blocks.size, unusedIds };
}

/** Container prefix of a line: block-quote markers, indentation and a list marker. */
const CONTAINER_PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/;

/** Info string of an evidence reference: optional info words, then the id (group 1). */
const EVIDENCE_ID_INFO = /^[ \t]*(?:[^\s`]+[ \t]+)*?(S\d+)[ \t]*$/;

/** One ```sql fence located by the {@link sqlFenceAt} rule. */
interface LocatedSqlFence {
  /** Offset of the ```sql marker. */
  readonly start: number;
  /** Offset just past the closing marker. */
  readonly end: number;
  /** Text after ```sql on the opening line; for a one-line fence, everything between the markers. */
  readonly info: string;
  /** Code lines, de-indented out of the opening line's container; empty for a one-line or empty fence. */
  readonly lines: readonly string[];
  /** Container prefix of the opening line. */
  readonly container: string;
}

/** Every ```sql fence in `text`, in order, by the {@link sqlFenceAt} rule: the marker may open mid-line after prose or a formula, and the closing marker may share a line with code or with prose after it. An unclosed marker yields nothing. */
function* locateSqlFences(text: string): Generator<LocatedSqlFence> {
  const opener = /```sql/gi;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const fence = sqlFenceAt(text, match.index);
    if (!fence) continue;
    const inner = fence.slice('```sql'.length, -'```'.length);
    const newline = inner.indexOf('\n');
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const container = CONTAINER_PREFIX.exec(text.slice(lineStart, match.index))?.[0] ?? '';
    const lines = newline === -1 ? [] : inner.slice(newline + 1).split('\n')
      .map(line => (container.includes('>') ? line.replace(/^(?:[ \t]*>)+[ \t]?/, '') : line));
    if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
    yield {
      start: match.index,
      end: match.index + fence.length,
      info: newline === -1 ? inner : inner.slice(0, newline),
      lines: lines.some(line => line.trim()) ? lines.map(line => line.slice(indent)) : [],
      container,
    };
    opener.lastIndex = match.index + fence.length;
  }
}

/** Assigns one deterministic citation id to every captured ```sql fence with a body in detail-slot text — numbered by detail-slot order, then block order — carried in the envelope as an addition to the fence's own info string (```` ```sql S7 ````), never a separate inline marker (a bracketed marker collides with T-SQL bracket identifiers and Markdown link syntax). */
export function assignEvidenceIds(
  detailSlots: readonly DetailSlot[],
): { readonly slots: DetailSlot[]; readonly blocks: ReadonlyMap<string, EvidenceBlock> } {
  const blocks = new Map<string, EvidenceBlock>();
  let n = 0;
  const slots = detailSlots.map(slot => ({
    ...slot,
    sections: slot.sections.map(section => {
      let cursor = 0;
      let text = '';
      for (const fence of locateSqlFences(section.text)) {
        if (fence.lines.length === 0) continue;
        n += 1;
        const id = `S${n}`;
        const info = fence.info.trimEnd();
        blocks.set(id, { id, nodeId: slot.nodeId, raw: [`\`\`\`sql${info}`, ...fence.lines, '```'].join('\n') });
        const infoEnd = fence.start + '```sql'.length + info.length;
        text += `${section.text.slice(cursor, infoEnd)} ${id}`;
        cursor = infoEnd;
      }
      if (cursor === 0) return section;
      return { ...section, text: text + section.text.slice(cursor) };
    }),
  }));
  return { slots, blocks };
}

/** Exact fence-body identity; whitespace can change SQL literal and quoted-identifier values. */
function fenceBodyKey(lines: readonly string[]): string {
  return lines.join('\n');
}

/** Where a fence stands on its line, widened over a parenthesis pair that wraps only the fence. */
interface FenceExtent {
  readonly lineStart: number;
  /** Offset of the line's newline, or `text.length` on the last line. */
  readonly lineEnd: number;
  /** Start of the fence, or of the `(` that wraps it. */
  readonly from: number;
  /** End of the fence, or just past the `)` that wraps it. */
  readonly to: number;
  /** Nothing but the container prefix precedes `from` and nothing but whitespace follows `to` on the line. */
  readonly ownLine: boolean;
}

/** Locates `fence` on its line; a `(` before and a `)` after it with nothing else between are part of the extent. */
function fenceExtent(text: string, fence: LocatedSqlFence): FenceExtent {
  const lineStart = text.lastIndexOf('\n', fence.start - 1) + 1;
  const newline = text.indexOf('\n', fence.end);
  const lineEnd = newline === -1 ? text.length : newline;
  const open = /[ \t]*\([ \t]*$/.exec(text.slice(lineStart + fence.container.length, fence.start));
  const close = /^[ \t]*\)/.exec(text.slice(fence.end, lineEnd));
  const wrapped = open !== null && close !== null;
  const from = wrapped ? fence.start - open[0].length : fence.start;
  const to = wrapped ? fence.end + close[0].length : fence.end;
  return { lineStart, lineEnd, from, to, ownLine: text.slice(lineStart, from) === fence.container && text.slice(to, lineEnd).trim() === '' };
}

/** The span of the whole lines a fence occupies — container prefix and one newline included — when nothing else shares them; otherwise the fence alone, with a wrapping `( )` pair. */
function fenceLineSpan(text: string, fence: LocatedSqlFence): [number, number] {
  const { lineStart, lineEnd, from, to, ownLine } = fenceExtent(text, fence);
  if (!ownLine) return [from, to];
  return lineEnd === text.length ? [Math.max(0, lineStart - 1), text.length] : [lineStart, lineEnd + 1];
}

/** Content-column width of the preceding list item, when a column-0 reference would otherwise end that list. */
function precedingListContentIndent(text: string, lineStart: number): string {
  let end = lineStart;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 2) + 1;
    const line = text.slice(start, end - 1);
    if (line.trim() !== '') {
      const marker = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
      return marker ? ' '.repeat(marker[0].length) : '';
    }
    end = start;
  }
  return '';
}

/** Renders `blockLines` where `fence` stands as a block that starts on its own line and ends before a line break, every line indented to the fence's container so a list item or block quote keeps it. A reference at column 0 borrows the preceding list item's content column. Prose before the fence on its line stays before it; prose after it continues on a new line. */
function placeFenceBlock(
  text: string,
  cursor: number,
  fence: LocatedSqlFence,
  extent: FenceExtent,
  blockLines: readonly string[],
): { out: string; cursor: number } {
  const borrowed = fence.container === '' ? precedingListContentIndent(text, extent.lineStart) : '';
  const indent = borrowed || fence.container.replace(/[^\s>]/g, ' ');
  const ownStart = text.slice(extent.lineStart, extent.from) === fence.container;
  const before = ownStart ? text.slice(cursor, extent.from) : `${text.slice(cursor, extent.from).trimEnd()}\n`;
  const block = blockLines.map((line, index) => (line && (borrowed || index > 0 || !ownStart) ? indent + line : line)).join('\n');
  const after = text.slice(extent.to, extent.lineEnd);
  const rest = after.trimStart();
  if (rest === '') return { out: before + block, cursor: extent.to };
  return { out: `${before}${block}\n${indent}`, cursor: extent.to + after.length - rest.length };
}

/** Expands evidence references in one rendered text field: a ```sql fence whose info string ends in a served id (```` ```sql S7 ```` closed with no body, or the one-line ```` ```sql S7``` ````) is replaced by the captured block. */
export function expandEvidenceRefs(
  text: string,
  blocks: ReadonlyMap<string, EvidenceBlock>,
): { text: string; unknownIds: string[]; normalized: string[]; malformedRefs: string[] } {
  const fences = [...locateSqlFences(text)];
  const byStart = new Map(fences.map(fence => [fence.start, fence]));
  const malformedRefs: string[] = [];
  let coveredUntil = 0;
  for (const marker of text.matchAll(/```sql([^\n`]*)/gi)) {
    if (marker.index < coveredUntil) continue;
    const valid = byStart.get(marker.index);
    if (valid) coveredUntil = valid.end;
    else malformedRefs.push(EVIDENCE_ID_INFO.exec(marker[1])?.[1] ?? 'unlabelled SQL');
  }
  const shown = new Set(fences.filter(fence => fence.lines.length > 0).map(fence => fenceBodyKey(fence.lines)));
  const unknownIds: string[] = [];
  const normalized: string[] = [];
  let out = '';
  let cursor = 0;
  for (const fence of fences) {
    const id = EVIDENCE_ID_INFO.exec(fence.info)?.[1];
    if (!id) continue;
    const block = blocks.get(id);
    if (fence.lines.length > 0) {
      const info = fence.info.slice(0, fence.info.lastIndexOf(id)).trimEnd();
      const extent = fenceExtent(text, fence);
      if (extent.ownLine) {
        const infoStart = fence.start + '```sql'.length;
        out += text.slice(cursor, infoStart) + info;
        cursor = infoStart + fence.info.length;
      } else {
        const placed = placeFenceBlock(text, cursor, fence, extent, [`\`\`\`sql${info}`, ...fence.lines, '```']);
        out += placed.out;
        cursor = placed.cursor;
      }
      normalized.push(`${id} dropped from a fence that carries its own SQL`);
    } else if (!block) {
      unknownIds.push(id);
    } else {
      const blockLines = block.raw.split('\n');
      const key = fenceBodyKey(blockLines.slice(1, -1));
      if (shown.has(key)) {
        const [from, to] = fenceLineSpan(text, fence);
        out += text.slice(cursor, Math.max(cursor, from));
        cursor = to;
        normalized.push(`${id} not rendered — the section already shows that SQL`);
        continue;
      }
      shown.add(key);
      const placed = placeFenceBlock(text, cursor, fence, fenceExtent(text, fence), blockLines);
      out += placed.out;
      cursor = placed.cursor;
    }
  }
  return { text: out + text.slice(cursor), unknownIds, normalized, malformedRefs };
}

/** Builds the rendered description markdown from the AI's structured input parts. */
export function orderAndAssemble(
  sections: Array<{ label: string; node_ids?: string[]; text?: string }>,
  opts?: {
    title?: string;
    intro?: string;
    /** Engine-owned block (e.g. the CT column chain) inserted between the intro and the first section. */
    preface?: string;
    closing?: string;
    /** Optional node lookup for injecting clickable object-link footnotes per section. */
    nodeMap?: Map<string, { id: string; name: string }>;
  },
): {
  badges: Array<{ node_id: string; text: string }>;
  description: string;
  droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }>;
} {
  const uniqueLabels = [...new Set(sections.map(sec => sec.label))];
  const labelToNumber = new Map(uniqueLabels.map((label, i) => [label, i + 1]));

  const nodeToLabel = new Map<string, string>();
  const labelToNodeIds = new Map<string, string[]>();
  const droppedSectionLinks: Array<{ node_id: string; dropped_from: string; kept_in: string }> = [];
  for (const { label, node_ids } of sections) {
    let kept = labelToNodeIds.get(label);
    if (!kept) { kept = []; labelToNodeIds.set(label, kept); }
    for (const id of node_ids ?? []) {
      const owner = nodeToLabel.get(id);
      if (owner !== undefined) {
        if (owner !== label) droppedSectionLinks.push({ node_id: id, dropped_from: label, kept_in: owner });
        continue;
      }
      nodeToLabel.set(id, label);
      kept.push(id);
    }
  }

  const badges = [...nodeToLabel].map(([node_id, label]) => ({ node_id, text: `${labelToNumber.get(label)} ${label}` }));

  const parts: string[] = [];
  if (opts?.title)        parts.push(`# ${opts.title}`);
  if (opts?.intro)        parts.push(opts.intro);
  if (opts?.preface)      parts.push(opts.preface);
  const sectionMap = new Map(sections.map(sec => [sec.label, sec.text]));
  for (const label of uniqueLabels) {
    const n = labelToNumber.get(label)!;
    const text = sectionMap.get(label) ?? '';
    const nodeIds = labelToNodeIds.get(label) ?? [];
    let objectFootnote = '';
    if (opts?.nodeMap && nodeIds.length > 0) {
      const links = nodeIds
        .map(id => opts.nodeMap!.get(id))
        .filter((node): node is { id: string; name: string } => !!node)
        .map(node => `[${node.name}](${FOCUS_NODE_HREF_PREFIX}${encodeFocusNodeId(node.id)})`);
      if (links.length > 0) objectFootnote = `### Objects ${links.join(', ')}`;
    }
    let section = `## ${n} ${label}`;
    if (text)          section += `\n\n${text}`;
    if (objectFootnote) section += `\n\n${objectFootnote}`;
    parts.push(section);
  }
  if (opts?.closing) parts.push(`---\n\n${opts.closing}`);

  return { badges, description: parts.join('\n\n'), droppedSectionLinks };
}

/** One validated CT column-flow edge, reduced to the structural fields the chain table reads. */
type ColumnChainEdge = {
  /** 1-based hop index the edge was traced at. */
  hop: number;
  /** Source node id. */
  from_node: string;
  /** Source column name. */
  from_col: string;
  /** Destination node id. */
  to_node: string;
  /** Destination column name. */
  to_col: string;
  /** Recorded contributor roles; omitted when not established. */
  transforms?: readonly ColumnTransformClass[];
};

/** Formats recorded column relations and retains asked identities without inventing a mapping. */
export function buildColumnChainPreface(
  edges: readonly ColumnChainEdge[],
  requested?: { readonly node: string; readonly columns: readonly string[] },
  identifierCaseSensitive = false,
): string | undefined {
  if (edges.length === 0 && !requested?.columns.length) return undefined;
  const outputs = new Map<string, ColumnChainEdge[]>();
  for (const edge of [...edges].sort((a, b) => a.hop - b.hop)) {
    const key = JSON.stringify([edge.to_node, edge.to_col]);
    const group = outputs.get(key);
    if (group) group.push(edge);
    else outputs.set(key, [edge]);
  }
  const parts = ['## Column Chain'];
  for (const group of outputs.values()) {
    const output = group[0]!;
    parts.push(
      `**Output:** ${columnChainCode(`${output.to_node}.${output.to_col}`)}`,
      [
        '| Source column | Captured at hop | Contributor roles |',
        '| --- | ---: | --- |',
        ...group.map(edge => `| ${columnChainCode(`${edge.from_node}.${edge.from_col}`)} | ${edge.hop} | ${edge.transforms?.map(role => columnChainCode(role)).join(', ') ?? ''} |`),
      ].join('\n'),
    );
  }
  if (requested) {
    const key = (node: string, col: string): string => JSON.stringify([schemaKey(node, identifierCaseSensitive), normalizeColName(col, identifierCaseSensitive)]);
    const represented = new Set(edges.flatMap(edge => [key(edge.from_node, edge.from_col), key(edge.to_node, edge.to_col)]));
    const missing = requested.columns.filter(col => {
      const identity = key(requested.node, col);
      if (represented.has(identity)) return false;
      represented.add(identity);
      return true;
    });
    if (missing.length) parts.push(['| Asked column |', '| --- |', ...missing.map(col => `| ${columnChainCode(`${requested.node}.${col}`)} |`)].join('\n'));
  }
  return parts.join('\n\n');
}

/** Keeps quoted database identifiers inside one code span and one Markdown table cell. */
function columnChainCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const content = value.replace(/\|/g, '\\|');
  const padding = longestRun > 0 ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}

/** Reports which non-pruned nodes the AI left unlinked in both badge-producing surfaces (`sections[].node_ids` and `highlight_groups[].node_ids`) — an observation for the log, never a payload mutation. */
export function findBareNonPrunedNodes(
  resultGraph: {
    node_states?: Array<{ nodeId: string; action: string }>;
  } | null | undefined,
  input: PresentResultInput,
  resolvedNodeIds: string[],
): string[] {
  const sections = input.sections;
  if (!sections || sections.length === 0) return [];
  const resolvedSet = new Set(resolvedNodeIds);
  const prunedIds = new Set(
    (resultGraph?.node_states ?? []).filter(s => s.action === 'prune').map(s => s.nodeId),
  );
  const linked = new Set<string>();
  for (const sec of sections) for (const id of sec.node_ids ?? []) if (resolvedSet.has(id)) linked.add(id);
  for (const g of input.highlight_groups ?? []) for (const id of g.node_ids ?? []) if (resolvedSet.has(id)) linked.add(id);

  return resolvedNodeIds.filter(id => !prunedIds.has(id) && !linked.has(id));
}

/** The detail-slot node ids a present call must link from `sections[].node_ids[]`: the slots whose node is in the rendered set. The synthesis prompt states the rule, the envelope's `detail_slots` carry exactly these nodes, and {@link findUnrenderedDetailSlotIds} enforces it. */
export function requiredDetailSlotIds(
  slotNodeIds: readonly string[],
  renderedNodeIds: ReadonlySet<string>,
): string[] {
  return slotNodeIds.filter(id => renderedNodeIds.has(id));
}

/** The column-chain node ids a present call must cover with a section link or a note: the chain nodes the render keeps that carry no detail slot and are not pruned. The synthesis envelope lists this set and the present handler enforces it, so the served list and the check share one source. */
export function requiredCtChainNodeIds(
  edges: ReadonlyArray<{ from_node: string; to_node: string; hop_node: string }>,
  renderedNodeIds: readonly string[],
  exemptNodeIds: readonly string[],
  keyOf: (id: string) => string,
): string[] {
  if (edges.length === 0) return [];
  const exempt = new Set(exemptNodeIds.map(keyOf));
  const chain = new Set(edges.flatMap(edge => [keyOf(edge.from_node), keyOf(edge.to_node), keyOf(edge.hop_node)]));
  return renderedNodeIds.filter(id => chain.has(keyOf(id)) && !exempt.has(keyOf(id)));
}

/** Reports which delivered `detail_slots[]` reached no rendered section. */
export function findUnrenderedDetailSlotIds(slotNodeIds: readonly string[], input: PresentResultInput): string[] {
  if (!input.sections?.length) return [];
  return unplacedDetailSlotIds(slotNodeIds, new Set(input.sections.flatMap(section => section.node_ids)));
}

/** Shared coverage owner; admission supplies only complete, original-position link facts. */
export function unplacedDetailSlotIds(slotNodeIds: readonly string[], linked: ReadonlySet<string>): string[] {
  return slotNodeIds.filter(id => !linked.has(id));
}

/** Schema-proven references retain their original positions even when another field is invalid. */
export interface PresentReference {
  field: 'sections' | 'notes' | 'highlight_groups';
  heldPath: string;
  path: string;
  nodeId: string;
}
/** Admitted original-position links and whether all coverage dependencies are known. */
export interface PresentReferenceFacts {
  references: readonly PresentReference[];
  coverageKnown: boolean;
}

/** One pure domain inspection; native admission and typed direct callers share these rules. */
export function inspectPresentResult(
  facts: PresentReferenceFacts,
  resolvedNodeIds: string[],
  externalViolations: readonly PresentResultViolation[] = [],
  stage: PresentResultStage = 'completed',
  nodeIdState?: PresentNodeIdStateLookup,
  viewKnown = true,
): ToolRejection | undefined {
  const faults: ToolError[] = [];
  let allRepairable = true;
  const repairFields = new Set<PresentResultRepairField>();
  const issuePaths = new Set<string>();
  /** One fault per error, at its path; `paths` are the held-draft paths it fails. */
  const addError = (
    error: ToolError,
    authorizedFields: readonly PresentResultRepairField[] = [],
    paths: readonly string[] = [],
  ): void => {
    faults.push(error);
    if (authorizedFields.length === 0) allRepairable = false;
    for (const f of authorizedFields) repairFields.add(f);
    for (const path of paths) issuePaths.add(path);
  };

  for (const violation of externalViolations) {
    violation.errors.forEach((error, index) => addError(error, violation.repairFields, index === 0 ? violation.paths : []));
  }

  if (viewKnown && resolvedNodeIds.length === 0) {
    addError({ path: '', code: 'empty_view' });
  }

  const sectionLinkedNodeIds = new Set<string>();

  const resolvedSet = new Set(resolvedNodeIds);
  const nodeIdStateCache = new Map<string, PresentNodeIdState>();
  const stateOf = (nodeId: string): PresentNodeIdState => {
    let state = nodeIdStateCache.get(nodeId);
    if (state === undefined) {
      state = nodeIdState?.(nodeId) ?? 'not_in_model';
      nodeIdStateCache.set(nodeId, state);
    }
    return state;
  };
  /** One fault per unlinkable id, at its element path, by the engine state of the id and never the id (D-102); in a completed run `add_node_ids` brings any in-scope id into view. */
  const addNodeIdError = (field: PresentResultRepairField, heldPath: string, path: string, nodeId: string): void => {
    const state = stateOf(nodeId);
    if (!viewKnown && state !== 'not_in_model' && state !== 'out_of_scope') return;
    const code: IssueCode = state === 'not_in_model' ? 'report_not_found' : state === 'out_of_scope' ? 'result_out_of_scope'
      : stage === 'completed' ? 'addable_to_result' : 'not_in_result';
    if (code === 'addable_to_result') repairFields.add('add_node_ids');
    addError({ path, code, values: [...resolvedNodeIds] }, [field], [heldPath]);
  };

  const noteNodeIds = new Set<string>();
  for (const reference of facts.references) {
    if (!resolvedSet.has(reference.nodeId)) addNodeIdError(reference.field, reference.heldPath, reference.path, reference.nodeId);
    else if (reference.field === 'sections') sectionLinkedNodeIds.add(reference.nodeId);
    else if (reference.field === 'notes') noteNodeIds.add(reference.nodeId);
  }

  // An id an external violation already asks to place in a section (or note) is not repeated with a second repair.
  const alreadyRepairedIds = new Set(externalViolations.flatMap(v => v.entryIds ?? []));
  const unexplainedNodeIds = resolvedNodeIds.filter(id => !sectionLinkedNodeIds.has(id) && !noteNodeIds.has(id) && !alreadyRepairedIds.has(id));
  if (viewKnown && facts.coverageKnown && unexplainedNodeIds.length > 0) {
    addError({ path: 'sections.*.node_ids', code: 'node_unexplained', values: unexplainedNodeIds }, ['sections', 'notes'], ['sections', 'notes']);
  }

  if (faults.length > 0) {
    const resendList = [...repairFields];
    const repairInstructed = allRepairable && resendList.length > 0;
    return makeRejection({
      code: REJECTION_CODES.validation,
      reason: faults.map(fault => `${fault.path}: ${fault.code}`).join('\n'),
      issuePaths: [...issuePaths],
      errors: faults,
      resend: repairInstructed ? resendList : [],
    });
  }

  return undefined;
}

/** Builds the UI request only from a fully admitted report and its prepared assembly. */
export function completePresentResult(
  input: PresentResultInput, resolvedNodeIds: string[],
  assembledBadges: Array<{ node_id: string; text: string }> = [], assembledDescription?: string,
): PresentResultRequest {
  return {
    name: input.name, node_ids: resolvedNodeIds, summary: input.summary,
    description: assembledDescription!, layout_direction: input.layout_direction,
    highlight_groups: input.highlight_groups, badges: assembledBadges, notes: input.notes ?? [],
  };
}

/** Finds nodes that are disconnected from the given origin inside a result view. */
export function findDisconnectedViewNodes(
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<[string, string, string]>,
  originNodeId: string,
): string[] {
  if (!originNodeId || !nodeIds.includes(originNodeId)) return [];
  const graph = new Graph({ type: 'undirected' });
  for (const id of nodeIds) graph.mergeNode(id);
  for (const [source, target] of edges) {
    if (graph.hasNode(source) && graph.hasNode(target)) graph.mergeEdge(source, target);
  }
  const reachable = new Set(connectedComponents(graph).find(component => component.includes(originNodeId)));
  return nodeIds.filter(id => !reachable.has(id)).sort();
}
