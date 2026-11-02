import postgres from "postgres"
import type { StoredConfig } from "../config/config"
import { loadSchemasAndTables, loadTableColumns, type ColumnInfo, type SchemaInfo } from "./metadata"
import { errorMessage } from "../errors"

export interface DbOptions {
  connectTimeoutSeconds?: number
  maxRows?: number
}

export const DEFAULT_MAX_ROWS = 5000
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

export type QueryResult =
  | {
      kind: "rows"
      columns: string[]
      rows: unknown[][]
      rowCount: number
      truncated: boolean
      maxRows?: number
      elapsedMs: number
    }
  | {
      kind: "command"
      commandTag: string
      rowCount: number | null
      elapsedMs: number
    }

export interface DbConnection {
  readonly connected: boolean
  connect(config: StoredConfig): Promise<void>
  disconnect(): Promise<void>
  execute(query: string): Promise<QueryResult>
  loadSchemasAndTables(): Promise<SchemaInfo[]>
  loadTableColumns(schema: string, table: string): Promise<ColumnInfo[]>
}

export class DbError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = "DbError"
    this.code = code
  }
}

export class DbService {
  private sql: ReturnType<typeof postgres> | null = null
  private readonly maxRows: number
  private readonly connectTimeoutSeconds: number

  constructor(options: DbOptions = {}) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS
  }

  get connected(): boolean {
    return this.sql !== null
  }

  async connect(config: StoredConfig): Promise<void> {
    await this.disconnect()
    const sql = postgres({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      password: config.password,
      ssl: "prefer",
      connect_timeout: this.connectTimeoutSeconds,
      max: 2,
      idle_timeout: 5,
      onnotice: () => {},
    })
    try {
      await sql`SELECT 1`
      this.sql = sql
    } catch (err) {
      await sql.end({ timeout: 1 }).catch(() => {})
      throw toDbError(err)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.sql) return
    const sql = this.sql
    this.sql = null
    await sql.end({ timeout: 3 }).catch(() => {})
  }

  async execute(query: string): Promise<QueryResult> {
    const sql = this.sql
    if (!sql) throw new DbError("not connected", "NO_CONNECTION")
    const started = performance.now()
    try {
      const result = await sql.unsafe(query)
      const elapsedMs = performance.now() - started
      const columns = (result.columns ?? []).map((column) => column.name)
      if (columns.length > 0) {
        // The driver buffers every row before we see it, so maxRows only caps
        // what is kept for display — it does not bound driver-side memory.
        // Avoid a second full-size copy by mapping only up to maxRows + 1.
        const rows: unknown[][] = []
        let rowCount = 0
        for (const row of result) {
          rowCount++
          if (rows.length <= this.maxRows) {
            rows.push(columns.map((name) => (row as Record<string, unknown>)[name]))
          }
        }
        const truncated = rowCount > this.maxRows
        return {
          kind: "rows",
          columns,
          rows: truncated ? rows.slice(0, this.maxRows) : rows,
          rowCount,
          truncated,
          maxRows: this.maxRows,
          elapsedMs,
        }
      }
      return {
        kind: "command",
        commandTag: result.command,
        rowCount: result.count ?? null,
        elapsedMs,
      }
    } catch (err) {
      throw toDbError(err)
    }
  }
  async loadSchemasAndTables(): Promise<SchemaInfo[]> {
    const sql = this.sql
    if (!sql) throw new DbError("not connected", "NO_CONNECTION")
    return loadSchemasAndTables(sql)
  }

  async loadTableColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const sql = this.sql
    if (!sql) throw new DbError("not connected", "NO_CONNECTION")
    return loadTableColumns(sql, schema, table)
  }
}

function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err
  const message = errorMessage(err)
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined
  return new DbError(message, code)
}
