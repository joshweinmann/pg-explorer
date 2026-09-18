import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadConfig,
  normalizeConnection,
  parseConfig,
  saveConfig,
  serializeConfig,
  toFormValues,
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
  test("write → read round trip", async () => {
    const path = join(dir, "config")
    await saveConfig(baseConfig, path)
    expect(await loadConfig(path)).toEqual(baseConfig)
  })

  test("serialized config never contains a password", () => {
    const config: StoredConfig = { ...baseConfig, password: "s3cret" }
    const serialized = serializeConfig(config)
    expect(serialized).not.toContain("s3cret")
    expect(serialized).not.toContain("password")
  })

  test("saved config never contains a password", async () => {
    const config: StoredConfig = { ...baseConfig, password: "s3cret" }
    const path = join(dir, "with-password")
    await saveConfig(config, path)
    const stored = await loadConfig(path)
    expect(stored).not.toHaveProperty("password")
  })

  test("loadConfig returns null for a missing file", async () => {
    expect(await loadConfig(join(dir, "does-not-exist"))).toBeNull()
  })

  test("parseConfig fills defaults for an empty file", () => {
    const config = parseConfig("")
    expect(config.host).toBe(DEFAULT_HOST)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.database).toBe(config.user)
  })

  test("parseConfig applies partial overrides", () => {
    const config = parseConfig('[connection]\nhost = "remote"\n')
    expect(config.host).toBe("remote")
    expect(config.port).toBe(DEFAULT_PORT)
  })

  test("parseConfig reads a hand-added password", () => {
    const config = parseConfig('[connection]\nuser = "u"\npassword = "p"\n')
    expect(config.password).toBe("p")
  })

  test("loadConfig throws on malformed TOML", async () => {
    const path = join(dir, "malformed")
    await writeFile(path, "[connection\nhost = ", "utf8")
    await expect(loadConfig(path)).rejects.toThrow()
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
