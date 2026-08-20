/** Detects a multi-object discovery walk from accepted graph-owned tool observations. */
import { z } from 'zod';
import type { ToolAttemptObservation } from './toolAttempt';

/** The captured walk used to seed the SM-offer pill / `lineage_start_exploration`. */
interface DiscoveryWalk {
  /** Distinct objects inspected via `lineage_get_object_detail` (≥ 2 to qualify). */
  readonly walkCount: number;
  /** The first inspected node id — the SM-offer origin. */
  readonly origin: string;
  /** The AI's final discovery answer (markdown), for the deeper-analysis seed prompt. */
  readonly answer: string;
}

const OBJECT_DETAIL_TOOL = 'lineage_get_object_detail';

// Canonical object-detail output always carries a nonblank id; anything else is malformed engine
// output and must surface observably instead of being skipped in silence.
const ObjectDetailIdView = z.object({ id: z.string().trim().min(1) }).loose();

/**
 * Extracts a discovery walk from accepted provider-neutral observations.
 *
 * @param observations - Successful graph-owned read results retained for the discovery phase.
 * @param answer - Accepted final discovery answer.
 * @param onMalformed - Observable failure policy for canonical output that fails the Zod view.
 * @returns The walk when at least two distinct object-detail results were observed.
 */
export function captureDiscoveryWalkFromObservations(
  observations: readonly ToolAttemptObservation[],
  answer: string,
  onMalformed?: (toolName: string, callId: string) => void,
): DiscoveryWalk | null {
  const inspected: string[] = [];
  for (const observation of observations) {
    if (observation.toolName !== OBJECT_DETAIL_TOOL) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(observation.result);
    } catch {
      onMalformed?.(observation.toolName, observation.callId);
      continue;
    }
    const view = ObjectDetailIdView.safeParse(raw);
    if (!view.success) {
      onMalformed?.(observation.toolName, observation.callId);
      continue;
    }
    inspected.push(view.data.id.trim());
  }
  const distinct = new Set(inspected.map(id => id.toLowerCase()));
  if (distinct.size < 2) return null;
  return { walkCount: distinct.size, origin: inspected[0], answer };
}
