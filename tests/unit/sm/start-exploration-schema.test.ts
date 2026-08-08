import { assert, assertEq } from '../helpers/testUtils';
import {
  StartExplorationInputSchema,
  StartExplorationProviderInputSchema,
  StartExplorationRefineProviderInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { EntryDetectionSchema } from '../../../src/ai/agent/state';
import { resolveDepthIntent } from '../../../src/ai/sm/smTypes';
import {
  normalizeStartExplorationInput,
  normalizeSubmitFindingsInputIds,
  resolveModelNodeId,
} from '../../../src/ai/support/inputNormalization';
import { redactMissionBriefForLog } from '../../../src/ai/support/missionBriefDiagnostics';
import { buildStartExplorationReject, evaluateAlreadyStartedRule, evaluateScopeBudgetRule } from '../../../src/ai/interaction/rules/startExplorationRules';
import { describe, it } from 'vitest';

describe("start-exploration-schema tests", () => {
  it("empty input rejected (missing origin + classification)", () => { assert(!StartExplorationInputSchema.safeParse({}).success, 'empty input rejected (missing origin + classification)'); });

  it("empty-string origin rejected", () => { assert(!StartExplorationInputSchema.safeParse({ origin: '' }).success, 'empty-string origin rejected'); });

  it("non-string origin rejected", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 123 as any }).success, 'non-string origin rejected'); });

  it("undefined input rejected", () => { assert(!StartExplorationInputSchema.safeParse(undefined as any).success, 'undefined input rejected'); });

  it("null input rejected", () => { assert(!StartExplorationInputSchema.safeParse(null as any).success, 'null input rejected'); });

  it("origin without classification/analysisMode rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]' }).success,
    'origin without classification/analysisMode rejected',
  ); });

  it("fresh origin without analysisMode rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business' }).success,
    'fresh origin without analysisMode rejected',
  ); });

  it("invalid classification value rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'invalid' as any }).success,
    'invalid classification value rejected',
  ); });

  const ok = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business' });
  it("origin + analysisMode + classification accepted", () => { assert(ok.success, 'origin + analysisMode + classification accepted'); });

  it("origin preserved", () => { if (ok.success) {
    assert(ok.data.origin === '[s].[t]', 'origin preserved');
    assert(ok.data.analysisMode === 'bb', 'analysisMode preserved');
    assert(ok.data.classification === 'business', 'classification preserved');
    assert(ok.data.direction === undefined, 'direction optional');
  } });

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
  it("full input accepted", () => { assert(full.success, 'full input accepted'); });

  const depthValid = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 2 });
  it("depth integer is accepted", () => { assert(depthValid.success && depthValid.data.depth === 2, 'depth integer is accepted'); });

  const depthAll = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 'all' });
  it("depth literal \"all\" is accepted", () => { assert(depthAll.success && depthAll.data.depth === 'all', 'depth literal "all" is accepted'); });

  const depthInvalid = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', depth: 'unbounded' });
  it("depth invalid string is rejected", () => { assert(!depthInvalid.success, 'depth invalid string is rejected'); });

  it("invalid direction rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', direction: 'sideways' as any }).success,
    'invalid direction rejected',
  ); });

  it("entry detection rejects unknown fields", () => { assert(
    !EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: null, intentText: 'trace this' }).success,
    'entry detection rejects unknown fields',
  ); });

  const dvNum = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: '2' });
  it("string \"2\" rejected rather than silently coerced", () => { assert(!dvNum.success, 'string "2" rejected rather than silently coerced'); });

  const dvAll = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: 'all' });
  it("'all' literal accepted", () => { assert(dvAll.success && dvAll.data.depth === 'all', "'all' literal accepted"); });

  const dvNull = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business' });
  it("omitted depth defaults to undefined (unstated)", () => { assert(dvNull.success && dvNull.data.depth === undefined, 'omitted depth defaults to undefined (unstated)'); });

  const dvExplicitNull = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: null });
  it("explicit null depth is accepted and preserved (not coerced to undefined)", () => { assert(dvExplicitNull.success && dvExplicitNull.data.depth === null, 'explicit null depth is accepted and preserved (not coerced to undefined)'); });

  it("explicit null depth resolves to the default-start intent, same as omission", () => { if (dvExplicitNull.success) {
    assert(resolveDepthIntent(dvExplicitNull.data.depth).kind === 'default_start', 'explicit null depth resolves to the default-start intent, same as omission');
  } });

  it("zero depth rejected (must be positive)", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: 0 }).success, 'zero depth rejected (must be positive)'); });

  it("negative depth rejected", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: -1 }).success, 'negative depth rejected'); });

  const asymmetric = { upstream: 'all' as const, downstream: 1 };
  const asymParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: asymmetric,
    });
  it("bidirectional asymmetric depth accepted", () => { assert(asymParsed.success, 'bidirectional asymmetric depth accepted'); });

  const asymIntent = resolveDepthIntent(asymmetric);
  it("asymmetric depth maps exactly", () => { assert(asymIntent.kind === 'asymmetric' && asymIntent.upstream === 'all' && asymIntent.downstream === 1, 'asymmetric depth maps exactly'); });

  it("asymmetric depth requires bidirectional direction", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'upstream', depth: asymmetric }).success, 'asymmetric depth requires bidirectional direction'); });

  const partialAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2 } });
  it("partial asymmetric depth (downstream omitted) is accepted", () => { assert(partialAsym.success, 'partial asymmetric depth (downstream omitted) is accepted'); });

  it("omitted downstream side resolves to the default of 3, upstream preserved", () => { if (partialAsym.success && partialAsym.data.depth && typeof partialAsym.data.depth === 'object') {
    const partialIntent = resolveDepthIntent(partialAsym.data.depth);
    assert(
      partialIntent.kind === 'asymmetric' && partialIntent.upstream === 2 && partialIntent.downstream === 3,
      'omitted downstream side resolves to the default of 3, upstream preserved',
    );
  } });

  const nullSideAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2, downstream: null } });
  it("explicit null on one asymmetric side is accepted (same as omission)", () => { assert(nullSideAsym.success, 'explicit null on one asymmetric side is accepted (same as omission)'); });

  const emptyAsym = StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: {} });
  it("fully empty asymmetric object is accepted (both sides default to 3)", () => { assert(emptyAsym.success, 'fully empty asymmetric object is accepted (both sides default to 3)'); });

  it("unknown asymmetric depth key rejected", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: { upstream: 2, downstream: 1, extra: 3 } }).success, 'unknown asymmetric depth key rejected'); });

  it("fresh origin and supplement conflict rejected", () => { assert(!StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', supplement: { nodeIds: ['b'] } }).success, 'fresh origin and supplement conflict rejected'); });

  const upstreamOnly = { upstream: 2, downstream: 0 };
  const upstreamOnlyParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: upstreamOnly,
    });
  it("{upstream:2,downstream:0} accepted with direction omitted (implicit bidirectional default)", () => { assert(upstreamOnlyParsed.success, '{upstream:2,downstream:0} accepted with direction omitted (implicit bidirectional default)'); });

  const upstreamOnlyIntent = resolveDepthIntent(upstreamOnly);
  it("per-side zero maps exactly through resolveDepthIntent", () => { assert(upstreamOnlyIntent.kind === 'asymmetric' && upstreamOnlyIntent.upstream === 2 && upstreamOnlyIntent.downstream === 0, 'per-side zero maps exactly through resolveDepthIntent'); });

  it("{upstream:2,downstream:0} accepted with direction explicitly bidirectional", () => { assert(
    StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'bidirectional', depth: upstreamOnly }).success,
    '{upstream:2,downstream:0} accepted with direction explicitly bidirectional',
  ); });

  it("asymmetric depth with a per-side zero still requires bidirectional direction (explicit non-bidirectional rejected)", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'upstream', depth: upstreamOnly }).success,
    'asymmetric depth with a per-side zero still requires bidirectional direction (explicit non-bidirectional rejected)',
  ); });

  const bothZeroParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: { upstream: 0, downstream: 0 },
    });
  it("{upstream:0,downstream:0} rejected (empty scope)", () => { assert(!bothZeroParsed.success, '{upstream:0,downstream:0} rejected (empty scope)'); });

  it("both-zero rejection carries the structural startIssue code", () => { if (!bothZeroParsed.success) {
    const bothZeroTag = bothZeroParsed.error.issues.find(i => i.code === 'custom')?.params?.startIssue;
    assertEq(bothZeroTag, 'asymmetric_depth_both_zero', 'both-zero rejection carries the structural startIssue code');
    const bothZeroReject = buildStartExplorationReject(bothZeroParsed.error);
    assertEq(bothZeroReject.error, 'asymmetric_depth_both_zero', 'both-zero rejection envelope carries the dedicated mapStartIssue mapping');
    const bothZeroDetail = bothZeroReject.detail as { issues?: Array<{ message: string }> } | undefined;
    assertEq(bothZeroDetail?.issues?.[0]?.message, 'Asymmetric depth cannot be 0 in both directions.', 'both-zero rejection envelope preserves the exact refine message');
  } });

  const allAndZeroParsed = StartExplorationInputSchema.safeParse({
      origin: 'a', analysisMode: 'bb', classification: 'business', depth: { upstream: 'all' as const, downstream: 0 },
    });
  it("{upstream:'all',downstream:0} accepted (full upstream frontier, downstream suppressed)", () => { assert(allAndZeroParsed.success, "{upstream:'all',downstream:0} accepted (full upstream frontier, downstream suppressed)"); });

  it("provider fresh-BB branch accepts asymmetric per-side-zero depth with direction omitted", () => { assert(
    StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', depth: upstreamOnly }).success,
    'provider fresh-BB branch accepts asymmetric per-side-zero depth with direction omitted',
  ); });

  it("provider fresh-BB branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { assert(
    !StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'bb', classification: 'business', direction: 'downstream', depth: upstreamOnly }).success,
    'provider fresh-BB branch rejects asymmetric depth paired with an explicit non-bidirectional direction',
  ); });

  it("provider fresh-CT branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { assert(
    !StartExplorationProviderInputSchema.safeParse({ origin: 'a', analysisMode: 'ct', classification: 'business', targetColumns: ['Col'], direction: 'upstream', depth: upstreamOnly }).success,
    'provider fresh-CT branch rejects asymmetric depth paired with an explicit non-bidirectional direction',
  ); });

  it("provider refine branch rejects asymmetric depth paired with an explicit non-bidirectional direction", () => { assert(
    !StartExplorationProviderInputSchema.safeParse({ origin: 'a', proposalRevision: 1, direction: 'downstream', depth: upstreamOnly }).success,
    'provider refine branch rejects asymmetric depth paired with an explicit non-bidirectional direction',
  ); });

  it("refine-only provider schema accepts only the revision and changed exclusions", () => { assert(
    StartExplorationRefineProviderInputSchema.safeParse({
      proposalRevision: 1,
      excludeNodeIds: ['[dbo].[DimCalendar]'],
    }).success,
    'refine-only provider schema accepts a minimal revision-bound exclusion patch',
  ); });

  it("refine-only provider schema rejects fresh-entry fields that are not changing", () => { assert(
    !StartExplorationRefineProviderInputSchema.safeParse({
      proposalRevision: 1,
      origin: '[dbo].[FactSalesReport]',
      analysisMode: 'bb',
      classification: 'business',
      unexpected: true,
    }).success,
    'refine-only provider schema remains strict',
  ); });

  it("CT requires targetColumns", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business' }).success,
    'CT requires targetColumns',
  ); });

  it("BB with named targetColumns rejected (mode/field conflict)", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: ['TotalDue'] }).success,
    'BB with named targetColumns rejected (mode/field conflict)',
  ); });

  it("canonical BB domain payload rejects even an empty targetColumns property", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: [] }).success,
    'canonical BB domain payload rejects even an empty targetColumns property',
  ); });

  const rawBb = { origin: '[s].[t]', analysisMode: 'bb' as const, classification: 'business', targetColumns: [] as string[] };
  const normalizedBb = normalizeStartExplorationInput(rawBb, 'bb');
  it("provider BB [] normalizes to property absence", () => { assert(!('targetColumns' in normalizedBb.input), 'provider BB [] normalizes to property absence'); });

  it("normalization does not mutate raw model input", () => { assert('targetColumns' in rawBb, 'normalization does not mutate raw model input'); });

  it("normalization emits a stable debug reason", () => { assert(normalizedBb.normalizations[0]?.reason === 'empty_bb_array_to_absence', 'normalization emits a stable debug reason'); });

  const providerBb = StartExplorationProviderInputSchema.safeParse(rawBb);
  it("provider accepts the documented BB [] artifact for observable dispatcher normalization", () => { assert(providerBb.success && 'targetColumns' in providerBb.data, 'provider accepts the documented BB [] artifact for observable dispatcher normalization'); });

  const azureCombinedArtifact = {
      origin: '[ai].[raworderimport]', question: 'find references', proposalRevision: 1,
      analysisMode: 'bb', targetColumns: [], direction: 'downstream', depth: 3,
      excludeTypes: [], excludeSchemas: [], excludeNodeIds: [], passNodeIds: [],
      classification: 'technical', supplement: { nodeIds: ['[ai].[raworderimport]'] },
    };
  it("exact Azure fresh/refine/supplement artifact is rejected by canonical branch schema", () => { assert(!StartExplorationProviderInputSchema.safeParse(azureCombinedArtifact).success, 'exact Azure fresh/refine/supplement artifact is rejected by canonical branch schema'); });

  const namedBb = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: ['TotalDue'] });
  it("named BB conflict preserves semantic rejection code", () => { assert(!namedBb.success && buildStartExplorationReject(namedBb.error).error === 'ct_field_forbidden_in_bb', 'named BB conflict preserves semantic rejection code'); });

  const invalidMode = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'wrong', classification: 'business' });
  it("invalid mode maps to invalid_enum", () => { assert(!invalidMode.success && buildStartExplorationReject(invalidMode.error, { origin: '[s].[t]', analysisMode: 'wrong', classification: 'business' }).error === 'invalid_enum', 'invalid mode maps to invalid_enum'); });

  const missingClassification = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb' });
  it("omitted required classification maps to missing_field", () => { assert(!missingClassification.success && buildStartExplorationReject(missingClassification.error, { origin: '[s].[t]', analysisMode: 'bb' }).error === 'missing_field', 'omitted required classification maps to missing_field'); });

  const unknownField = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', surprise: true });
  it("unknown strict key maps to unknown_field", () => { assert(!unknownField.success && buildStartExplorationReject(unknownField.error).error === 'unknown_field', 'unknown strict key maps to unknown_field'); });

  const missingCt = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business' });
  it("CT recovery gives one mode-preserving action", () => { assert(!missingCt.success && buildStartExplorationReject(missingCt.error).hint === 'Provide at least one named targetColumns value and resubmit CT.', 'CT recovery gives one mode-preserving action'); });

  it("wildcard \"*\" target column rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['*'] }).success,
    'wildcard "*" target column rejected',
  ); });

  it("SQL-wildcard \"%\" target column rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['Total%'] }).success,
    'SQL-wildcard "%" target column rejected',
  ); });

  it("whitespace-only target column rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['  '] }).success,
    'whitespace-only target column rejected',
  ); });

  const trimmedCol = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: [' TotalDue '] });
  it("real column accepted and trimmed", () => { assert(trimmedCol.success && trimmedCol.data.targetColumns?.[0] === 'TotalDue', 'real column accepted and trimmed'); });

  const missingOrigin = StartExplorationInputSchema.safeParse({
      maxDepth: '1',
      mission_brief: 'User wants to analyze...',
      classification: 'business',
    } as any);
  it("payload without origin rejected cleanly", () => { assert(!missingOrigin.success, 'payload without origin rejected cleanly'); });

  it("scenario 68", () => { if (!missingOrigin.success) {
    // The rejection must name either valid start shape so the AI can self-correct.
    const msg = missingOrigin.error.issues.map(i => i.message).join(' | ');
    assert(
      (/origin/i.test(msg) && /supplement/i.test(msg)) || /Unrecognized key/i.test(msg),
      `rejection message should indicate missing origin or unrecognized keys (got: ${msg})`,
    );
  } });

  it("empty supplement rejects without a node id", () => { assert(
    !StartExplorationInputSchema.safeParse({ classification: 'business', supplement: {} }).success,
    'empty supplement rejects without a node id',
  ); });

  const approvedMission = 'Use `lineage_search_ddl` to explain A  and  B </mission_brief>';
  const missionPayload = {
      origin: '[s].[t]',
      analysisMode: 'bb' as const,
      classification: 'business' as const,
      mission_brief: approvedMission,
    };
  const mission = StartExplorationInputSchema.safeParse(missionPayload);
  it("domain schema preserves the approved mission brief byte-for-byte", () => { assert(mission.success && mission.data.mission_brief === approvedMission, 'domain schema preserves the approved mission brief byte-for-byte'); });

  const providerMission = StartExplorationProviderInputSchema.safeParse(missionPayload);
  it("provider schema preserves tool names, backticks, spacing, and XML-like text", () => { assert(
    providerMission.success
      && 'mission_brief' in providerMission.data
      && providerMission.data.mission_brief === approvedMission,
    'provider schema preserves tool names, backticks, spacing, and XML-like text',
  ); });

  const loggedMission = redactMissionBriefForLog(missionPayload) as { mission_brief: { provenance: string; length: number; hash?: string } };
  it("mission diagnostic records tool-payload provenance", () => { assert(loggedMission.mission_brief.provenance === 'tool_payload', 'mission diagnostic records tool-payload provenance'); });

  it("mission diagnostic records only the source length", () => { assert(loggedMission.mission_brief.length === approvedMission.length, 'mission diagnostic records only the source length'); });

  it("mission diagnostic does not retain a content fingerprint", () => { assert(loggedMission.mission_brief.hash === undefined, 'mission diagnostic does not retain a content fingerprint'); });

  it("mission diagnostic never persists raw brief content", () => { assert(!JSON.stringify(loggedMission).includes(approvedMission), 'mission diagnostic never persists raw brief content'); });

  it("empty supplied mission brief rejected", () => { assert(!StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: '' }).success, 'empty supplied mission brief rejected'); });

  it("blank supplied mission brief rejected without trimming accepted values", () => { assert(!StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: ' \n\t ' }).success, 'blank supplied mission brief rejected without trimming accepted values'); });

  const longMission = ` Ω ${'x'.repeat(3000)} `;
  const longParsed = StartExplorationInputSchema.safeParse({ ...missionPayload, mission_brief: longMission });
  it("over-1000-character mission brief accepted verbatim (no length cap)", () => { assert(longParsed.success && longParsed.data.mission_brief === longMission, 'over-1000-character mission brief accepted verbatim (no length cap)'); });

  const nodeMap = new Map<string, unknown>([
      ['[dbo].[factsales]', { id: '[dbo].[factsales]' }],
      ['[sales].[daily report]', { id: '[sales].[daily report]' }],
    ]);
  it("canonical bracketed mixed-case id resolves", () => { assert(
    resolveModelNodeId('[dbo].[FactSales]', nodeMap) === '[dbo].[factsales]',
    'canonical bracketed mixed-case id resolves',
  ); });

  it("unbracketed schema.name id resolves to canonical id", () => { assert(
    resolveModelNodeId('dbo.FactSales', nodeMap) === '[dbo].[factsales]',
    'unbracketed schema.name id resolves to canonical id',
  ); });

  it("bracketed id with spaces resolves", () => { assert(
    resolveModelNodeId('[sales].[daily report]', nodeMap) === '[sales].[daily report]',
    'bracketed id with spaces resolves',
  ); });

  it("unbracketed id with spaces resolves", () => { assert(
    resolveModelNodeId('sales.daily report', nodeMap) === '[sales].[daily report]',
    'unbracketed id with spaces resolves',
  ); });

  it("unknown id remains unresolved after normalization", () => { assert(
    resolveModelNodeId('dbo.DoesNotExist', nodeMap) === null,
    'unknown id remains unresolved after normalization',
  ); });

  const rawSubmitInput = {
      focus_node_id: 'dbo.FactSales',
      sections: [{ angle: 'business', text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
      prune_neighbors: ['sales.daily report', 'dbo.DoesNotExist'],
      route_requests: [{ nodeId: 'dbo.FactSales', question: 'trace' }],
    };
  const normalizedSubmit = normalizeSubmitFindingsInputIds(rawSubmitInput, nodeMap);
  it("submit_findings normalization canonicalizes focus_node_id in cloned input", () => { assert(
    normalizedSubmit.input.focus_node_id === '[dbo].[factsales]',
    'submit_findings normalization canonicalizes focus_node_id in cloned input',
  ); });

  it("submit_findings normalization canonicalizes known prune ids and preserves unknown ids for rejection", () => { assert(
    Array.isArray(normalizedSubmit.input.prune_neighbors) &&
      normalizedSubmit.input.prune_neighbors[0] === '[sales].[daily report]' &&
      normalizedSubmit.input.prune_neighbors[1] === 'dbo.DoesNotExist',
    'submit_findings normalization canonicalizes known prune ids and preserves unknown ids for rejection',
  ); });

  it("submit_findings normalization canonicalizes route_requests nodeId", () => { assert(
    Array.isArray(normalizedSubmit.input.route_requests) &&
      (normalizedSubmit.input.route_requests[0] as { nodeId?: string }).nodeId === '[dbo].[factsales]',
    'submit_findings normalization canonicalizes route_requests nodeId',
  ); });

  it("submit_findings normalization does not mutate raw model input", () => { assert(rawSubmitInput.focus_node_id === 'dbo.FactSales', 'submit_findings normalization does not mutate raw model input'); });

  it("submit_findings normalization records every changed id", () => { assert(normalizedSubmit.normalizations.length === 3, 'submit_findings normalization records every changed id'); });

  const activeRecovery = evaluateAlreadyStartedRule(true, true, false);
  it("active duplicate start rejected", () => { assert(activeRecovery?.error === 'already_started', 'active duplicate start rejected'); });

  it("active duplicate start points to submit_findings", () => { assert(activeRecovery?.next_action === 'submit_findings', 'active duplicate start points to submit_findings'); });

  const budgetRecovery = evaluateScopeBudgetRule(28, 1, 2);
  it("oversized scope rejected by round budget", () => { assert(budgetRecovery?.error === 'scope_exceeds_budget', 'oversized scope rejected by round budget'); });

  it("budget recovery points to structural narrowing", () => { assert(budgetRecovery?.next_action === 'narrow_scope', 'budget recovery points to structural narrowing'); });

  it("budget hint offers structural narrowing", () => { assert(/excludeSchemas\/excludeNodeIds/.test(budgetRecovery?.hint ?? ''), 'budget hint offers structural narrowing'); });

  it("budget hint frames narrowing as a user question", () => { assert(/ask the user/.test(budgetRecovery?.hint ?? ''), 'budget hint frames narrowing as a user question'); });

  it("budget hint forbids inventing a depth", () => { assert(/Do not invent a depth/.test(budgetRecovery?.hint ?? ''), 'budget hint forbids inventing a depth'); });

  it("budget hint never proposes an engine depth number", () => { assert(!/depth=/.test(budgetRecovery?.hint ?? ''), 'budget hint never proposes an engine depth number'); });

});
