import type postgres from "postgres"

export type SqlInstance = ReturnType<typeof postgres>

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
}

export interface TableInfo {
  name: string
  kind: "table" | "view"
  columns: ColumnInfo[] | null
}

export interface SchemaInfo {
  name: string
  tables: TableInfo[]
}

export interface SchemaTableRow {
  table_schema: string
  table_name: string
  table_type: string
}

export interface ColumnTableRow {
  column_name: string
  data_type: string
  is_nullable: string
}

export interface ConstraintTableRow {
  column_name: string
  constraint_type: string
}

export function rowsToSchemas(rows: SchemaTableRow[]): SchemaInfo[] {
  const schemas = new Map<string, SchemaInfo>()
  for (const row of rows) {
    let schema = schemas.get(row.table_schema)
    if (!schema) {
      schema = { name: row.table_schema, tables: [] }
      schemas.set(row.table_schema, schema)
    }
    schema.tables.push({
      name: row.table_name,
      kind: row.table_type === "VIEW" ? "view" : "table",
      columns: null,
    })
  }
  return [...schemas.values()]
    .map((schema) => ({
      name: schema.name,
      tables: schema.tables.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function mergeColumns(
  columns: ColumnTableRow[],
  constraints: ConstraintTableRow[],
): ColumnInfo[] {
  const primaryKeys = new Set(
    constraints.filter((c) => c.constraint_type === "PRIMARY KEY").map((c) => c.column_name),
  )
  const foreignKeys = new Set(
    constraints.filter((c) => c.constraint_type === "FOREIGN KEY").map((c) => c.column_name),
  )
  return columns.map((column) => ({
    name: column.column_name,
    dataType: column.data_type,
    nullable: column.is_nullable === "YES",
    isPrimaryKey: primaryKeys.has(column.column_name),
    isForeignKey: foreignKeys.has(column.column_name),
  }))
}

export async function loadSchemasAndTables(sql: SqlInstance): Promise<SchemaInfo[]> {
  const rows = await sql<SchemaTableRow[]>`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT LIKE 'pg\\_%'
      AND table_schema <> 'information_schema'
    ORDER BY table_schema, table_name
  `
  return rowsToSchemas(rows)
}

export async function loadTableColumns(
  sql: SqlInstance,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const columns = await sql<ColumnTableRow[]>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table}
    ORDER BY ordinal_position
  `
  const constraints = await sql<ConstraintTableRow[]>`
    SELECT kcu.column_name, tc.constraint_type
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
    WHERE tc.table_schema = ${schema}
      AND tc.table_name = ${table}
      AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
  `
  return mergeColumns(columns, constraints)
}

export interface IndexInfo {
  name: string
  summary: string
  unique: boolean
}

export interface ConstraintInfo {
  name: string
  definition: string
}

export interface TriggerInfo {
  name: string
  summary: string
  enabled: boolean
}

export interface TableDetails {
  indexes: IndexInfo[]
  constraints: ConstraintInfo[]
  triggers: TriggerInfo[]
}

export function indexSummary(definition: string): string {
  const at = definition.indexOf(" USING ")
  return at < 0 ? definition : definition.slice(at + " USING ".length)
}

export function triggerSummary(definition: string): string {
  const match = / ((?:BEFORE|AFTER|INSTEAD OF) .+?) ON .* EXECUTE (?:FUNCTION|PROCEDURE) (.+)$/s.exec(definition)
  return match ? `${match[1]} ${match[2]}` : definition
}

export async function loadTableDetails(
  sql: SqlInstance,
  schema: string,
  table: string,
): Promise<TableDetails> {
  const indexes = await sql<{ name: string; definition: string; unique: boolean }[]>`
    SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition, ix.indisunique AS unique
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = ${table}
    ORDER BY i.relname
  `
  const constraints = await sql<ConstraintInfo[]>`
    SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = ${table} AND c.contype <> 'n'
    ORDER BY c.conname
  `
  const triggers = await sql<{ name: string; definition: string; enabled: string }[]>`
    SELECT tg.tgname AS name, pg_get_triggerdef(tg.oid) AS definition, tg.tgenabled AS enabled
    FROM pg_trigger tg
    JOIN pg_class t ON t.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schema} AND t.relname = ${table} AND NOT tg.tgisinternal
    ORDER BY tg.tgname
  `
  return {
    indexes: indexes.map((row) => ({
      name: row.name,
      summary: indexSummary(row.definition),
      unique: row.unique,
    })),
    constraints: constraints.map((row) => ({ name: row.name, definition: row.definition })),
    triggers: triggers.map((row) => ({
      name: row.name,
      summary: triggerSummary(row.definition),
      enabled: row.enabled !== "D",
    })),
  }
}
