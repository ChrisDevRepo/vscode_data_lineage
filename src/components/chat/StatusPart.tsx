import { Spinner } from '../ui/Spinner';

/** The turn's current progress label (searching, scoping, calling a tool, writing), with a spinner. */
export function StatusPart({ label }: { label: string }) {
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
      <Spinner className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}
