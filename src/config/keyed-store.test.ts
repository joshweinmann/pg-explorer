import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KeyedStore } from "./keyed-store"

const numberOnly = (value: unknown) => (typeof value === "number" ? value : null)

describe("KeyedStore", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "pg-explorer-store-"))
    const path = join(dir, "nested", "store.json")
    return { store: new KeyedStore(path, numberOnly), path }
  }

  test("missing file loads null", async () => {
    const { store } = await setup()
    expect(await store.load("k")).toBeNull()
  })

  test("update passes the current value and keeps other keys", async () => {
    const { store } = await setup()
    await store.update("a", () => 1)
    await store.update("b", () => 2)
    await store.update("a", (current) => (current ?? 0) + 10)
    expect(await store.load("a")).toBe(11)
    expect(await store.load("b")).toBe(2)
  })

  test("concurrent updates are serialized", async () => {
    const { store } = await setup()
    await Promise.all(Array.from({ length: 5 }, () => store.update("n", (c) => (c ?? 0) + 1)))
    expect(await store.load("n")).toBe(5)
  })

  test("invalid values and corrupt files read as empty", async () => {
    const { store, path } = await setup()
    await store.update("ok", () => 1)
    await writeFile(path, JSON.stringify({ ok: 1, bad: "x" }), "utf8")
    expect(await store.load("bad")).toBeNull()
    expect(await store.load("ok")).toBe(1)
    await writeFile(path, "{not json", "utf8")
    expect(await store.load("ok")).toBeNull()
  })

  test("updateSync merges with existing keys", async () => {
    const { store, path } = await setup()
    await store.update("a", () => 1)
    store.updateSync("b", () => 2)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ a: 1, b: 2 })
  })

  test("async and sync writes apply in call order without clobbering", async () => {
    const { store } = await setup()
    const pending = store.update("a", () => 1)
    store.updateSync("a", () => 2)
    store.updateSync("b", () => 3)
    await pending
    expect(await store.load("a")).toBe(2)
    expect(await store.load("b")).toBe(3)
  })
})
