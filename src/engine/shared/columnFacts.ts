/** The one reading of a {@link ColumnDef}, serialized by the GUI column table and the AI record. */
import { UNRESOLVED_COLUMN_TYPE, type ColumnDef } from '../types';

/** What the model declares about a column; an undeclared fact is absent. */
export interface ColumnFacts {
  name: string;
  type?: string;
  nullable?: boolean;
  /** Primary-key ordinal (1-based). */
  pk?: number;
  /** Unique-constraint name. */
  unique?: string;
  /** Check-constraint name. */
  check?: string;
  /** 'IDENTITY' or 'COMPUTED'. */
  extra?: string;
}

/** Projects a column definition to its declared facts. */
export function columnFacts(col: ColumnDef): ColumnFacts {
  const declared = col.nullable === 'NULL' || col.nullable === 'NOT NULL';
  return {
    name: col.name,
    ...(col.type !== UNRESOLVED_COLUMN_TYPE && { type: col.type }),
    ...(declared && { nullable: col.nullable === 'NULL' }),
    ...(col.pkOrdinal !== undefined && { pk: col.pkOrdinal }),
    ...(col.unique && { unique: col.unique }),
    ...(col.check && { check: col.check }),
    ...(col.extra && { extra: col.extra }),
  };
}
