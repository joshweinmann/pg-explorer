import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  connectionId,
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadConfig,
  normalizeConnection,
  parseConfig,
  removeConnection,
  saveConfig,
  serializeConfig,
  toFormValues,
  upsertConnection,
  type ConnectionConfig,
  type StoredConfig,
} from "./config"

const dir = await mkdtemp(join(tmpdir(), "pg-explorer-"))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const baseConfig: ConnectionConfig = {
  host: "db.internal",
  port: 5433,
  user: "alice",
  database: "widgets",
}

describe("config", () => {
  test("write → read round trip keeps every connection and password", async () => {
    const path = join(dir, "config")
    const config = { connections: [{ ...baseConfig, password: "s3cret" }, { ...baseConfig, database: "other" }] }
    await saveConfig(config, path)
    expect(await loadConfig(path)).toEqual(config)
  })

  test("saved config is readable only by the owner", async () => {
    const path = join(dir, "perms")
    await writeFile(path, "", { mode: 0o644 })
    await saveConfig({ connections: [baseConfig] }, path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("serializes as an array of connection tables", () => {
    const serialized = serializeConfig({ connections: [{ ...baseConfig, password: "p" }] })
    expect(serialized).toContain("[[connections]]")
    expect(serialized).toContain('password = "p"')
    expect(serializeConfig({ connections: [baseConfig] })).not.toContain("password")
  })

  test("loadConfig returns an empty list for a missing file", async () => {
    expect(await loadConfig(join(dir, "does-not-exist"))).toEqual({ connections: [] })
  })

  test("parseConfig of an empty file has no connections", () => {
    expect(parseConfig("")).toEqual({ connections: [] })
  })

  test("parseConfig fills defaults per connection", () => {
    const [config] = parseConfig('[[connections]]\nhost = "remote"\n').connections
    expect(config!.host).toBe("remote")
    expect(config!.port).toBe(DEFAULT_PORT)
    expect(config!.database).toBe(config!.user)
  })

  test("legacy single [connection] table migrates to a one-item list", () => {
    const { connections } = parseConfig('[connection]\nuser = "u"\npassword = "p"\n')
    expect(connections).toEqual([{ host: DEFAULT_HOST, port: DEFAULT_PORT, user: "u", database: "u", password: "p" }])
  })

  test("duplicate connections keep the first occurrence", () => {
    const toml = '[[connections]]\nuser = "u"\npassword = "a"\n[[connections]]\nuser = "u"\npassword = "b"\n'
    expect(parseConfig(toml).connections.map((c) => c.password)).toEqual(["a"])
  })

  test("invalid port is rejected", () => {
    expect(() => parseConfig("[[connections]]\nport = 0\n")).toThrow("invalid port")
  })

  test("loadConfig throws on malformed TOML", async () => {
    const path = join(dir, "malformed")
    await writeFile(path, "[connection\nhost = ", "utf8")
    await expect(loadConfig(path)).rejects.toThrow()
  })
})

describe("connection list helpers", () => {
  const a: StoredConfig = { ...baseConfig, database: "a" }
  const b: StoredConfig = { ...baseConfig, database: "b" }

  test("connectionId", () => {
    expect(connectionId(a)).toBe("alice@db.internal:5433/a")
  })

  test("upsert moves to the front and replaces the same id", () => {
    const updated = { ...b, password: "new" }
    expect(upsertConnection([a, b], updated)).toEqual([updated, a])
  })

  test("upsert with replaceId drops the edited entry", () => {
    const renamed: StoredConfig = { ...a, database: "c" }
    expect(upsertConnection([a, b], renamed, connectionId(a))).toEqual([renamed, b])
  })

  test("removeConnection", () => {
    expect(removeConnection([a, b], connectionId(a))).toEqual([b])
  })
})

describe("normalizeConnection", () => {
  const form = {
    host: "  localhost ",
    port: "5433",
    user: " alice ",
    database: "widgets",
    password: "pw",
  }

  test("normalizes values and keeps the password", () => {
    expect(normalizeConnection(form)).toEqual({
      config: { host: "localhost", port: 5433, user: "alice", database: "widgets", password: "pw" },
    })
  })

  test("defaults host and port and derives database from user", () => {
    expect(
      normalizeConnection({ host: "", port: "", user: "bob", database: "", password: "" }),
    ).toEqual({ config: { host: DEFAULT_HOST, port: DEFAULT_PORT, user: "bob", database: "bob" } })
  })

  test("rejects a missing user", () => {
    expect(normalizeConnection({ ...form, user: "  " })).toEqual({ error: "user is required" })
  })

  test("rejects non-numeric and out-of-range ports", () => {
    expect(normalizeConnection({ ...form, port: "abc" })).toEqual({
      error: "port must be a number between 1 and 65535",
    })
    expect(normalizeConnection({ ...form, port: "0" })).toEqual({
      error: "port must be a number between 1 and 65535",
    })
    expect(normalizeConnection({ ...form, port: "70000" })).toEqual({
      error: "port must be a number between 1 and 65535",
    })
  })

  test("toFormValues round-trips a stored config", () => {
    const config: StoredConfig = { host: "h", port: 5432, user: "u", database: "d", password: "x" }
    expect(toFormValues(config)).toEqual({
      host: "h",
      port: "5432",
      user: "u",
      database: "d",
      password: "x",
    })
  })
})
