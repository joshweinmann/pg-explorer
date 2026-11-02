import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { defaultAppPaths } from "./paths"
import { isMissingFile } from "../errors"

export interface ConnectionConfig {
  host: string
  port: number
  user: string
  database: string
}

export interface StoredConfig extends ConnectionConfig {
  password?: string
  name?: string
  notes?: string
}

export interface AppConfig {
  connections: StoredConfig[]
}

export interface ConnectionFormValues {
  name: string
  host: string
  port: string
  user: string
  database: string
  password: string
  notes: string
}

export function toFormValues(config: StoredConfig): ConnectionFormValues {
  return {
    name: config.name ?? "",
    host: config.host,
    port: String(config.port),
    user: config.user,
    database: config.database,
    password: config.password ?? "",
    notes: config.notes ?? "",
  }
}

export function defaultFormValues(): ConnectionFormValues {
  const user = process.env.USER ?? "postgres"
  return { name: "", host: DEFAULT_HOST, port: String(DEFAULT_PORT), user, database: user, password: "", notes: "" }
}

export function normalizeConnection(values: ConnectionFormValues): { config: StoredConfig } | { error: string } {
  const host = values.host.trim() || DEFAULT_HOST
  const user = values.user.trim()
  if (!user) return { error: "user is required" }
  const portText = values.port.trim()
  const port = portText === "" ? DEFAULT_PORT : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be a number between 1 and 65535" }
  }
  const database = values.database.trim() || user
  const password = values.password
  const name = values.name.trim()
  const notes = values.notes.trim()
  return {
    config: {
      host,
      port,
      user,
      database,
      ...(password ? { password } : {}),
      ...(name ? { name } : {}),
      ...(notes ? { notes } : {}),
    },
  }
}

export const DEFAULT_HOST = "localhost"
export const DEFAULT_PORT = 5432

export function defaultConfigPath(): string {
  return defaultAppPaths().config
}

export function connectionId(config: ConnectionConfig): string {
  return `${config.user}@${config.host}:${config.port}/${config.database}`
}

// Most recently used first; `replaceId` drops the entry being edited.
export function upsertConnection(
  connections: StoredConfig[],
  config: StoredConfig,
  replaceId?: string,
): StoredConfig[] {
  const id = connectionId(config)
  const rest = connections.filter((c) => {
    const cid = connectionId(c)
    return cid !== id && cid !== replaceId
  })
  return [config, ...rest]
}

export function removeConnection(connections: StoredConfig[], id: string): StoredConfig[] {
  return connections.filter((c) => connectionId(c) !== id)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseConnection(connection: Record<string, unknown>): StoredConfig {
  const host = str(connection.host) ?? DEFAULT_HOST
  let port = DEFAULT_PORT
  if (connection.port !== undefined) {
    const parsedPort = num(connection.port)
    if (parsedPort === undefined || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`invalid port in config: ${String(connection.port)}`)
    }
    port = parsedPort
  }
  const user = str(connection.user) ?? process.env.USER ?? "postgres"
  const database = str(connection.database) ?? user
  const password = str(connection.password)
  const name = str(connection.name)
  const notes = str(connection.notes)
  return {
    host,
    port,
    user,
    database,
    ...(password ? { password } : {}),
    ...(name ? { name } : {}),
    ...(notes ? { notes } : {}),
  }
}

// Reads `[[connections]]`; a legacy single `[connection]` table becomes a one-item list.
export function parseConfig(toml: string): AppConfig {
  const parsed = parseToml(toml) as { connection?: unknown; connections?: unknown }
  const tables: Record<string, unknown>[] = []
  if (Array.isArray(parsed.connections)) {
    for (const entry of parsed.connections) {
      if (entry && typeof entry === "object") tables.push(entry as Record<string, unknown>)
    }
  } else if (parsed.connection && typeof parsed.connection === "object") {
    tables.push(parsed.connection as Record<string, unknown>)
  }
  const connections: StoredConfig[] = []
  for (const table of tables) {
    const connection = parseConnection(table)
    if (!connections.some((c) => connectionId(c) === connectionId(connection))) connections.push(connection)
  }
  return { connections }
}

export function serializeConfig(config: AppConfig): string {
  return stringifyToml({
    connections: config.connections.map((c) => ({
      ...(c.name ? { name: c.name } : {}),
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      ...(c.password ? { password: c.password } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
    })),
  })
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<AppConfig> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (err) {
    if (isMissingFile(err)) return { connections: [] }
    throw err
  }
  return parseConfig(content)
}

// The file holds passwords, so it is kept owner-only (mode applies on create; chmod fixes older files).
export async function saveConfig(config: AppConfig, path: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeConfig(config), { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o600)
}
