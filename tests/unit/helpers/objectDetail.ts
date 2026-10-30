import type { DatabaseModel } from '../../../src/engine/types';
import { AiSession } from '../../../src/ai/session/session';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';

const quiet = () => {};

/** Reads one object through the registered `lineage_get_object_detail` tool, the production path to object metadata. */
export async function objectDetail(
  model: DatabaseModel,
  id: string,
): Promise<Record<string, unknown>> {
  const session = new AiSession();
  session.model = model;
  const channel = {
    info: quiet,
    debug: quiet,
    warn: quiet,
    error: quiet,
  } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  return JSON.parse(
    String(
      await buildAiToolRegistry(
        () => session,
        channel,
        () => undefined,
      ).invoke('lineage_get_object_detail', { id }),
    ),
  );
}
