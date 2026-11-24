import { useMemo, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '../ui/Button';
import { renderAiMarkdown } from '../markdown/renderAiMarkdown';
import { useMarkdownLinks } from '../markdown/useMarkdownLinks';
import { useChatContext } from './ChatContext';
import type { GateDecision, GateFullPlan } from './chatStore';

/** Arguments the store puts on the gate's tool-call part (see `toThreadMessage`). */
export interface GateArgs extends Record<string, unknown> {
  turnId: string;
  gateId: string;
  gate: string;
  summary: string;
  fullPlan?: GateFullPlan;
  replacesAnalysis?: boolean;
  decision?: GateDecision;
}

const DECIDED_LABEL: Record<GateDecision, string> = { approve: 'Approved', refine: 'Change requested', cancel: 'Cancelled' };

/** Host markdown as the chat shows it: one pipeline, links handled by the shared hook. */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderAiMarkdown(text), [text]);
  const links = useMarkdownLinks();
  return (
    <div
      className="ln-ai-description-md ln-ai-description-font-0"
      onClick={links.onClick}
      onKeyDown={links.onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * The approval card a turn waits on: the host's scope card (markdown), the full plan behind a
 * disclosure, and the three decisions. Refine asks for the change as text
 * first. Once decided, the buttons give way to the outcome, so a second click cannot post a second
 * decision.
 */
export function GateCard({ args }: { args: GateArgs }) {
  const { actions } = useChatContext();
  const [refining, setRefining] = useState(false);
  const [change, setChange] = useState('');
  const decide = (decision: GateDecision, text?: string): void => actions.decideGate(args.turnId, args.gateId, decision, text);

  return (
    <section aria-label="Approval needed" className="bg-popover text-popover-foreground border-border my-2 rounded-md border p-3">
      <Markdown text={args.summary} />
      {args.fullPlan && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-semibold">
            Show full plan ({args.fullPlan.objects} objects)
          </summary>
          <Markdown text={args.fullPlan.markdown} />
        </details>
      )}
      {args.replacesAnalysis && args.decision === undefined && (
        <p className="text-muted-foreground mt-2 text-xs">Approving replaces the analysis shown now.</p>
      )}
      {args.decision !== undefined ? (
        <p className="mt-2 text-xs font-semibold" role="status">{DECIDED_LABEL[args.decision]}</p>
      ) : refining ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea aria-label="Requested change" className="min-h-16 text-xs" value={change} onChange={e => setChange(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={change.trim() === ''} onClick={() => decide('refine', change.trim())}>Send change</Button>
            <Button variant="secondary" onClick={() => setRefining(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => decide('approve')}>Approve</Button>
          <Button variant="secondary" onClick={() => setRefining(true)}>Refine</Button>
          <Button variant="secondary" onClick={() => decide('cancel')}>Cancel</Button>
        </div>
      )}
    </section>
  );
}
