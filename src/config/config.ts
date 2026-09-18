import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface ConnectionConfig {
  host: string
  port: number
  user: string
  database: string
}

export interface StoredConfig extends ConnectionConfig {
  password?: string
}

export interface ConnectionFormValues {
  host: string
  port: string
  user: string
  database: string
  password: string
}

export function toFormValues(config: StoredConfig): ConnectionFormValues {
  return {
    host: config.host,
    port: String(config.port),
    user: config.user,
    database: config.database,
    password: config.password ?? "",
  }
}

export function defaultFormValues(): ConnectionFormValues {
  const user = process.env.USER ?? "postgres"
  return { host: DEFAULT_HOST, port: String(DEFAULT_PORT), user, database: user, password: "" }
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
  return { config: { host, port, user, database, ...(password ? { password } : {}) } }
}

export const DEFAULT_HOST = "localhost"
export const DEFAULT_PORT = 5432

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "pg-explorer", "config")
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseConfig(toml: string): StoredConfig {
  const parsed = parseToml(toml) as { connection?: Record<string, unknown> }
  const connection = parsed.connection ?? {}
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
  return { host, port, user, database, ...(password ? { password } : {}) }
}

export function serializeConfig(config: ConnectionConfig): string {
  return stringifyToml({
    connection: {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
    },
  })
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<StoredConfig | null> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  return parseConfig(content)
}

export async function saveConfig(config: ConnectionConfig, path: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeConfig(config), "utf8")
}
