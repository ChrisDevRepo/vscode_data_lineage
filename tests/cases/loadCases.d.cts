export interface CatalogCase {
  id: string;
  runners?: string[];
  prompt?: string;
  command?: string;
  dacpac?: string;
  expect?: { graph?: boolean; terminal?: string; phase?: string };
}

/** Rows from tests/cases/lineage-cases.yaml tagged for one runner. */
export function loadCases(runner?: string): CatalogCase[];
