export interface CatalogCase {
  id: string;
  contract?: 'stored-arrival' | 'self-prune';
  story?: string;
  runners?: string[];
  prompt?: string;
  dacpac?: string;
  expect?: { terminal?: string };
}

/** Rows from tests/cases/lineage-cases.yaml tagged for one runner. */
export function loadCases(runner?: string): CatalogCase[];
