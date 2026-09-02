import {
  StartExplorationFreshProviderInputSchema,
  StartExplorationInputSchema,
  StartExplorationProviderInputSchema,
  StartExplorationRefineProviderInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { EntryDetectionSchema } from '../../../src/ai/agent/state';
import { resolveDepthIntent } from '../../../src/ai/sm/smTypes';
import {
  normalizeStartExplorationInput,
  normalizeSubmitFindingsInputIds,
  resolveModelNodeId,
} from '../../../src/ai/support/inputNormalization';
import { redactMissionBriefForLog } from '../../../src/ai/support/missionBriefDiagnostics';
import { buildStartExplorationReject, evaluateAlreadyStartedRule, evaluateScopeBudgetRule } from '../../../src/ai/interaction/rules/startExplorationRules';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';

describe("start-exploration-schema tests", () => {
  it("empty input rejected (missing origin + classification)", () => { expect(!StartExplorationInputSchema.safeParse({}).success, 'empty input rejected (missing origin + classification)').toBe(true); });

  it("empty-string origin rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '' }).success, 'empty-string origin rejected').toBe(true); });

  it("non-string origin rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 123 as any }).success, 'non-string origin rejected').toBe(true); });

  it("undefined input rejected", () => { expect(!StartExplorationInputSchema.safeParse(undefined).success, 'undefined input rejected').toBe(true); });

  it("null input rejected", () => { expect(!StartExplorationInputSchema.safeParse(null).success, 'null input rejected').toBe(true); });

  it("origin without classification/analysisMode rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]' }).success, 'origin without classification/analysisMode rejected').toBe(true); });

  it("fresh origin without analysisMode rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business' }).success, 'fresh origin without analysisMode rejected').toBe(true); });

  it("invalid classification value rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'invalid' as any }).success, 'invalid classification value rejected').toBe(true); });

  const ok = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business' });
  it("origin + analysisMode + classification accepted", () => { expect(ok.success, 'origin + analysisMode + classification accepted').toBe(true); });

  it("origin preserved", () => {
    expect(ok.success, 'origin + analysisMode + classification accepted').toBe(true);
    if (!ok.success) return;
    expect(ok.data.origin === '[s].[t]', 'origin preserved').toBe(true);
    expect(ok.data.analysisMode === 'bb', 'analysisMode preserved').toBe(true);
    expect(ok.data.classification === 'business', 'classification preserved').toBe(true);
    expect(ok.data.direction === undefined, 'direction optional').toBe(true);
  });

  const full = StartExplorationInputSchema.safeParse({
      origin: '[s].[t]',
      question: 'Explain',
      direction: 'upstream',
      excludeTypes: ['function', 'view'],
      mission_brief: 'brief',
      analysisMode: 'ct',
      targetColumns: ['col1'],
      classification: 'both',
    });
  it("full input accepted", () => { expect(full.success, 'full input accepted').toBe(true); });

  const depthValid = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 2 });
  it("depth integer is accepted", () => { expect(depthValid.success && depthValid.data.depth === 2, 'depth integer is accepted').toBe(true); });

  const depthAll = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 'all' });
  it("depth literal \"all\" is accepted", () => { expect(depthAll.success && depthAll.data.depth === 'all', 'depth literal "all" is accepted').toBe(true); });

  const depthInvalid = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 'unbounded' });
  it("depth invalid string is rejected", () => { expect(!depthInvalid.success, 'depth invalid string is rejected').toBe(true); });

  it("invalid direction rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', direction: 'sideways' as any }).success, 'invalid direction rejected').toBe(true); });

  it("entry detection rejects unknown fields", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: null, intentText: 'trace this' }).success, 'entry detection rejects unknown fields').toBe(true); });

  const dvNum = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: '2' });
  it("string \"2\" rejected rather than silently coerced", () => { expect(!dvNum.success, 'string "2" rejected rather than silently coerced').toBe(true); });

  it('quoted depth reject prose names the string-vs-number defect (port-level reject)', () => {
    // Class: a provider emitting a JSON number quoted as a string. The strict reject is by design;
    // the port-level reason must still name the defect (expected number, received string) plus the
    // echoed sent value, or the model regenerates the identical call blind — it never sees a
    // variant-level expected type in the bare field listing.
    const quoted = { origin: 'a', analysisMode: 'bb', classification: 'business', depth: '1' };
    const parsed = StartExplorationInputSchema.safeParse(quoted);
    expect(!parsed.success, 'quoted depth still rejected').toBe(true);
    if (parsed.success) return;
    const { reason } = rejectionFromZodError(parsed.error, { code: 'invalid_tool_input', input: quoted });
    expect(reason.includes('depth: input matched no variant'), 'reason keeps the union verdict with the depth path').toBe(true);
    expect(reason.includes('expected number, received string'), 'reason names the string-vs-number defect').toBe(true);
    expect(reason.includes('sent: "1"'), 'reason echoes the sent value').toBe(true);
  });

  const dvAll = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: 'all' });
  it("'all' literal accepted", () => { expect(dvAll.success && dvAll.data.depth === 'all', "'all' literal accepted").toBe(true); });

  const dvNull = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business' });
  it("omitted depth defaults to undefined (unstated)", () => { expect(dvNull.success && dvNull.data.depth === undefined, 'omitted depth defaults to undefined (unstated)').toBe(true); });

  const dvExplicitNull = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: null });
  it("explicit null depth is accepted and preserved (not coerced to undefined)", () => { expect(dvExplicitNull.success && dvExplicitNull.data.depth === null, 'explicit null depth is accepted and preserved (not coerced to undefined)').toBe(true); });

  it("explicit null depth resolves to the default-start intent, same as omission", () => {
    expect(dvExplicitNull.success, 'explicit null depth is accepted').toBe(true);
    if (!dvExplicitNull.success) return;
    expect(resolveDepthIntent(dvExplicitNull.data.depth).kind === 'default_start', 'explicit null depth resolves to the default-start intent, same as omission').toBe(true);
  });

  it("zero depth rejected (must be positive)", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: 0 }).success, 'zero depth rejected (must be positive)').toBe(true); });

  it("negative depth rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: -1 }).success, 'negative depth rejected').toBe(true); });

  const asymmetric = { upstream: 'all' as const, downstream: 1 };
  const asymParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: asymmetric,
    });
  it("bidirectional asymmetric depth accepted", () => { expect(asymParsed.success, 'bidirectional asymmetric depth accepted').toBe(true); });

  const asymIntent = resolveDepthIntent(asymmetric);
  it("asymmetric depth maps exactly", () => { expect(asymIntent.kind === 'asymmetric' && asymIntent.upstream === 'all' && asymIntent.downstream === 1, 'asymmetric depth maps exactly').toBe(true); });

  it("asymmetric depth requires bidirectional direction", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'upstream', depth: asymmetric }).success, 'asymmetric depth requires bidirectional direction').toBe(true); });

  const partialAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2 } });
  it("partial asymmetric depth (downstream omitted) is accepted", () => { expect(partialAsym.success, 'partial asymmetric depth (downstream omitted) is accepted').toBe(true); });

  it("omitted downstream side resolves to the default of 3, upstream preserved", () => {
    expect(partialAsym.success && !!partialAsym.data.depth && typeof partialAsym.data.depth === 'object', 'partial asymmetric depth parses to an asymmetric depth object').toBe(true);
    if (!(partialAsym.success && partialAsym.data.depth && typeof partialAsym.data.depth === 'object')) return;
    const partialIntent = resolveDepthIntent(partialAsym.data.depth);
    expect(partialIntent.kind === 'asymmetric' && partialIntent.upstream === 2 && partialIntent.downstream === 3, 'omitted downstream side resolves to the default of 3, upstream preserved').toBe(true);
  });

  const nullSideAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2, downstream: null } });
  it("explicit null on one asymmetric side is accepted (same as omission)", () => { expect(nullSideAsym.success, 'explicit null on one asymmetric side is accepted (same as omission)').toBe(true); });

  const emptyAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: {} });
  it("fully empty asymmetric object is accepted (both sides default to 3)", () => { expect(emptyAsym.success, 'fully empty asymmetric object is accepted (both sides default to 3)').toBe(true); });

  it("unknown asymmetric depth key rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2, downstream: 1, extra: 3 } }).success, 'unknown asymmetric depth key rejected').toBe(true); });

  it("fresh origin and supplement conflict rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', supplement: { nodeIds: ['b'] } }).success, 'fresh origin and supplement conflict rejected').toBe(true); });

  const upstreamOnly = { upstream: 2, downstream: 0 };
  const upstreamOnlyParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: upstreamOnly,
    });
  it("{upstream:2,downstream:0} accepted with direction omitted (implicit bidirectional default)", () => { expect(upstreamOnlyParsed.success, '{upstream:2,downstream:0} accepted with direction omitted (implicit bidirectional default)').toBe(true); });

  const upstreamOnlyIntent = resolveDepthIntent(upstreamOnly);
  it("per-side zero maps exactly through resolveDepthIntent", () => { expect(upstreamOnlyIntent.kind === 'asymmetric' && upstreamOnlyIntent.upstream === 2 && upstreamOnlyIntent.downstream === 0, 'per-side zero maps exactly through resolveDepthIntent').toBe(true); });

  it("{upstream:2,downstream:0} accepted with direction explicitly bidirectional", () => { expect(StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: upstreamOnly }).success, '{upstream:2,downstream:0} accepted with direction explicitly bidirectional').toBe(true); });

  it("asymmetric depth with a per-side zero still requires bidirectional direction (explicit non-bidirectional rejected)", () => { expect(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'upstream', depth: upstreamOnly }).success, 'asymmetric depth with a per-side zero still requires bidirectional direction (explicit non-bidirectional rejected)').toBe(true); });

  const bothZeroParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: { upstream: 0, downstream: 0 },
    });
  it("{upstream:0,downstream:0} rejected (empty scope)", () => { expect(!bothZeroParsed.success, '{upstream:0,downstream:0} rejected (empty scope)').toBe(true); });

  it("both-zero rejection carries the structural startIssue code", () => {
    expect(!bothZeroParsed.success, '{upstream:0,downstream:0} rejected (empty scope)').toBe(true);
    if (bothZeroParsed.success) return;
    const bothZeroTag = bothZeroParsed.error.issues.find(i => i.code === 'custom')?.params?.startIssue;
    expect(bothZeroTag, 'both-zero rejection carries the structural startIssue code').toBe('asymmetric_depth_both_zero');
    const bothZeroReject = buildStartExplorationReject(bothZeroParsed.error);
    expect(bothZeroReject.error, 'both-zero rejection envelope carries the dedicated mapStartIssue mapping').toBe('asymmetric_depth_both_zero');
    const bothZeroDetail = bothZeroReject.detail as { issues?: Array<{ message: string }> } | undefined;
    expect(bothZeroDetail?.issues?.[0]?.message, 'both-zero rejection envelope preserves the exact refine message').toBe('Asymmetric depth cannot be 0 in both directions.');
  });

  const allAndZeroParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: { upstream: 'all' as const, downstream: 0 },
    });
  it("{upstream:'all',downstream:0} accepted (full upstream frontier, downstream suppressed)", () => { expect(allAndZeroParsed.success, "{upstream:'all',downstream:0} accepted (full upstream frontier, downstream suppressed)").toBe(true); });

  it("provider fresh-BB branch accepts asymmetric per-side-zero depth with direction omitted", () => { expect(StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: upstreamOnly }).success, 'provider fresh-BB branch accepts asymmetric per-side-zero depth with direction omitted').toBe(true); });

  it("provider fresh-BB branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { expect(!StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'downstream', depth: upstreamOnly }).success, 'provider fresh-BB branch rejects asymmetric depth paired with an explicit non-bidirectional direction').toBe(true); });

  it("provider fresh-CT branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { expect(!StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'ct', classification: 'business', targetColumns: ['Col'], direction: 'upstream', depth: upstreamOnly }).success, 'provider fresh-CT branch rejects asymmetric depth paired with an explicit non-bidirectional direction').toBe(true); });

  it("provider refine branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { expect(!StartExplorationProviderInputSchema.safeParse({ origin: 'a', proposalRevision: 1, direction: 'downstream', depth: upstreamOnly }).success, 'provider refine branch rejects asymmetric depth paired with an explicit non-bidirectional direction').toBe(true); });

  // Turn 14 (T14/A30) attempt 1, verbatim from turn-14-0b0d92e0.ndjson: a quoted digit on one
  // side of an asymmetric depth, next to the quoted literal "all" on the other side.
  const turn14Attempt1 = {
    analysisMode: 'bb', classification: 'business',
    depth: { downstream: '1', upstream: 'all' },
    direction: 'bidirectional', excludeNodeIds: [],
    mission_brief: "Trace all upstream sources that feed [ai].[spImportOrders] and one level of downstream dependents, per the user's request.",
    origin: '[ai].[spImportOrders]',
    question: 'What objects feed [ai].[spImportOrders] from every source layer, and which objects does it directly affect one step downstream?',
  };
  const turn14Parsed = StartExplorationInputSchema.safeParse(turn14Attempt1);
  it("turn 14 attempt 1 (quoted downstream depth) now validates", () => { expect(turn14Parsed.success, 'turn 14 attempt 1 (quoted downstream depth) now validates').toBe(true); });
  it("turn 14 attempt 1 depth coerces to numeric downstream, literal upstream", () => {
    expect(turn14Parsed.success && !!turn14Parsed.data.depth && typeof turn14Parsed.data.depth === 'object', 'turn 14 attempt 1 parses to an asymmetric depth object').toBe(true);
    if (!(turn14Parsed.success && turn14Parsed.data.depth && typeof turn14Parsed.data.depth === 'object')) return;
    expect((turn14Parsed.data.depth as { downstream: unknown }).downstream, 'downstream coerces from "1" to 1').toBe(1);
    expect((turn14Parsed.data.depth as { upstream: unknown }).upstream, 'upstream stays the literal "all"').toBe('all');
  });
  it("turn 14 attempt 1 validates against the exact production fresh-BB dispatch schema", () => { expect(StartExplorationFreshProviderInputSchema.safeParse(turn14Attempt1).success, 'turn 14 attempt 1 validates against the exact production fresh-BB dispatch schema').toBe(true); });

  // Attempts 2 and 3 regressed to a pseudo-XML-encoded depth string; the numeric-string coercion
  // must not accept it — the whole field is a string, never structurally a number, "all", or the
  // asymmetric {upstream,downstream} object.
  const turn14Attempt2Depth = '<downstream>1</downstream><upstream>all</upstream>';
  const turn14Attempt3Depth = '<upstream>all</upstream><downstream>1</downstream>';
  it("turn 14 attempt 2 pseudo-XML depth string is still rejected", () => { expect(!StartExplorationInputSchema.safeParse({ ...turn14Attempt1, depth: turn14Attempt2Depth }).success, 'turn 14 attempt 2 pseudo-XML depth string is still rejected').toBe(true); });
  it("turn 14 attempt 3 pseudo-XML depth string (reordered) is still rejected", () => { expect(!StartExplorationInputSchema.safeParse({ ...turn14Attempt1, depth: turn14Attempt3Depth }).success, 'turn 14 attempt 3 pseudo-XML depth string (reordered) is still rejected').toBe(true); });

  // R1: a payload that already validates today must parse identically, byte for byte, with no
  // coercion applied — the numeric branch only ever substitutes a value for a rejected parse.
  const alreadyValidAsymmetric = { origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2, downstream: 3 } };
  const alreadyValidParsed = StartExplorationInputSchema.safeParse(alreadyValidAsymmetric);
  it("an already-valid numeric asymmetric depth is preserved untouched", () => { expect(alreadyValidParsed.success
    && (alreadyValidParsed.data.depth as { upstream: unknown; downstream: unknown }).upstream === 2
    && (alreadyValidParsed.data.depth as { upstream: unknown; downstream: unknown }).downstream === 3, 'an already-valid numeric asymmetric depth is preserved untouched').toBe(true); });

  it("refine-only provider schema accepts only the revision and changed exclusions", () => { expect(StartExplorationRefineProviderInputSchema.safeParse({
      proposalRevision: 1,
      excludeNodeIds: ['[dbo].[DimCalendar]'],
    }).success, 'refine-only provider schema accepts a minimal revision-bound exclusion patch').toBe(true); });

  it("refine-only provider schema rejects fresh-entry fields that are not changing", () => { expect(!StartExplorationRefineProviderInputSchema.safeParse({
      proposalRevision: 1,
      origin: '[dbo].[FactSalesReport]',
      analysisMode: 'bb',
      classification: 'business',
      unexpected: true,
    }).success, 'refine-only provider schema remains strict').toBe(true); });

  it("CT requires targetColumns", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business' }).success, 'CT requires targetColumns').toBe(true); });

  it("BB with named targetColumns rejected (mode/field conflict)", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: ['TotalDue'] }).success, 'BB with named targetColumns rejected (mode/field conflict)').toBe(true); });

  it("canonical BB domain payload rejects even an empty targetColumns property", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: [] }).success, 'canonical BB domain payload rejects even an empty targetColumns property').toBe(true); });

  const rawBb = { origin: '[s].[t]', analysisMode: 'bb' as const, classification: 'business', targetColumns: [] as string[] };
  const normalizedBb = normalizeStartExplorationInput(rawBb, 'bb');
  it("provider BB [] normalizes to property absence", () => { expect(!('targetColumns' in normalizedBb.input), 'provider BB [] normalizes to property absence').toBe(true); });

  it("normalization does not mutate raw model input", () => { expect('targetColumns' in rawBb, 'normalization does not mutate raw model input').toBe(true); });

  it("normalization emits a stable debug reason", () => { expect(normalizedBb.normalizations[0]?.reason === 'empty_bb_array_to_absence', 'normalization emits a stable debug reason').toBe(true); });

  const providerBb = StartExplorationProviderInputSchema.safeParse(rawBb);
  it("provider accepts the documented BB [] artifact for observable dispatcher normalization", () => { expect(providerBb.success && 'targetColumns' in providerBb.data, 'provider accepts the documented BB [] artifact for observable dispatcher normalization').toBe(true); });

  const azureCombinedArtifact = {
      origin: '[ai].[raworderimport]', question: 'find references', proposalRevision: 1,
      analysisMode: 'bb', targetColumns: [], direction: 'downstream', depth: 3,
      excludeTypes: [], excludeSchemas: [], excludeNodeIds: [], passNodeIds: [],
      classification: 'technical', supplement: { nodeIds: ['[ai].[raworderimport]'] },
    };
  it("exact Azure fresh/refine/supplement artifact is rejected by canonical branch schema", () => { expect(!StartExplorationProviderInputSchema.safeParse(azureCombinedArtifact).success, 'exact Azure fresh/refine/supplement artifact is rejected by canonical branch schema').toBe(true); });

  const namedBb = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: ['TotalDue'] });
  it("named BB conflict preserves semantic rejection code", () => { expect(!namedBb.success && buildStartExplorationReject(namedBb.error).error === 'ct_field_forbidden_in_bb', 'named BB conflict preserves semantic rejection code').toBe(true); });

  const invalidMode = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'wrong', classification: 'business' });
  it("invalid mode maps to invalid_enum", () => { expect(!invalidMode.success && buildStartExplorationReject(invalidMode.error, { origin: '[s].[t]', analysisMode: 'wrong', classification: 'business' }).error === 'invalid_enum', 'invalid mode maps to invalid_enum').toBe(true); });

  // A3: one owner for the answer-angle rule. Every branch that carries `classification` projects
  // the same describe string, so a model never sees two versions of how to pick the value, and
  // data quality — which the AI cannot inspect — never appears as a selector.
  const classificationDescriptions = [
    StartExplorationInputSchema,
    StartExplorationFreshProviderInputSchema,
  ].map(schema => {
    const projected = toModelJsonSchema(schema) as { properties?: Record<string, { description?: string }> };
    return projected.properties?.classification?.description ?? '';
  });
  it("both classification fields advertise one describe string", () => { expect(new Set(classificationDescriptions).size === 1, 'both classification fields advertise one describe string').toBe(true); });

  it("the classification describe states the selection rule", () => { expect(/business.*unless.*technical lens/is.test(classificationDescriptions[0] ?? ''), 'the classification describe states the selection rule').toBe(true); });

  it("the classification describe names no data-quality selector", () => { expect(!(classificationDescriptions[0] ?? '').includes('data-quality'), 'the classification describe names no data-quality selector').toBe(true); });

  const missingClassification = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb' });
  it("omitted required classification maps to missing_field", () => { expect(!missingClassification.success && buildStartExplorationReject(missingClassification.error, { origin: '[s].[t]', analysisMode: 'bb' }).error === 'missing_field', 'omitted required classification maps to missing_field').toBe(true); });

  const unknownField = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', surprise: true });
  it("unknown strict key maps to unknown_field", () => { expect(!unknownField.success && buildStartExplorationReject(unknownField.error).error === 'unknown_field', 'unknown strict key maps to unknown_field').toBe(true); });

  const missingCt = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business' });
  it("CT recovery gives one mode-preserving action", () => { expect(!missingCt.success && buildStartExplorationReject(missingCt.error).hint === 'Provide at least one named targetColumns value and resubmit CT.', 'CT recovery gives one mode-preserving action').toBe(true); });

  it("wildcard \"*\" target column rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['*'] }).success, 'wildcard "*" target column rejected').toBe(true); });

  it("SQL-wildcard \"%\" target column rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['Total%'] }).success, 'SQL-wildcard "%" target column rejected').toBe(true); });

  it("whitespace-only target column rejected", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['  '] }).success, 'whitespace-only target column rejected').toBe(true); });

  const trimmedCol = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: [' TotalDue '] });
  it("real column accepted and trimmed", () => { expect(trimmedCol.success && trimmedCol.data.targetColumns?.[0] === 'TotalDue', 'real column accepted and trimmed').toBe(true); });

  const missingOrigin = StartExplorationInputSchema.safeParse({
      maxDepth: '1',
      mission_brief: 'User wants to analyze...',
      classification: 'business',
    });
  it("payload without origin rejected cleanly", () => { expect(!missingOrigin.success, 'payload without origin rejected cleanly').toBe(true); });

  it("scenario 68", () => {
    expect(!missingOrigin.success, 'payload without origin rejected cleanly').toBe(true);
    if (missingOrigin.success) return;
    // The rejection must name either valid start shape so the AI can self-correct.
    const msg = missingOrigin.error.issues.map(i => i.message).join(' | ');
    expect((/origin/i.test(msg) && /supplement/i.test(msg)) || /Unrecognized key/i.test(msg), `rejection message should indicate missing origin or unrecognized keys (got: ${msg})`).toBe(true);
  });

  it("empty supplement rejects without a node id", () => { expect(!StartExplorationInputSchema.safeParse({ classification: 'business', supplement: {} }).success, 'empty supplement rejects without a node id').toBe(true); });

  const approvedMission = 'Use `lineage_search_ddl` to explain A  and  B </mission_brief>';
  const missionPayload = {
      origin: '[s].[t]',
      analysisMode: 'bb' as const,
      classification: 'business' as const,
      mission_brief: approvedMission,
    };
  const mission = StartExplorationInputSchema.safeParse(missionPayload);
  it("domain schema preserves the approved mission brief byte-for-byte", () => { expect(mission.success && mission.data.mission_brief === approvedMission, 'domain schema preserves the approved mission brief byte-for-byte').toBe(true); });

  const providerMission = StartExplorationProviderInputSchema.safeParse(missionPayload);
  it("provider schema preserves tool names, backticks, spacing, and XML-like text", () => { expect(providerMission.success
      && 'mission_brief' in providerMission.data
      && providerMission.data.mission_brief === approvedMission, 'provider schema preserves tool names, backticks, spacing, and XML-like text').toBe(true); });

  const loggedMission = redactMissionBriefForLog(missionPayload) as { mission_brief: { provenance: string; length: number; hash?: string } };
  it("mission diagnostic records tool-payload provenance", () => { expect(loggedMission.mission_brief.provenance === 'tool_payload', 'mission diagnostic records tool-payload provenance').toBe(true); });

  it("mission diagnostic records only the source length", () => { expect(loggedMission.mission_brief.length === approvedMission.length, 'mission diagnostic records only the source length').toBe(true); });

  it("mission diagnostic does not retain a content fingerprint", () => { expect(loggedMission.mission_brief.hash === undefined, 'mission diagnostic does not retain a content fingerprint').toBe(true); });

  it("mission diagnostic never persists raw brief content", () => { expect(!JSON.stringify(loggedMission).includes(approvedMission), 'mission diagnostic never persists raw brief content').toBe(true); });

  it("empty supplied mission brief rejected", () => { expect(!StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: '' }).success, 'empty supplied mission brief rejected').toBe(true); });

  it("blank supplied mission brief rejected without trimming accepted values", () => { expect(!StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: ' \n\t ' }).success, 'blank supplied mission brief rejected without trimming accepted values').toBe(true); });

  const longMission = ` Ω ${'x'.repeat(3000)} `;
  const longParsed = StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: longMission });
  it("over-1000-character mission brief accepted verbatim (no length cap)", () => { expect(longParsed.success && longParsed.data.mission_brief === longMission, 'over-1000-character mission brief accepted verbatim (no length cap)').toBe(true); });

  const nodeMap = new Map<string, unknown>([
      ['[dbo].[factsales]', { id: '[dbo].[factsales]' }],
      ['[sales].[daily report]', { id: '[sales].[daily report]' }],
    ]);
  it("canonical bracketed mixed-case id resolves", () => { expect(resolveModelNodeId('[dbo].[FactSales]', nodeMap) === '[dbo].[factsales]', 'canonical bracketed mixed-case id resolves').toBe(true); });

  it("unbracketed schema.name id resolves to canonical id", () => { expect(resolveModelNodeId('dbo.FactSales', nodeMap) === '[dbo].[factsales]', 'unbracketed schema.name id resolves to canonical id').toBe(true); });

  it("bracketed id with spaces resolves", () => { expect(resolveModelNodeId('[sales].[daily report]', nodeMap) === '[sales].[daily report]', 'bracketed id with spaces resolves').toBe(true); });

  it("unbracketed id with spaces resolves", () => { expect(resolveModelNodeId('sales.daily report', nodeMap) === '[sales].[daily report]', 'unbracketed id with spaces resolves').toBe(true); });

  it("unknown id remains unresolved after normalization", () => { expect(resolveModelNodeId('dbo.DoesNotExist', nodeMap) === null, 'unknown id remains unresolved after normalization').toBe(true); });

  const rawSubmitInput = {
      focus_node_id: 'dbo.FactSales',
      sections: [{ angle: 'business', text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
      prune_neighbors: ['sales.daily report', 'dbo.DoesNotExist'],
      route_requests: [{ nodeId: 'dbo.FactSales', question: 'trace' }],
    };
  const normalizedSubmit = normalizeSubmitFindingsInputIds(rawSubmitInput, nodeMap);
  it("submit_findings normalization canonicalizes focus_node_id in cloned input", () => { expect(normalizedSubmit.input.focus_node_id === '[dbo].[factsales]', 'submit_findings normalization canonicalizes focus_node_id in cloned input').toBe(true); });

  it("submit_findings normalization canonicalizes known prune ids and preserves unknown ids for rejection", () => { expect(Array.isArray(normalizedSubmit.input.prune_neighbors) &&
      normalizedSubmit.input.prune_neighbors[0] === '[sales].[daily report]' &&
      normalizedSubmit.input.prune_neighbors[1] === 'dbo.DoesNotExist', 'submit_findings normalization canonicalizes known prune ids and preserves unknown ids for rejection').toBe(true); });

  it("submit_findings normalization canonicalizes route_requests nodeId", () => { expect(Array.isArray(normalizedSubmit.input.route_requests) &&
      (normalizedSubmit.input.route_requests[0] as { nodeId?: string }).nodeId === '[dbo].[factsales]', 'submit_findings normalization canonicalizes route_requests nodeId').toBe(true); });

  it("submit_findings normalization does not mutate raw model input", () => { expect(rawSubmitInput.focus_node_id === 'dbo.FactSales', 'submit_findings normalization does not mutate raw model input').toBe(true); });

  it("submit_findings normalization records every changed id", () => { expect(normalizedSubmit.normalizations.length === 3, 'submit_findings normalization records every changed id').toBe(true); });

  const activeRecovery = evaluateAlreadyStartedRule(true, true, false);
  it("active duplicate start rejected", () => { expect(activeRecovery?.error === 'already_started', 'active duplicate start rejected').toBe(true); });

  it("active duplicate start points to submit_findings", () => { expect(activeRecovery?.next_action === 'submit_findings', 'active duplicate start points to submit_findings').toBe(true); });

  const budgetRecovery = evaluateScopeBudgetRule(28, 1, 2);
  it("oversized scope rejected by round budget", () => { expect(budgetRecovery?.error === 'scope_exceeds_budget', 'oversized scope rejected by round budget').toBe(true); });

  it("budget recovery points to structural narrowing", () => { expect(budgetRecovery?.next_action === 'narrow_scope', 'budget recovery points to structural narrowing').toBe(true); });

  it("budget hint offers structural narrowing", () => { expect((budgetRecovery?.hint ?? '').includes('excludeSchemas/excludeNodeIds'), 'budget hint offers structural narrowing').toBe(true); });

  it("budget hint frames narrowing as a user question", () => { expect((budgetRecovery?.hint ?? '').includes('ask the user'), 'budget hint frames narrowing as a user question').toBe(true); });

  it("budget hint forbids inventing a depth", () => { expect((budgetRecovery?.hint ?? '').includes('Do not invent a depth'), 'budget hint forbids inventing a depth').toBe(true); });

  it("budget hint never proposes an engine depth number", () => { expect(!(budgetRecovery?.hint ?? '').includes('depth='), 'budget hint never proposes an engine depth number').toBe(true); });

});
