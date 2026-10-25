/**
 * What the compiler knows about the database: the application tables in `public`, as
 * introspected from the local Supabase stack (introspect.ts) and saved as a snapshot
 * (`samesight/schema.json`) so `samesight check` runs without a database.
 */

export interface ColumnInfo {
  name: string;
  /** `format_type()` output, e.g. "uuid", "text", "bigint", "timestamp with time zone". */
  type: string;
  nullable: boolean;
  /** The default expression, e.g. "now()" or "auth.uid()"; null when there is none. */
  default: string | null;
  /** GENERATED ... AS IDENTITY. */
  identity: boolean;
  /** GENERATED ALWAYS AS (...) STORED. */
  generated: boolean;
}

export interface TableInfo {
  name: string;
  /** In table order. */
  columns: ColumnInfo[];
  primaryKey: string[];
  /** The leading column of each index, for the "via without an index" warning. */
  indexedColumns: string[];
  /** Columns with a single-column unique constraint or unique index (the primary key included). */
  uniqueColumns: string[];
}

export interface SchemaInfo {
  tables: TableInfo[];
}

export function findTable(schema: SchemaInfo, name: string): TableInfo | undefined {
  return schema.tables.find((t) => t.name === name);
}

export function findColumn(table: TableInfo, name: string): ColumnInfo | undefined {
  return table.columns.find((c) => c.name === name);
}
