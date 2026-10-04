// Scripted public-demo responses for UI lifecycle checks, not inference evidence.
const vscode = require('vscode');
const requests = [];
let sequence = 0;
async function respond(request, progress) {
  requests.push(request);
  const exports = await vscode.extensions.getExtension('datahelper-chwagner.data-lineage-viz').activate();
  const session = exports.getSession();
  const names = request.tools.map(tool => tool.name);
  const text = JSON.stringify(request.messages);
  const call = (name, input) => progress.report(new vscode.LanguageModelToolCallPart(`ui-${++sequence}`, name, input));
  if (names.includes('structured_output')) {
    const schema = request.tools.find(tool => tool.name === 'structured_output').schema;
    if (schema.properties?.action) {
      const reply = session.currentTurnPrompt ?? '';
      call('structured_output', { action: /^(approve|go ahead)$/i.test(reply) ? 'approve'
        : /^(no|stop|no stop|cancel the plan)$/i.test(reply) ? 'cancel'
          : /change/i.test(reply) ? 'change' : 'other' });
    } else call('structured_output', { entry: 'discovery', targetColumns: null });
    return;
  }
  if (names.includes('lineage_start_exploration')) {
    if (session.pendingExploration) {
      const reply = session.currentTurnPrompt ?? '';
      call('lineage_start_exploration', {
        proposalRevision: session.pendingExploration.revision,
        depth: reply.includes('zero levels downstream')
          ? { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } }
          : { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 1, exactness: 'exact' } },
      });
    }
    else call('lineage_start_exploration', {
      origin: '[dbo].[ufnGetProductDealerPrice]', analysisMode: 'bb', classification: 'technical',
      // Must differ from the "zero levels downstream" refine, or that patch is a no-op and revision stays 1.
      depth: { upstream: { levels: 2, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    });
    return;
  }
  if (names.includes('lineage_submit_findings')) {
    call('lineage_submit_findings', {
      focus_node_id: session.stateMachine.currentFocus, verdict: 'analyze',
      summary: 'Calculates the dealer price from the effective list price.', badge_label: 'Dealer price',
      sections: { technical: 'The function returns sixty percent of the effective list price.' }, questions: [],
    });
    return;
  }
  if (names.includes('lineage_present_result')) {
    const ids = session.stateMachine.getResult().fullNodes.map(node => node.id);
    call('lineage_present_result', { name:'Dealer price trace', summary:'Dealer price trace complete',
      highlight_groups:[{label:'Calculation',color:'target',node_ids:ids}],
      sections:[{label:'Dealer price',node_ids:ids,text:'The function returns sixty percent of the effective list price.'}],
    });
    return;
  }
  progress.report(new vscode.LanguageModelTextPart(names.length === 0 && /short bullet points/.test(text)
    ? '- How does ProductListPriceHistory select the effective price?\n- Which Product rows have no price history?\n\nWould you like me to analyze one of these in detail?'
    : 'Typed question received and answered.'));
}
module.exports = { respond, requests };
