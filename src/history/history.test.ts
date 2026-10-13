import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addEntry,
  matchesFilter,
  QueryStore,
  addFavorite,
  removeEntry,
  validateEntries,
  relativeTime,
  type HistoryEntry,
} from "./history"

const NOW = new Date("2026-10-13T12:00:00Z")

function entry(query: string, ranAt = NOW.toISOString()): HistoryEntry {
  return { query, ranAt }
}

describe("addEntry", () => {
  test("prepends trimmed query", () => {
    expect(addEntry([entry("SELECT 1")], "  SELECT 2\n", NOW)).toEqual([
      entry("SELECT 2"),
      entry("SELECT 1"),
    ])
  })

  test("re-running moves an identical query to the top", () => {
    const old = "2026-10-01T00:00:00.000Z"
    const result = addEntry([entry("a", old), entry("b", old)], "b", NOW)
    expect(result).toEqual([entry("b"), entry("a", old)])
  })

  test("drops the oldest past the limit", () => {
    const entries = [entry("a"), entry("b"), entry("c")]
    expect(addEntry(entries, "d", NOW, 3).map((e) => e.query)).toEqual(["d", "a", "b"])
  })
})

describe("matchesFilter", () => {
  test("case-insensitive substring", () => {
    expect(matchesFilter("SELECT * FROM users", "USERS")).toBe(true)
    expect(matchesFilter("update orders set x = 1", "Set X")).toBe(true)
    expect(matchesFilter("SELECT 1", "users")).toBe(false)
  })

  test("blank filter matches everything", () => {
    expect(matchesFilter("SELECT 1", "  ")).toBe(true)
  })
})

describe("relativeTime", () => {
  const ago = (ms: number) => relativeTime(new Date(NOW.getTime() - ms), NOW)
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  test("buckets", () => {
    expect(ago(10_000)).toBe("now")
    expect(ago(3 * MIN)).toBe("3m")
    expect(ago(5 * HOUR)).toBe("5h")
    expect(ago(2 * DAY)).toBe("2d")
    expect(ago(65 * DAY)).toBe("2mo")
    expect(ago(800 * DAY)).toBe("2y")
  })

  test("future timestamps read as now", () => {
    expect(ago(-5 * MIN)).toBe("now")
  })
})

test("validateEntries drops malformed entries and rejects non-arrays", () => {
  expect(validateEntries([entry("x"), { query: 1 }])).toEqual([entry("x")])
  expect(validateEntries("nope")).toBeNull()
})

describe("favorites helpers", () => {
  test("addFavorite prepends new queries and ignores existing ones", () => {
    const old = "2026-10-01T00:00:00.000Z"
    const entries = [entry("a", old)]
    expect(addFavorite(entries, " b ", NOW)).toEqual([entry("b"), entry("a", old)])
    expect(addFavorite(entries, "a", NOW)).toBe(entries)
  })

  test("removeEntry drops the matching query", () => {
    expect(removeEntry([entry("a"), entry("b")], "a")).toEqual([entry("b")])
  })
})

describe("QueryStore", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function store(): Promise<{ store: QueryStore; path: string }> {
    dir = await mkdtemp(join(tmpdir(), "pg-explorer-history-"))
    const path = join(dir, "nested", "history.json")
    return { store: new QueryStore(path), path }
  }

  test("missing file loads empty", async () => {
    const { store: s } = await store()
    expect(await s.load("k")).toEqual([])
  })

  test("records per connection and persists", async () => {
    const { store: s, path } = await store()
    await s.update("one", (e) => addEntry(e, "SELECT 1", NOW))
    await s.update("two", (e) => addEntry(e, "SELECT 2", NOW))
    await s.update("one", (e) => addEntry(e, "SELECT 3", NOW))

    expect((await s.load("one")).map((e) => e.query)).toEqual(["SELECT 3", "SELECT 1"])
    expect((await s.load("two")).map((e) => e.query)).toEqual(["SELECT 2"])
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")))).toEqual(["one", "two"])
  })

  test("concurrent records are not lost", async () => {
    const { store: s } = await store()
    await Promise.all(["a", "b", "c", "d"].map((q) => s.update("k", (e) => addEntry(e, q, NOW))))
    expect((await s.load("k")).map((e) => e.query)).toEqual(["d", "c", "b", "a"])
  })

  test("corrupt file is treated as empty and overwritten", async () => {
    const { store: s, path } = await store()
    await s.update("k", (e) => addEntry(e, "SELECT 1", NOW))
    await writeFile(path, "{not json", "utf8")
    expect(await s.load("k")).toEqual([])
    await s.update("k", (e) => addEntry(e, "SELECT 2", NOW))
    expect((await s.load("k")).map((e) => e.query)).toEqual(["SELECT 2"])
  })
})
