import postgres from "postgres"
import type { StoredConfig } from "../config/config"
import {
  loadSchemasAndTables,
  loadTableColumns,
  loadTableDetails,
  type ColumnInfo,
  type SchemaInfo,
  type TableDetails,
} from "./metadata"
import { errorMessage } from "../errors"

export interface DbOptions {
  connectTimeoutSeconds?: number
  maxRows?: number
  readSecret?: (ref: string) => Promise<string>
}

export async function opRead(ref: string): Promise<string> {
  let proc
  try {
    proc = Bun.spawn(["op", "read", "--no-newline", ref], { stdout: "pipe", stderr: "pipe" })
  } catch (err) {
    throw new DbError(`1Password CLI (op) not available: ${errorMessage(err)}`, "SECRET_READ")
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new DbError(`1Password: ${stderr.trim() || `op exited with ${code}`}`, "SECRET_READ")
  return stdout
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
  cancel(): void
  loadSchemasAndTables(): Promise<SchemaInfo[]>
  loadTableColumns(schema: string, table: string): Promise<ColumnInfo[]>
  loadTableDetails(schema: string, table: string): Promise<TableDetails>
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
  private readonly readSecret: (ref: string) => Promise<string>
  private pending: { cancel(): void } | null = null

  constructor(options: DbOptions = {}) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS
    this.readSecret = options.readSecret ?? opRead
  }

  get connected(): boolean {
    return this.sql !== null
  }

  async connect(config: StoredConfig): Promise<void> {
    await this.disconnect()
    const password =
      !config.password && config.passwordRef ? await this.readSecret(config.passwordRef) : config.password
    const sql = postgres({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      password,
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
    const pending = sql.unsafe(query)
    this.pending = pending
    try {
      const result = await pending
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
    } finally {
      if (this.pending === pending) this.pending = null
    }
  }

  cancel(): void {
    this.pending?.cancel()
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

  async loadTableDetails(schema: string, table: string): Promise<TableDetails> {
    const sql = this.sql
    if (!sql) throw new DbError("not connected", "NO_CONNECTION")
    return loadTableDetails(sql, schema, table)
  }
}

function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err
  const message = errorMessage(err)
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined
  return new DbError(message, code)
}
