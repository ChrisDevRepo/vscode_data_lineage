/** Type surface of `assert-no-output-truncation.mjs` for the unit test that imports it under `tsc`. */
export interface TruncationSite { file: string; line: number; text: string }
export interface BaselineEntry { file: string; text: string }
export function findSites(file: string, text: string): TruncationSite[];
export function compare(sites: TruncationSite[], baseline: BaselineEntry[]): { fresh: TruncationSite[]; stale: BaselineEntry[] };
export function scanTree(): TruncationSite[];
export const ALLOWLIST: { file: string; symbol: string; reason: string }[];
