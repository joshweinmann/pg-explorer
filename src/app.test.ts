import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { App } from "./app"
import type { DbConnection, QueryResult } from "./db/client"
import type { ColumnInfo, SchemaInfo } from "./db/metadata"
import { parseConfig, type StoredConfig } from "./config/config"
import { theme } from "./theme"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let setup: TestRendererSetup | null = null
let configDir: string | null = null

async function configPath(): Promise<string> {
  if (!configDir) configDir = await mkdtemp(join(tmpdir(), "pg-explorer-config-"))
  return join(configDir, "config")
}

afterEach(async () => {
  if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy()
  setup = null
  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    configDir = null
  }
})

const TEST_SCHEMAS: SchemaInfo[] = [
  {
    name: "app",
    tables: [
      { name: "users", kind: "table", columns: null },
      { name: "active_users", kind: "view", columns: null },
    ],
  },
  {
    name: "archive",
    tables: [{ name: "old_orders", kind: "table", columns: null }],
  },
]

const TEST_COLUMNS: ColumnInfo[] = [
  { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
  { name: "email", dataType: "text", nullable: false, isPrimaryKey: false, isForeignKey: false },
  { name: "org_id", dataType: "bigint", nullable: true, isPrimaryKey: false, isForeignKey: true },
]

function fakeDb(overrides: Partial<DbConnection> = {}): DbConnection {
  return {
    connected: true,
    connect: async () => {},
    disconnect: async () => {},
    execute: async (): Promise<QueryResult> => {
      throw new Error("not implemented")
    },
    loadSchemasAndTables: async () => TEST_SCHEMAS.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t })) })),
    loadTableColumns: async () => TEST_COLUMNS.map((c) => ({ ...c })),
    ...overrides,
  }
}

async function boot(
  width = 100,
  height = 30,
  db?: DbConnection,
): Promise<App> {
  setup = await createTestRenderer({ width, height, kittyKeyboard: true })
  const app = new App(setup.renderer, db, await configPath())
  await setup.flush()
  return app
}

function frameText(): string {
  return setup!.captureCharFrame()
}

describe("app skeleton", () => {
  test("renders header, panels, and placeholders", async () => {
    await boot()
    const frame = frameText()
    expect(frame).toContain("PG EXPLORER")
    expect(frame).toContain("● disconnected")
    expect(frame).toContain("not connected")
    expect(frame).toContain("no results yet")
  })

  test("editor starts focused", async () => {
    const app = await boot()
    expect(app.editor.textarea.focused).toBe(true)
    expect(app.sidebar.root.focused).toBe(false)
    expect(app.results.root.focused).toBe(false)
  })

  test("ctrl+1/2/3 switch panel focus", async () => {
    const app = await boot()
    const { mockInput, flush } = setup!

    mockInput.pressKey("1", { ctrl: true })
    await flush()
    expect(app.sidebar.root.hasFocusedDescendant).toBe(true)
    expect(app.editor.textarea.focused).toBe(false)

    mockInput.pressKey("3", { ctrl: true })
    await flush()
    expect(app.results.root.hasFocusedDescendant).toBe(true)

    mockInput.pressKey("2", { ctrl: true })
    await flush()
    expect(app.editor.textarea.focused).toBe(true)
  })

  test("ctrl+b toggles the sidebar and restores focus", async () => {
    const app = await boot()
    const { mockInput, flush } = setup!

    mockInput.pressKey("b", { ctrl: true })
    await flush()
    expect(app.sidebar.root.visible).toBe(false)
    expect(frameText()).not.toContain("not connected")

    mockInput.pressKey("1", { ctrl: true })
    await flush()
    expect(app.sidebar.root.visible).toBe(true)
    expect(app.sidebar.root.hasFocusedDescendant).toBe(true)

    mockInput.pressKey("b", { ctrl: true })
    await flush()
    expect(app.sidebar.root.visible).toBe(false)
    expect(app.editor.textarea.focused).toBe(true)
  })

  test("typing in the editor shows text", async () => {
    const app = await boot()
    const { mockInput, flush } = setup!

    await mockInput.typeText("SELECT 1")
    await flush()
    expect(app.editor.query).toBe("SELECT 1")
    expect(frameText()).toContain("SELECT 1")
  })

  test("empty query on ctrl+enter is a no-op", async () => {
    await boot()
    const { mockInput, flush } = setup!

    mockInput.pressEnter({ ctrl: true })
    await flush()
    expect(frameText()).toContain("no results yet")
  })

  test("ctrl+q destroys the renderer", async () => {
    await boot()
    const { mockInput } = setup!

    mockInput.pressKey("q", { ctrl: true })
    expect(setup!.renderer.isDestroyed).toBe(true)
  })

  test("failed startup connection shows error in header and results", async () => {
    const app = await boot()
    await app.tryConnect({ host: "127.0.0.1", port: 1, user: "nobody", database: "none" })
    await setup!.flush()
    const frame = frameText()
    expect(frame).toContain("● error")
    expect(frame).toContain("connection failed:")
    expect(app.db.connected).toBe(false)
  })

  test("config error message is displayed", async () => {
    const app = await boot()
    app.showConfigError("bad toml")
    await setup!.flush()
    expect(frameText()).toContain("config error: bad toml")
  })
})

describe("query loop", () => {
  async function runQuery(query: string) {
    const { mockInput, flush } = setup!
    await mockInput.typeText(query)
    mockInput.pressEnter({ ctrl: true })
    await flush()
  }

  test("ctrl+enter renders rows result as a table with footer", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["id", "name"],
        rows: [
          [1, "alpha"],
          [2, "beta"],
        ],
        rowCount: 2,
        truncated: false,
        elapsedMs: 3.21,
      }),
    })
    await boot(100, 30, db)
    await runQuery("SELECT 1")

    const frame = frameText()
    expect(frame).toContain("id")
    expect(frame).toContain("name")
    expect(frame).toContain("alpha")
    expect(frame).toContain("beta")
    expect(frame).toContain("2 rows · page 1/1 · 3.2ms")
  })

  test("null and boolean cells render with markers", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["a", "b", "c"],
        rows: [[null, true, false]],
        rowCount: 1,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    await boot(100, 30, db)
    await runQuery("SELECT 1")

    const frame = frameText()
    expect(frame).toContain("∅")
    expect(frame).toContain("true")
    expect(frame).toContain("false")
  })

  test("command result shows tag and elapsed", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "command",
        commandTag: "INSERT",
        rowCount: 1,
        elapsedMs: 1.04,
      }),
    })
    await boot(100, 30, db)
    await runQuery("INSERT INTO t VALUES (1)")

    const frame = frameText()
    expect(frame).toContain("INSERT 1")
    expect(frame).toContain("INSERT 1 · 1.0ms")
  })

  test("query errors display in the results panel", async () => {
    const db = fakeDb({
      execute: async () => {
        throw new Error('relation "missing" does not exist')
      },
    })
    await boot(100, 30, db)
    await runQuery("SELECT * FROM missing")

    expect(frameText()).toContain('relation "missing" does not exist')
  })

  test("submit without a connection shows an error", async () => {
    await boot(100, 30, fakeDb({ connected: false }))
    await runQuery("SELECT 1")

    expect(frameText()).toContain("not connected to a database")
  })

  test("up and down move the row selection with a gray highlight", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
          [3, "c"],
        ],
        rowCount: 3,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    await boot(100, 30, db)
    await runQuery("SELECT 1")

    const { mockInput, flush } = setup!
    mockInput.pressKey("3", { ctrl: true })
    await flush()

    mockInput.pressArrow("up")
    await flush()
    expect(grayHighlighted("a")).toBe(true)

    for (let i = 0; i < 10; i++) mockInput.pressArrow("down")
    await flush()
    expect(grayHighlighted("c")).toBe(true)
    expect(grayHighlighted("b")).toBe(false)

    mockInput.pressArrow("up")
    await flush()
    expect(grayHighlighted("b")).toBe(true)
  })

  test("long result sets window with a sticky header", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`row-${String(i + 1).padStart(2, "0")}`])
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["value"],
        rows,
        rowCount: 30,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    await boot(100, 30, db)
    await runQuery("SELECT 1")

    const { mockInput, flush } = setup!
    mockInput.pressKey("3", { ctrl: true })
    await flush()
    expect(frameText()).toContain("row-01")

    for (let i = 0; i < 20; i++) mockInput.pressArrow("down")
    await flush()

    const frame = frameText()
    expect(frame).toContain("value")
    expect(frame).toContain("row-21")
    expect(frame).not.toContain("row-01")
  })

  test("wide tables with a scrollbar keep the bottom selected row visible", async () => {
    const wide = "x".repeat(50)
    const rows = Array.from({ length: 30 }, (_, i) => [
      `r${String(i + 1).padStart(2, "0")}`,
      wide,
      wide,
    ])
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["id", "b", "c"],
        rows,
        rowCount: 30,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    const app = await boot(100, 30, db)
    await runQuery("SELECT 1")

    expect(app.results.viewport.scrollWidth).toBeGreaterThan(90)

    const { mockInput, flush } = setup!
    mockInput.pressKey("3", { ctrl: true })
    await flush()

    for (let i = 0; i < 20; i++) mockInput.pressArrow("down")
    await flush()

    const frame = frameText()
    expect(frame).toContain("id")
    expect(frame).toContain("r21")
    expect(frame).not.toContain("r01")
  })

  test("pressing c copies the selected row as JSON", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
        ],
        rowCount: 2,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    const app = await boot(100, 30, db)
    await runQuery("SELECT 1")

    const { mockInput, flush } = setup!
    mockInput.pressKey("3", { ctrl: true })
    await flush()
    mockInput.pressArrow("down")
    await flush()
    await mockInput.typeText("c")
    await flush()

    expect(frameText()).toContain("copied row to clipboard")
    expect(app.results.selectedRowJson()).toBe('{"id":2,"name":"b"}')
  })

  test("clicking a results row selects it and double-click copies it", async () => {
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
        ],
        rowCount: 2,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    const app = await boot(100, 30, db)
    await runQuery("SELECT 1")
    await setup!.flush()

    const table = setup!.renderer.root.findDescendantById("results-table") as unknown as {
      screenY: number
    }
    const secondRowY = table.screenY + 4

    const { mockMouse, flush } = setup!
    await mockMouse.click(50, secondRowY)
    await flush()
    expect(app.results.selectedRowJson()).toBe('{"id":2,"name":"b"}')

    await mockMouse.doubleClick(50, secondRowY)
    await flush()
    expect(frameText()).toContain("copied row to clipboard")
  })

  function channelClose(actual: number, expected: number): boolean {
    return Math.abs(Math.round(actual * 255) - expected) <= 20
  }

  function grayHighlighted(text: string): boolean {
    const [r, g, b] = blendedRgb(theme.selectBg)
    return setup!
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .some(
        (span) =>
          span.text.includes(text) &&
          channelClose(span.bg.r, r) &&
          channelClose(span.bg.g, g) &&
          channelClose(span.bg.b, b),
      )
  }

  test("pagedown and n/p page through results only when results focused", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`r${i + 1}`])
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["v"],
        rows,
        rowCount: 120,
        truncated: false,
        elapsedMs: 2,
      }),
    })
    const app = await boot(100, 30, db)
    await runQuery("SELECT 1")
    expect(frameText()).toContain("120 rows · page 1/3 · 2.0ms")

    const { mockInput, flush } = setup!
    mockInput.pressKey("pagedown")
    await flush()
    expect(frameText()).toContain("page 1/3")

    mockInput.pressKey("3", { ctrl: true })
    await flush()
    mockInput.pressKey("pagedown")
    await flush()
    expect(frameText()).toContain("page 2/3")

    mockInput.pressKey("n")
    await flush()
    expect(frameText()).toContain("page 3/3")

    mockInput.pressKey("n")
    await flush()
    expect(frameText()).toContain("page 3/3")

    mockInput.pressKey("p")
    await flush()
    expect(frameText()).toContain("page 2/3")

    mockInput.pressKey("2", { ctrl: true })
    await flush()
    mockInput.typeText("n")
    await flush()
    expect(frameText()).toContain("page 2/3")
    expect(app.editor.query).toContain("n")
  })

  test("wide tables keep intrinsic widths, truncate long cells, and scroll sideways", async () => {
    const longValue = "x".repeat(60)
    const db = fakeDb({
      execute: async () => ({
        kind: "rows",
        columns: ["a", "b", "c"],
        rows: [
          [longValue, longValue, longValue],
          [longValue, longValue, longValue],
        ],
        rowCount: 2,
        truncated: false,
        elapsedMs: 1,
      }),
    })
    const app = await boot(100, 30, db)
    await runQuery("SELECT 1")

    expect(frameText()).toContain("…")
    expect(app.results.viewport.scrollWidth).toBeGreaterThan(90)
    expect(app.results.viewport.scrollLeft).toBe(0)

    const { mockInput, flush } = setup!
    mockInput.pressKey("3", { ctrl: true })
    await flush()
    mockInput.pressArrow("right")
    await flush()
    expect(app.results.viewport.scrollLeft).toBeGreaterThan(0)
  })

  test("slow queries show a running indicator until they resolve", async () => {
    let resolveQuery: (() => void) | undefined
    const db = fakeDb({
      execute: () =>
        new Promise<QueryResult>((resolve) => {
          resolveQuery = () =>
            resolve({
              kind: "rows",
              columns: ["x"],
              rows: [[1]],
              rowCount: 1,
              truncated: false,
              elapsedMs: 1,
            })
        }),
    })
    const app = await boot(100, 30, db)
    const { mockInput, flush } = setup!

    await mockInput.typeText("SELECT pg_sleep(1)")
    mockInput.pressEnter({ ctrl: true })
    await flush()
    expect(frameText()).toContain("running…")

    resolveQuery?.()
    await flush()
    const frame = frameText()
    expect(frame).not.toContain("running…")
    expect(frame).toContain("1 row · page 1/1 · 1.0ms")
    expect(app.db.connected).toBe(true)
  })

  test("editor height grows with lines but stays within 60% of the terminal", async () => {
    const app = await boot(100, 30)
    const { mockInput, flush } = setup!

    for (let i = 0; i < 30; i++) mockInput.pressEnter()
    await flush()
    expect(app.editor.root.height).toBe(18)
  })

  test("line numbers render for every line", async () => {
    await boot(100, 30)
    const { mockInput, flush } = setup!

    await mockInput.typeText("SELECT 1")
    mockInput.pressEnter()
    await mockInput.typeText("SELECT 2")
    await flush()

    const frame = frameText()
    expect(frame).toContain("1 SELECT 1")
    expect(frame).toContain("2 SELECT 2")
  })

  test("SQL keywords, strings, and numbers are highlighted", async () => {
    await boot(100, 30)
    const { mockInput, flush } = setup!

    await mockInput.typeText("SELECT 'x' -- note")
    await flush()

    const [kr, kg, kb] = hexToRgb(theme.keyword)
    const [sr, sg, sb] = hexToRgb(theme.string)
    const [cr, cg, cb] = hexToRgb(theme.comment)

    const spans = setup!.captureSpans().lines.flatMap((line) => line.spans)
    const hasKeyword = spans.some(
      (span) =>
        span.text.includes("SELECT") &&
        Math.round(span.fg.r * 255) === kr &&
        Math.round(span.fg.g * 255) === kg &&
        Math.round(span.fg.b * 255) === kb,
    )
    const hasString = spans.some(
      (span) =>
        span.text.includes("'x'") &&
        Math.round(span.fg.r * 255) === sr &&
        Math.round(span.fg.g * 255) === sg &&
        Math.round(span.fg.b * 255) === sb,
    )
    const hasComment = spans.some(
      (span) =>
        span.text.includes("-- note") &&
        Math.round(span.fg.r * 255) === cr &&
        Math.round(span.fg.g * 255) === cg &&
        Math.round(span.fg.b * 255) === cb,
    )

    expect(hasKeyword).toBe(true)
    expect(hasString).toBe(true)
    expect(hasComment).toBe(true)
  })
})

describe("sidebar tree", () => {
  test("connect populates the sidebar with collapsed schemas", async () => {
    const app = await boot(100, 30, fakeDb())
    await app.tryConnect({ host: "h", port: 5432, user: "u", database: "d" })
    await setup!.flush()

    const frame = frameText()
    expect(frame).toContain("app")
    expect(frame).toContain("archive")
    expect(frame).not.toContain("users")
    expect(app.sidebar.visibleRowCount).toBe(2)
  })

  test("navigation, expansion, and lazy column loading", async () => {
    let columnLoads = 0
    const db = fakeDb({
      loadTableColumns: async () => {
        columnLoads++
        return TEST_COLUMNS.map((c) => ({ ...c }))
      },
    })
    const app = await boot(100, 30, db)
    await app.tryConnect({ host: "h", port: 5432, user: "u", database: "d" })
    await setup!.flush()

    const { mockInput, flush } = setup!
    mockInput.pressKey("1", { ctrl: true })
    await flush()

    mockInput.pressArrow("up")
    await flush()
    expect(app.sidebar.cursor).toBe(0)

    mockInput.pressEnter()
    await flush()
    expect(frameText()).toContain("users")
    expect(frameText()).toContain("active_users (view)")

    mockInput.pressArrow("down")
    await flush()
    mockInput.pressEnter()
    await flush()
    expect(columnLoads).toBe(1)

    const frame = frameText()
    expect(frame).toContain("id :integer")
    expect(frame).toContain("email :text")
    expect(frame).toContain("org_id :bigint")
    expect(frame).toContain("[PK]")
    expect(frame).toContain("[FK]")
    expect(frame).toContain("NN")

    mockInput.pressEnter()
    await flush()
    mockInput.pressEnter()
    await flush()
    expect(columnLoads).toBe(1)

    mockInput.pressArrow("down")
    await flush()
    mockInput.pressArrow("down")
    await flush()
    mockInput.pressArrow("down")
    await flush()
    mockInput.pressArrow("down")
    await flush()
    expect(app.sidebar.cursor).toBe(5)
  })

  test("r refreshes schemas when connected", async () => {
    let schemaLoads = 0
    const db = fakeDb({
      loadSchemasAndTables: async () => {
        schemaLoads++
        return TEST_SCHEMAS.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t })) }))
      },
    })
    const app = await boot(100, 30, db)
    await app.tryConnect({ host: "h", port: 5432, user: "u", database: "d" })
    await setup!.flush()
    expect(schemaLoads).toBe(1)

    const { mockInput, flush } = setup!
    mockInput.pressKey("1", { ctrl: true })
    await flush()
    mockInput.typeText("r")
    await flush()
    expect(schemaLoads).toBe(2)
  })

  test("column load failure shows a metadata error", async () => {
    const db = fakeDb({
      loadTableColumns: async () => {
        throw new Error("permission denied")
      },
    })
    const app = await boot(100, 30, db)
    await app.tryConnect({ host: "h", port: 5432, user: "u", database: "d" })
    await setup!.flush()

    const { mockInput, flush } = setup!
    mockInput.pressKey("1", { ctrl: true })
    await flush()
    mockInput.pressEnter()
    await flush()
    mockInput.pressArrow("down")
    await flush()
    mockInput.pressEnter()
    await flush()

    const frame = frameText()
    expect(frame).toContain("metadata error: permission")
    expect(frame).toContain("denied")
  })
})

describe("focus cycling", () => {
  test("tab cycles forward and shift+tab cycles backward", async () => {
    const app = await boot()
    const { mockInput, flush } = setup!

    mockInput.pressTab()
    await flush()
    expect(app.state.focus).toBe("results")

    mockInput.pressTab()
    await flush()
    expect(app.state.focus).toBe("sidebar")

    mockInput.pressTab()
    await flush()
    expect(app.state.focus).toBe("editor")

    mockInput.pressTab({ shift: true })
    await flush()
    expect(app.state.focus).toBe("sidebar")

    mockInput.pressTab({ shift: true })
    await flush()
    expect(app.state.focus).toBe("results")
  })

  test("tab skips the hidden sidebar", async () => {
    const app = await boot()
    const { mockInput, flush } = setup!

    mockInput.pressKey("b", { ctrl: true })
    await flush()
    mockInput.pressTab()
    await flush()
    expect(app.state.focus).toBe("results")
    mockInput.pressTab()
    await flush()
    expect(app.state.focus).toBe("editor")
  })
})

describe("sidebar interaction", () => {
  const DBL_TEST_SCHEMAS: SchemaInfo[] = [
    {
      name: "app",
      tables: [
        { name: "users", kind: "table", columns: null },
        { name: "active_users", kind: "view", columns: null },
      ],
    },
    { name: "archive", tables: [{ name: "old_orders", kind: "table", columns: null }] },
  ]

  async function bootConnected(schemas: SchemaInfo[] = DBL_TEST_SCHEMAS, width = 100, height = 30) {
    const db = fakeDb({
      loadSchemasAndTables: async () => schemas.map((s) => ({ ...s, tables: s.tables.map((t) => ({ ...t })) })),
    })
    const app = await boot(width, height, db)
    await app.tryConnect({ host: "h", port: 5432, user: "u", database: "d" })
    await setup!.flush()
    return app
  }

  test("focusing the sidebar by any path (e.g. mouse click) activates its keys", async () => {
    const app = await bootConnected()
    const { mockInput, flush } = setup!

    app.sidebar.focus()
    await flush()
    expect(app.state.focus).toBe("sidebar")

    mockInput.pressArrow("down")
    await flush()
    expect(app.sidebar.cursor).toBe(1)
  })

  test("clicking a row selects it and double-click toggles expansion", async () => {
    const app = await bootConnected()
    const { mockMouse, flush } = setup!

    await mockMouse.click(5, 3)
    await flush()
    expect(app.sidebar.cursor).toBe(1)

    await mockMouse.doubleClick(5, 2)
    await flush()
    expect(frameText()).toContain("users")

    await mockMouse.doubleClick(5, 3)
    await flush()
    expect(frameText()).toContain("id :integer")

    await mockMouse.doubleClick(5, 3)
    await flush()
    expect(frameText()).not.toContain("id :integer")
  })

  test("selection uses a light gray background instead of inverse", async () => {
    await bootConnected()
    const frame = setup!.captureSpans()
    const [r, g, b] = blendedRgb(theme.selectBg)
    const hasSelectionBg = frame.lines.some((line) =>
      line.spans.some(
        (span) =>
          channelClose(span.bg.r, r) &&
          channelClose(span.bg.g, g) &&
          channelClose(span.bg.b, b),
      ),
    )
    expect(hasSelectionBg).toBe(true)
  })

  test("sidebar width auto-fits to the widest visible row with a cap", async () => {
    const app = await bootConnected([
      {
        name: "a_schema_with_a_very_long_name_measuring_over_forty_characters",
        tables: [{ name: "t", kind: "table", columns: null }],
      },
    ])
    const { mockInput, flush } = setup!

    expect(app.sidebar.root.width).toBe(50)

    mockInput.pressKey("1", { ctrl: true })
    await flush()
    mockInput.pressEnter()
    await flush()
    expect(app.sidebar.root.width).toBe(50)
  })

  test("cursor movement scrolls the list at the edges", async () => {
    const manyTables = Array.from({ length: 40 }, (_, i) => ({
      name: `table_${String(i).padStart(2, "0")}`,
      kind: "table" as const,
      columns: null,
    }))
    const app = await bootConnected([{ name: "bulk", tables: manyTables }])
    const { mockInput, flush } = setup!

    mockInput.pressKey("1", { ctrl: true })
    await flush()
    mockInput.pressEnter()
    await flush()
    expect(app.sidebar.visibleRowCount).toBe(41)
    expect(app.sidebar.viewport.scrollTop).toBe(0)

    for (let i = 0; i < 35; i++) mockInput.pressArrow("down")
    await flush()
    expect(app.sidebar.cursor).toBe(35)
    expect(app.sidebar.viewport.scrollTop).toBeGreaterThan(0)
  })
})

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function blendedRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  const alpha = hex.length > 7 ? parseInt(hex.slice(7, 9), 16) / 255 : 1
  return [r, g, b].map((v) => Math.round(v * alpha)) as [number, number, number]
}

function channelClose(actual: number, expected: number): boolean {
  return Math.abs(Math.round(actual * 255) - expected) <= 20
}

describe("connection dialog", () => {
  const PREFILL: StoredConfig = {
    host: "dbhost",
    port: 5433,
    user: "alice",
    database: "widgets",
  }

  test("ctrl+o opens the dialog and enter submits from any field", async () => {
    const connects: StoredConfig[] = []
    const db = fakeDb({
      connect: async (config) => {
        connects.push(config)
      },
    })
    const app = await boot(100, 30, db)
    const { mockInput, flush } = setup!

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    const frame = frameText()
    expect(frame).toContain("CONNECT TO POSTGRES")
    expect(frame).toContain("host")
    expect(frame).toContain("password")
    expect(app.dialog.isOpen).toBe(true)
    expect(app.dialog.focusedFieldIndex).toBe(0)

    mockInput.pressEnter()
    await flush()
    expect(app.dialog.isOpen).toBe(false)
    expect(connects.length).toBe(1)
  })

  test("up and down move between dialog fields", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(0)

    mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(1)

    mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(2)

    mockInput.pressArrow("up")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(1)

    mockInput.pressArrow("up")
    await flush()
    mockInput.pressArrow("up")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(0)

    for (let i = 0; i < 6; i++) mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(4)

    mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(4)
  })

  test("escape cancels and restores editor focus", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    mockInput.pressEscape()
    await flush()
    expect(app.dialog.isOpen).toBe(false)
    expect(app.editor.textarea.focused).toBe(true)
  })

  test("prefilled dialog focuses the password field and masks input", async () => {
    const app = await boot(100, 30, fakeDb())
    app.openConnectionDialog(PREFILL)
    await setup!.flush()

    expect(app.dialog.focusedFieldIndex).toBe(4)
    expect(frameText()).toContain("dbhost")

    const { mockInput, flush } = setup!
    await mockInput.typeText("secret")
    await flush()
    const frame = frameText()
    expect(frame).toContain("••••••")
    expect(frame).not.toContain("secret")
    expect(app.dialog.getValues().password).toBe("secret")
  })

  test("submitting from the password field connects and saves config without password", async () => {
    const connects: StoredConfig[] = []
    const db = fakeDb({
      connect: async (config) => {
        connects.push(config)
      },
    })
    const app = await boot(100, 30, db)
    app.openConnectionDialog(PREFILL)
    await setup!.flush()

    const { mockInput, flush } = setup!
    await mockInput.typeText("pw")
    mockInput.pressEnter()
    await flush()

    expect(app.dialog.isOpen).toBe(false)
    expect(connects).toEqual([{ ...PREFILL, password: "pw" }])
    expect(frameText()).toContain("● alice@dbhost:5433/widgets")
    expect(app.sidebar.visibleRowCount).toBe(2)

    const saved = parseConfig(await readFile(await configPath(), "utf8"))
    expect(saved).toEqual(PREFILL)
  })

  test("failed connect keeps the dialog open with the error", async () => {
    const db = fakeDb({
      connect: async () => {
        throw new Error("authentication failed")
      },
    })
    const app = await boot(100, 30, db)
    app.openConnectionDialog(PREFILL)
    await setup!.flush()

    const { mockInput, flush } = setup!
    await mockInput.typeText("pw")
    mockInput.pressEnter()
    await flush()

    expect(app.dialog.isOpen).toBe(true)
    expect(frameText()).toContain("authentication failed")
  })

  test("invalid port shows a validation error", async () => {
    const app = await boot(100, 30, fakeDb())
    app.openConnectionDialog({ host: "h", port: 99999, user: "u", database: "d" })
    await setup!.flush()

    const { mockInput, flush } = setup!
    await mockInput.typeText("pw")
    mockInput.pressEnter()
    await flush()

    expect(app.dialog.isOpen).toBe(true)
    expect(frameText()).toContain("port must be a number between 1 and 65535")
  })

  test("startup with a hand-added password auto-connects", async () => {
    let connects = 0
    const db = fakeDb({
      connect: async () => {
        connects++
      },
    })
    const app = await boot(100, 30, db)
    app.startup({ host: "h", port: 5432, user: "u", database: "d", password: "p" })
    await setup!.flush()

    expect(connects).toBe(1)
    expect(app.dialog.isOpen).toBe(false)
  })

  test("startup without a password opens the prefilled dialog", async () => {
    const app = await boot(100, 30, fakeDb())
    app.startup(PREFILL)
    await setup!.flush()

    expect(app.dialog.isOpen).toBe(true)
    expect(app.dialog.focusedFieldIndex).toBe(4)
  })

  test("startup with no config stays disconnected", async () => {
    const app = await boot(100, 30, fakeDb())
    app.startup(null)
    await setup!.flush()

    expect(app.dialog.isOpen).toBe(false)
  })
})

describe("help dialog", () => {
  test("ctrl+h opens the shortcuts dialog and esc closes it", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("h", { ctrl: true })
    await flush()
    expect(app.helpDialog.isOpen).toBe(true)
    const frame = frameText()
    expect(frame).toContain("KEYBOARD SHORTCUTS")
    expect(frame).toContain("ctrl+enter")
    expect(frame).toContain("double-click")

    mockInput.pressEscape()
    await flush()
    expect(app.helpDialog.isOpen).toBe(false)
  })

  test("ctrl+h toggles the dialog closed when open", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("h", { ctrl: true })
    await flush()
    mockInput.pressKey("h", { ctrl: true })
    await flush()
    expect(app.helpDialog.isOpen).toBe(false)
  })

  test("panel keys are swallowed while help is open", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("h", { ctrl: true })
    await flush()
    mockInput.pressKey("3", { ctrl: true })
    await flush()
    expect(app.helpDialog.isOpen).toBe(true)
    expect(app.state.focus).toBe("editor")
  })

  test("ctrl+h is ignored while the connection dialog is open", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    mockInput.pressKey("h", { ctrl: true })
    await flush()
    expect(app.helpDialog.isOpen).toBe(false)
    expect(app.dialog.isOpen).toBe(true)
  })
})
