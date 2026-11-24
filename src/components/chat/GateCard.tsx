import { useMemo, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '../ui/Button';
import { renderAiMarkdown } from '../markdown/renderAiMarkdown';
import { useMarkdownLinks } from '../markdown/useMarkdownLinks';
import { useChatContext } from './ChatContext';
import type { GateDecision } from './chatStore';

/** Arguments the store puts on the gate's tool-call part (see `toThreadMessage`). */
export interface GateArgs extends Record<string, unknown> {
  turnId: string;
  gateId: string;
  gate: string;
  summary: string;
  classes?: readonly string[];
  replacesAnalysis?: boolean;
  decision?: GateDecision;
}

const DECIDED_LABEL: Record<GateDecision, string> = { approve: 'Approved', refine: 'Change requested', cancel: 'Cancelled' };

/** Class chips shown before "+N more". */
const MAX_CLASS_CHIPS = 8;

/**
 * The approval card a turn waits on: the host's summary (markdown), the object-class chips, and the
 * three decisions. Refine asks for the change as text first. Once decided, the buttons give way to
 * the outcome, so a second click cannot post a second decision.
 */
export function GateCard({ args }: { args: GateArgs }) {
  const { actions } = useChatContext();
  const [refining, setRefining] = useState(false);
  const [change, setChange] = useState('');
  const html = useMemo(() => renderAiMarkdown(args.summary), [args.summary]);
  const links = useMarkdownLinks();
  const decide = (decision: GateDecision, text?: string): void => actions.decideGate(args.turnId, args.gateId, decision, text);
  const chips = args.classes?.slice(0, MAX_CLASS_CHIPS) ?? [];
  const hidden = (args.classes?.length ?? 0) - chips.length;

  return (
    <section aria-label="Approval needed" className="bg-popover text-popover-foreground border-border my-2 rounded-md border p-3">
      <div
        className="ln-ai-description-md ln-ai-description-font-0"
        onClick={links.onClick}
        onKeyDown={links.onKeyDown}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {chips.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Object classes">
          {chips.map(name => (
            <li key={name} className="border-border rounded-full border px-2 py-0.5 text-xs">{name}</li>
          ))}
          {hidden > 0 && <li className="text-muted-foreground px-2 py-0.5 text-xs">+{hidden} more</li>}
        </ul>
      )}
      {args.replacesAnalysis && args.decision === undefined && (
        <p className="text-muted-foreground mt-2 text-xs">Approving replaces the analysis shown now.</p>
      )}
      {args.decision !== undefined ? (
        <p className="mt-2 text-xs font-semibold" role="status">{DECIDED_LABEL[args.decision]}</p>
      ) : refining ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea aria-label="Requested change" className="min-h-16 text-xs" value={change} onChange={e => setChange(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" disabled={change.trim() === ''} onClick={() => decide('refine', change.trim())}>Send change</Button>
            <Button variant="secondary" onClick={() => setRefining(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => decide('approve')}>Approve</Button>
          <Button variant="secondary" onClick={() => setRefining(true)}>Refine</Button>
          <Button variant="secondary" onClick={() => decide('cancel')}>Cancel</Button>
        </div>
      )}
    </section>
  );
}
