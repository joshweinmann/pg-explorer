import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { App } from "./app"
import type { DbConnection, QueryResult } from "./db/client"
import type { ColumnInfo, SchemaInfo } from "./db/metadata"
import { parseConfig, type StoredConfig } from "./config/config"
import { theme } from "./theme"
import { appPathsIn } from "./config/paths"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
  const path = await configPath()
  const app = new App(setup.renderer, db, appPathsIn(dirname(path)))
  await setup.flush()
  return app
}

function frameText(): string {
  return setup!.captureCharFrame()
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await setup!.flush()
  }
  expect(condition()).toBe(true)
  await setup!.flush()
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

  test("failed saved-connection connect shows error and opens the prefilled dialog", async () => {
    const app = await boot()
    await app.tryConnect({ host: "127.0.0.1", port: 1, user: "nobody", database: "none", password: "x" })
    await setup!.flush()
    expect(frameText()).toContain("● error")
    expect(app.dialog.isOpen).toBe(true)
    expect(app.dialog.getValues().user).toBe("nobody")
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
    mockInput.pressEnter()
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
    mockInput.pressEnter()
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

    for (let i = 0; i < 8; i++) mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(6)

    mockInput.pressArrow("down")
    await flush()
    expect(app.dialog.focusedFieldIndex).toBe(6)
  })

  test("escape cancels and restores editor focus", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    mockInput.pressEnter()
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

    expect(app.dialog.focusedFieldIndex).toBe(5)
    expect(frameText()).toContain("dbhost")

    const { mockInput, flush } = setup!
    await mockInput.typeText("secret")
    await flush()
    const frame = frameText()
    expect(frame).toContain("••••••")
    expect(frame).not.toContain("secret")
    expect(app.dialog.getValues().password).toBe("secret")
  })

  test("submitting from the password field connects and saves config with password", async () => {
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
    expect(saved).toEqual({ connections: [{ ...PREFILL, password: "pw" }] })
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

  test("startup opens the connections picker", async () => {
    const app = await boot(100, 30, fakeDb())
    app.startup({ connections: [PREFILL] })
    await setup!.flush()

    expect(app.connectionPicker.isOpen).toBe(true)
    const frame = frameText()
    expect(frame).toContain("Connections")
    expect(frame).toContain("+ new connection")
    expect(frame).toContain("alice@dbhost:5433/widgets")
  })
})

describe("connections picker", () => {
  const A: StoredConfig = { host: "a.host", port: 5432, user: "u", database: "a", password: "pa" }
  const B: StoredConfig = { host: "b.host", port: 5432, user: "u", database: "b" }

  async function bootWith(connections: StoredConfig[], connects: StoredConfig[] = []) {
    const db = fakeDb({
      connected: false,
      connect: async (config) => {
        connects.push(config)
        if (config.password === "bad") throw new Error("password authentication failed")
      },
    })
    const app = await boot(100, 30, db)
    app.startup({ connections })
    await setup!.flush()
    return app
  }

  function closePicker(app: App) {
    app.connectionPicker.close()
    app.focusPanel("editor")
  }

  async function savedConfig() {
    return parseConfig(await readFile(await configPath(), "utf8"))
  }

  test("preview shows connection details without the password", async () => {
    await bootWith([A])
    setup!.mockInput.pressArrow("down")
    await setup!.flush()
    const frame = frameText()
    expect(frame).toContain("a.host")
    expect(frame).toContain("password  saved")
    expect(frame).not.toContain("pa\n")
  })

  test("picking a connection with a saved password connects immediately", async () => {
    const connects: StoredConfig[] = []
    const app = await bootWith([A], connects)
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressEnter()
    await waitFor(() => connects.length === 1)

    expect(app.connectionPicker.isOpen).toBe(false)
    expect(app.dialog.isOpen).toBe(false)
    expect(frameText()).toContain("● u@a.host:5432/a")
  })

  test("picking a connection without a password opens the dialog on the password field", async () => {
    const app = await bootWith([A, B])
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressArrow("down")
    mockInput.pressEnter()
    await flush()

    expect(app.dialog.isOpen).toBe(true)
    expect(app.dialog.getValues().host).toBe("b.host")
    expect(app.dialog.focusedFieldIndex).toBe(5)
  })

  test("successful connect saves the password and moves it to the top", async () => {
    const app = await bootWith([A, B])
    app.openConnectionDialog(B)
    await setup!.flush()
    await setup!.mockInput.typeText("pb")
    setup!.mockInput.pressEnter()
    await waitFor(() => !app.dialog.isOpen)

    expect((await savedConfig()).connections).toEqual([{ ...B, password: "pb" }, A])
  })

  test("ctrl+o marks the active connection", async () => {
    const app = await bootWith([A, B])
    closePicker(app)
    await app.tryConnect(A)
    await setup!.flush()
    setup!.mockInput.pressKey("o", { ctrl: true })
    await setup!.flush()
    expect(frameText()).toContain("● u@a.host:5432/a")
    expect(frameText()).toContain("  u@b.host:5432/b")
  })

  test("ctrl+e edits a connection and replaces it", async () => {
    const app = await bootWith([A, B])
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressKey("e", { ctrl: true })
    await flush()
    expect(app.dialog.isOpen).toBe(true)
    expect(app.dialog.focusedFieldIndex).toBe(0)

    for (let i = 0; i < 4; i++) mockInput.pressArrow("down")
    await flush()
    for (let i = 0; i < 5; i++) mockInput.pressBackspace()
    await mockInput.typeText("renamed")
    mockInput.pressEnter()
    await waitFor(() => !app.dialog.isOpen)

    const ids = (await savedConfig()).connections.map((c) => c.database)
    expect(ids).toEqual(["renamed", "b"])
  })

  test("named connections show their name in the picker and header", async () => {
    const named = { ...A, name: "Prod Duck Lake", notes: "needs tunnel" }
    const app = await bootWith([named, B])
    expect(frameText()).toContain("Prod Duck Lake")
    expect(frameText()).toContain("u@a.host:5432/a")

    await setup!.mockInput.typeText("tunnel")
    await waitFor(() => app.connectionPicker.picker.visibleItems.length === 2)

    closePicker(app)
    await app.tryConnect(named)
    await setup!.flush()
    expect(frameText()).toContain("● Prod Duck Lake")
  })

  test("ctrl+d asks for confirmation, a second ctrl+d deletes", async () => {
    const app = await bootWith([A, B])
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressKey("d", { ctrl: true })
    await flush()
    expect(frameText()).toContain("ctrl+d again to confirm")
    expect(app.connectionPicker.picker.visibleItems).toHaveLength(3)

    mockInput.pressKey("d", { ctrl: true })
    await waitFor(() => app.connectionPicker.picker.visibleItems.length === 2)
    expect((await savedConfig()).connections).toEqual([B])
  })

  test("any other key cancels a pending delete", async () => {
    const app = await bootWith([A])
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressKey("d", { ctrl: true })
    mockInput.pressArrow("up")
    mockInput.pressArrow("down")
    mockInput.pressKey("d", { ctrl: true })
    await flush()
    expect(app.connectionPicker.picker.visibleItems).toHaveLength(2)
    expect(frameText()).toContain("ctrl+d again to confirm")
  })

  test("failed connect from the picker opens the dialog with the error", async () => {
    const app = await bootWith([{ ...A, password: "bad" }])
    const { mockInput } = setup!
    mockInput.pressArrow("down")
    mockInput.pressEnter()
    await waitFor(() => app.dialog.isOpen)
    expect(frameText()).toContain("password authentication failed")
  })

  test("switching connections swaps to that connection's tabs", async () => {
    const app = await bootWith([A, { ...B, password: "pb" }])
    closePicker(app)
    await app.tryConnect(A)
    app.editor.setQuery("SELECT 'a'")
    app.results.showMessage("old results", theme.success)

    await app.tryConnect({ ...B, password: "pb" })
    await setup!.flush()
    expect(app.tabs.all).toHaveLength(1)
    expect(app.editor.query).toBe("")
    expect(frameText()).not.toContain("old results")

    await app.tryConnect(A)
    await setup!.flush()
    expect(app.editor.query).toBe("SELECT 'a'")
  })

  test("cancelling an edit does not delete that connection on a later connect", async () => {
    const app = await bootWith([A, { ...B, password: "pb" }])
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    mockInput.pressKey("e", { ctrl: true })
    await flush()
    mockInput.pressEscape()
    await flush()

    mockInput.pressKey("o", { ctrl: true })
    await flush()
    mockInput.pressArrow("down")
    mockInput.pressArrow("down")
    mockInput.pressEnter()
    await waitFor(() => app.state.connection === "connected")

    const ids = (await savedConfig()).connections.map((c) => c.database).sort()
    expect(ids).toEqual(["a", "b"])
  })

  test("a config that failed to load is never overwritten", async () => {
    const app = await bootWith([])
    closePicker(app)
    app.showConfigError("invalid port in config: 0")
    await app.tryConnect(A)
    await setup!.flush()

    expect(app.state.connection).toBe("connected")
    expect(frameText()).toContain("config not saved")
    await expect(readFile(await configPath(), "utf8")).rejects.toThrow()
  })

  test("connecting from the picker gives the editor focus", async () => {
    const app = await bootWith([A])
    const { mockInput } = setup!
    mockInput.pressArrow("down")
    mockInput.pressEnter()
    await waitFor(() => app.state.connection === "connected")

    expect(app.editor.textarea.focused).toBe(true)
    await mockInput.typeText("select 1")
    expect(app.editor.query).toBe("select 1")
  })

  test("tab edits after a failed connect attempt are still saved", async () => {
    const app = await bootWith([A])
    closePicker(app)
    await app.tryConnect(A)
    await app.tryConnect({ ...B, password: "bad" })
    app.dialog.close()
    app.editor.setQuery("SELECT after failure")
    setup!.renderer.destroy()

    const saved = JSON.parse(await readFile(join(dirname(await configPath()), "tabs.json"), "utf8"))
    expect(saved["u@a.host:5432/a"].tabs[0].query).toBe("SELECT after failure")
  })

  test("a pending tab save never lands under the next connection's key", async () => {
    const app = await bootWith([A, { ...B, password: "pb" }])
    closePicker(app)
    await app.tryConnect(A)
    app.editor.setQuery("SELECT a")
    await app.tryConnect({ ...B, password: "pb" })
    app.editor.setQuery("SELECT b")
    await new Promise((resolve) => setTimeout(resolve, 400))

    const saved = JSON.parse(await readFile(join(dirname(await configPath()), "tabs.json"), "utf8"))
    expect(saved["u@a.host:5432/a"].tabs.map((t: { query: string }) => t.query)).toEqual(["SELECT a"])
    expect(saved["u@b.host:5432/b"].tabs.map((t: { query: string }) => t.query)).toEqual(["SELECT b"])
  })

  test("reconnecting to the same connection keeps the editor", async () => {
    const app = await bootWith([A])
    closePicker(app)
    await app.tryConnect(A)
    app.editor.setQuery("SELECT 1")
    await app.tryConnect(A)
    expect(app.editor.query).toBe("SELECT 1")
  })
})

describe("editor undo/redo", () => {
  test("ctrl+z undoes and ctrl+shift+z redoes edits", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    await mockInput.typeText("SELECT 1")
    await flush()
    expect(app.editor.query).toBe("SELECT 1")

    mockInput.pressKey("z", { ctrl: true })
    await flush()
    const undone = app.editor.query
    expect(undone).not.toBe("SELECT 1")

    mockInput.pressKey("z", { ctrl: true, shift: true })
    await flush()
    expect(app.editor.query).toBe("SELECT 1")
  })
})

describe("run target", () => {
  function recordingDb(executed: string[]): DbConnection {
    return fakeDb({
      execute: async (query: string) => {
        executed.push(query)
        return { kind: "command", commandTag: "SELECT", rowCount: 0, elapsedMs: 1 }
      },
    })
  }

  function gutterHasRunBg(lineNumber: number, lineText: string): boolean {
    const [r, g, b] = hexToRgb(theme.runGutterBg)
    const row = setup!.captureSpans().lines.find((line) =>
      line.spans.map((span) => span.text).join("").includes(lineText),
    )
    const span = row?.spans.find((s) => s.text.trim() === String(lineNumber))
    if (!span) throw new Error(`gutter span for line ${lineNumber} not found`)
    return channelClose(span.bg.r, r) && channelClose(span.bg.g, g) && channelClose(span.bg.b, b)
  }

  async function typeLines(lines: string[]) {
    const { mockInput } = setup!
    for (const [i, line] of lines.entries()) {
      if (i > 0) mockInput.pressEnter()
      await mockInput.typeText(line)
    }
  }

  test("ctrl+enter runs only the statement under the cursor", async () => {
    const executed: string[] = []
    await boot(100, 30, recordingDb(executed))
    const { mockInput, flush } = setup!

    await typeLines(["SELECT 1;", "SELECT 2;", "SELECT 3;"])
    mockInput.pressArrow("up")
    mockInput.pressEnter({ ctrl: true })
    await flush()

    expect(executed).toEqual(["SELECT 2;"])
  })

  test("a selection is ignored; the statement under the cursor runs", async () => {
    const executed: string[] = []
    await boot(100, 30, recordingDb(executed))
    const { mockInput, flush } = setup!

    await typeLines(["SELECT 1;", "SELECT 2;"])
    for (let i = 0; i < 12; i++) mockInput.pressArrow("left", { shift: true })
    mockInput.pressEnter({ ctrl: true })
    await flush()

    expect(executed).toEqual(["SELECT 1;"])
  })

  test("wide characters do not shift which statement runs", async () => {
    const executed: string[] = []
    const app = await boot(100, 30, recordingDb(executed))
    const { mockInput, flush } = setup!
    const ta = app.editor.textarea

    ta.setText("select '日本😀';\nselect 2;\nselect 3;")
    ta.gotoLine(1)
    ta.gotoLineEnd()
    mockInput.pressEnter({ ctrl: true })
    await flush()

    expect(executed).toEqual(["select 2;"])
  })

  test("gutter marks the lines that will run, only while editor is focused", async () => {
    await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!

    await typeLines(["SELECT 1;", "SELECT 2", "  FROM t;"])
    await flush()
    expect(gutterHasRunBg(1, "SELECT 1;")).toBe(false)
    expect(gutterHasRunBg(2, "SELECT 2")).toBe(true)
    expect(gutterHasRunBg(3, "FROM t;")).toBe(true)
    const [r, g, b] = hexToRgb(theme.runGutterBg)
    const codeTinted = setup!
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .some(
        (span) =>
          span.text.includes("FROM") &&
          channelClose(span.bg.r, r) &&
          channelClose(span.bg.g, g) &&
          channelClose(span.bg.b, b),
      )
    expect(codeTinted).toBe(false)

    mockInput.pressArrow("up")
    mockInput.pressArrow("up")
    await flush()
    expect(gutterHasRunBg(1, "SELECT 1;")).toBe(true)
    expect(gutterHasRunBg(2, "SELECT 2")).toBe(false)

    mockInput.pressKey("3", { ctrl: true })
    await flush()
    expect(gutterHasRunBg(1, "SELECT 1;")).toBe(false)
  })
})

describe("results header sort", () => {
  function rowsResult(rows: unknown[][], truncated = false): QueryResult {
    return {
      kind: "rows",
      columns: ["id", "name"],
      rows,
      rowCount: rows.length,
      truncated,
      maxRows: truncated ? rows.length : undefined,
      elapsedMs: 1,
    }
  }

  async function clickHeader(name: string) {
    const table = setup!.renderer.root.findDescendantById("results-table") as unknown as {
      screenY: number
    }
    const line = frameText().split("\n")[table.screenY]!
    const x = line.indexOf(` ${name}`) + 1
    if (x <= 0) throw new Error(`header ${name} not found in: ${line}`)
    await setup!.mockMouse.click(x, table.screenY)
    await setup!.flush()
  }

  async function run() {
    const { mockInput, flush } = setup!
    await mockInput.typeText("SELECT 1")
    mockInput.pressEnter({ ctrl: true })
    await flush()
  }

  function firstRow(app: App): string | null {
    app.results.goToSelectionEdge(true)
    return app.results.selectedRowJson()
  }

  test("clicking a header cycles asc → desc → original order in memory", async () => {
    let calls = 0
    const db = fakeDb({
      execute: async () => {
        calls++
        return rowsResult([
          [1, "b"],
          [2, "c"],
          [3, "a"],
        ])
      },
    })
    const app = await boot(100, 30, db)
    await run()

    await clickHeader("name")
    expect(firstRow(app)).toBe('{"id":3,"name":"a"}')
    expect(frameText()).toContain("name ▲")

    await clickHeader("name")
    expect(firstRow(app)).toBe('{"id":2,"name":"c"}')
    expect(frameText()).toContain("name ▼")

    await clickHeader("name")
    expect(firstRow(app)).toBe('{"id":1,"name":"b"}')
    expect(frameText()).not.toContain("▲")
    expect(frameText()).not.toContain("▼")
    expect(calls).toBe(1)
  })

  test("sorted header is drawn in the focus color", async () => {
    await boot(100, 30, fakeDb({ execute: async () => rowsResult([[1, "x"]]) }))
    await run()
    await clickHeader("id")

    const [r, g, b] = hexToRgb(theme.focus)
    const spans = setup!.captureSpans().lines.flatMap((line) => line.spans)
    const header = spans.find((span) => span.text.includes("id ▲"))
    expect(header).toBeDefined()
    expect(channelClose(header!.fg.r, r) && channelClose(header!.fg.g, g) && channelClose(header!.fg.b, b)).toBe(true)
  })

  test("capped results re-run with ORDER BY, and off re-runs the original", async () => {
    const executed: string[] = []
    const db = fakeDb({
      execute: async (query: string) => {
        executed.push(query)
        return rowsResult([[1, "a"]], true)
      },
    })
    const app = await boot(100, 30, db)
    await run()

    await clickHeader("name")
    expect(executed[1]).toBe("SELECT * FROM (\nSELECT 1\n) AS sorted ORDER BY 2 ASC")
    expect(app.results.sortState).toEqual({ column: 1, dir: "asc" })
    expect(frameText()).toContain("name ▲")

    await clickHeader("name")
    expect(executed[2]).toBe("SELECT * FROM (\nSELECT 1\n) AS sorted ORDER BY 2 DESC")

    await clickHeader("name")
    expect(executed[3]).toBe("SELECT 1")
    expect(app.results.sortState).toBeNull()
  })

  test("capped results from a writing query sort in memory and say so", async () => {
    const executed: string[] = []
    const db = fakeDb({
      execute: async (query: string) => {
        executed.push(query)
        return rowsResult([[1, "b"], [2, "a"]], true)
      },
    })
    const app = await boot(100, 30, db)
    const { mockInput, flush } = setup!
    await mockInput.typeText("INSERT INTO t VALUES (1) RETURNING *")
    mockInput.pressEnter({ ctrl: true })
    await flush()

    await clickHeader("name")
    expect(executed).toHaveLength(1)
    expect(firstRow(app)).toBe('{"id":2,"name":"a"}')
    expect(frameText()).toContain("sorted fetched rows")
  })

  test("a failed sort re-run keeps the current rows", async () => {
    let calls = 0
    const db = fakeDb({
      execute: async () => {
        calls++
        if (calls > 1) throw new Error("permission denied")
        return rowsResult([[1, "b"], [2, "a"]], true)
      },
    })
    const app = await boot(100, 30, db)
    await run()

    await clickHeader("name")
    await waitFor(() => frameText().includes("sort failed: permission denied"))
    expect(firstRow(app)).toBe('{"id":1,"name":"b"}')
    expect(app.results.sortState).toBeNull()
    expect(frameText()).not.toContain("▲")
  })

  test("running a new query clears the sort", async () => {
    const app = await boot(100, 30, fakeDb({ execute: async () => rowsResult([[1, "x"]]) }))
    await run()
    await clickHeader("id")
    expect(app.results.sortState).not.toBeNull()

    app.focusPanel("editor")
    setup!.mockInput.pressEnter({ ctrl: true })
    await setup!.flush()
    expect(app.results.sortState).toBeNull()
  })
})

describe("query history", () => {
  const CONN = { host: "h", port: 5432, user: "u", database: "d" }

  async function bootConnected(execute: DbConnection["execute"]): Promise<App> {
    const app = await boot(100, 30, fakeDb({ execute }))
    await app.tryConnect(CONN)
    await setup!.flush()
    return app
  }

  async function runInEditor(app: App, query: string) {
    const { mockInput, flush } = setup!
    app.editor.setQuery(query)
    mockInput.pressEnter({ ctrl: true })
    await flush()
  }

  async function openHistory(app: App) {
    setup!.mockInput.pressKey("r", { ctrl: true })
    await waitFor(() => app.pickers.history.isOpen)
  }

  const ok: DbConnection["execute"] = async () => ({
    kind: "command",
    commandTag: "SELECT",
    rowCount: 1,
    elapsedMs: 1,
  })

  test("successful queries are listed newest first with a preview", async () => {
    const app = await bootConnected(ok)
    await runInEditor(app, "SELECT 1")
    await runInEditor(app, "SELECT *\nFROM users")

    await openHistory(app)
    expect(app.pickers.history.visibleItems.map((item) => item.value)).toEqual([
      "SELECT *\nFROM users",
      "SELECT 1",
    ])
    const frame = frameText()
    expect(frame).toContain("History")
    expect(frame).toContain("SELECT * FROM users")
    expect(frame).toContain("now")
  })

  test("failed queries are not recorded", async () => {
    const app = await bootConnected(async (query) => {
      if (query.includes("bad")) throw new Error("syntax error")
      return ok(query)
    })
    await runInEditor(app, "SELECT good")
    await runInEditor(app, "SELECT bad")

    await openHistory(app)
    expect(app.pickers.history.visibleItems.map((item) => item.value)).toEqual(["SELECT good"])
  })

  test("typing filters and enter replaces the editor content (undoable)", async () => {
    const app = await bootConnected(ok)
    await runInEditor(app, "SELECT * FROM users")
    await runInEditor(app, "SELECT * FROM orders")
    app.editor.setQuery("draft")

    await openHistory(app)
    const { mockInput, flush } = setup!
    await mockInput.typeText("USERS")
    await flush()
    expect(app.pickers.history.visibleItems.map((item) => item.value)).toEqual(["SELECT * FROM users"])

    mockInput.pressEnter()
    await flush()
    expect(app.pickers.history.isOpen).toBe(false)
    expect(app.editor.query).toBe("SELECT * FROM users")
    expect(app.state.focus).toBe("editor")

    mockInput.pressKey("z", { ctrl: true })
    await flush()
    expect(app.editor.query).toBe("draft")
  })

  test("arrow keys move the picker selection; esc closes", async () => {
    const app = await bootConnected(ok)
    await runInEditor(app, "SELECT 1")
    await runInEditor(app, "SELECT 2")

    await openHistory(app)
    const { mockInput, flush } = setup!
    mockInput.pressArrow("down")
    await flush()
    expect(app.pickers.history.selectedItem?.value).toBe("SELECT 1")

    mockInput.pressEscape()
    await flush()
    expect(app.pickers.history.isOpen).toBe(false)
    expect(app.editor.query).toBe("SELECT 2")
  })

  test("history is kept per connection", async () => {
    const app = await bootConnected(ok)
    await runInEditor(app, "SELECT 1")

    await app.tryConnect({ ...CONN, database: "other" })
    await setup!.flush()
    await openHistory(app)
    expect(app.pickers.history.visibleItems).toEqual([])
    expect(frameText()).toContain("no history yet for this connection")
  })

  test("not connected shows a hint", async () => {
    const app = await boot(100, 30, fakeDb())
    await openHistory(app)
    expect(frameText()).toContain("connect to a database to see its history")
  })

  test("history persists to the history file", async () => {
    const app = await bootConnected(ok)
    app.editor.setQuery("SELECT 42")
    await app.executeQuery()

    const file = join(dirname(await configPath()), "history.json")
    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved["u@h:5432/d"][0].query).toBe("SELECT 42")
  })
})

describe("favorites", () => {
  const CONN = { host: "h", port: 5432, user: "u", database: "d" }

  async function bootConnected(): Promise<App> {
    const app = await boot(
      100,
      30,
      fakeDb({ execute: async () => ({ kind: "command", commandTag: "SELECT", rowCount: 1, elapsedMs: 1 }) }),
    )
    await app.tryConnect(CONN)
    await setup!.flush()
    return app
  }

  async function saveFromEditor(app: App, query: string) {
    app.editor.setQuery(query)
    setup!.mockInput.pressKey("s", { ctrl: true })
    await waitFor(() => /favorite/.test(frameText()))
  }

  async function openFavorites(app: App) {
    setup!.mockInput.pressKey("f", { ctrl: true })
    await waitFor(() => app.pickers.favorites.isOpen)
  }

  test("ctrl+s in the editor saves the statement under the cursor", async () => {
    const app = await bootConnected()
    await saveFromEditor(app, "SELECT 1;\nSELECT 2;")
    expect(frameText()).toContain("saved to favorites")

    await openFavorites(app)
    expect(app.pickers.favorites.visibleItems.map((item) => item.value)).toEqual(["SELECT 2;"])
    expect(frameText()).toContain("Favorites")
  })

  test("saving an existing favorite is a no-op with a message", async () => {
    const app = await bootConnected()
    await saveFromEditor(app, "SELECT 1")
    app.results.showNotice("", theme.dim)
    await saveFromEditor(app, "SELECT 1")
    expect(frameText()).toContain("already a favorite")

    await openFavorites(app)
    expect(app.pickers.favorites.visibleItems).toHaveLength(1)
  })

  test("enter loads a favorite into the editor", async () => {
    const app = await bootConnected()
    await saveFromEditor(app, "SELECT 'fav'")
    app.editor.setQuery("other")

    await openFavorites(app)
    setup!.mockInput.pressEnter()
    await setup!.flush()
    expect(app.pickers.favorites.isOpen).toBe(false)
    expect(app.editor.query).toBe("SELECT 'fav'")
  })

  test("ctrl+s in the favorites picker removes the highlighted favorite", async () => {
    const app = await bootConnected()
    await saveFromEditor(app, "SELECT 1")
    await saveFromEditor(app, "SELECT 2")

    await openFavorites(app)
    setup!.mockInput.pressKey("s", { ctrl: true })
    await waitFor(() => app.pickers.favorites.visibleItems.length === 1)
    expect(app.pickers.favorites.visibleItems[0]!.value).toBe("SELECT 1")
    expect(frameText()).toContain("removed from favorites")
  })

  test("ctrl+s in the history picker stars the entry and marks it", async () => {
    const app = await bootConnected()
    app.editor.setQuery("SELECT 7")
    await app.executeQuery()

    setup!.mockInput.pressKey("r", { ctrl: true })
    await waitFor(() => app.pickers.history.isOpen)
    expect(frameText()).not.toContain("★")

    setup!.mockInput.pressKey("s", { ctrl: true })
    await waitFor(() => frameText().includes("★ SELECT 7"))
    expect(frameText()).toContain("saved to favorites")

    setup!.mockInput.pressKey("s", { ctrl: true })
    await setup!.flush()
    expect(frameText()).toContain("already a favorite")

    setup!.mockInput.pressEscape()
    await setup!.flush()
    await openFavorites(app)
    expect(app.pickers.favorites.visibleItems.map((item) => item.value)).toEqual(["SELECT 7"])
  })

  test("favorites are per connection; not connected shows a hint", async () => {
    const app = await bootConnected()
    await saveFromEditor(app, "SELECT 1")

    await app.tryConnect({ ...CONN, database: "other" })
    await setup!.flush()
    await openFavorites(app)
    expect(app.pickers.favorites.visibleItems).toEqual([])
  })

  test("ctrl+s while disconnected explains why nothing was saved", async () => {
    const app = await boot(100, 30, fakeDb())
    app.editor.setQuery("SELECT 1")
    setup!.mockInput.pressKey("s", { ctrl: true })
    await waitFor(() => frameText().includes("connect to a database to save favorites"))
  })
})

describe("tabs", () => {
  function tabNames(app: App): string[] {
    return app.tabs.all.map((tab) => tab.name)
  }

  function tabBarLine(): string {
    return frameText().split("\n").find((line) => line.includes(" 1 "))!
  }

  test("ctrl+t opens a new tab; each tab keeps its own SQL", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!
    await mockInput.typeText("SELECT 1")
    mockInput.pressKey("t", { ctrl: true })
    await flush()

    expect(tabNames(app)).toEqual(["NEW TAB", "NEW TAB"])
    expect(app.tabs.activeTabIndex).toBe(1)
    expect(app.editor.query).toBe("")
    expect(app.editor.textarea.focused).toBe(true)
    expect(tabBarLine()).toContain(" 1 NEW TAB │ 2 NEW TAB ")

    await mockInput.typeText("SELECT 2")
    mockInput.pressKey("1", { meta: true })
    await flush()
    expect(app.editor.query).toBe("SELECT 1")
    mockInput.pressKey("2", { meta: true })
    await flush()
    expect(app.editor.query).toBe("SELECT 2")
  })

  test("alt+number jumps and clicking a tab activates it", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, mockMouse, flush } = setup!
    mockInput.pressKey("t", { ctrl: true })
    mockInput.pressKey("t", { ctrl: true })
    await flush()

    mockInput.pressKey("1", { meta: true })
    await flush()
    expect(app.tabs.activeTabIndex).toBe(0)

    const bar = setup!.renderer.root.findDescendantById("tab-bar") as unknown as { screenX: number; screenY: number }
    const x = tabBarLine().indexOf("2 NEW TAB")
    await mockMouse.click(x, bar.screenY)
    await flush()
    expect(app.tabs.activeTabIndex).toBe(1)
  })

  test("ctrl+w closes an empty tab immediately", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!
    mockInput.pressKey("t", { ctrl: true })
    await flush()
    mockInput.pressKey("w", { ctrl: true })
    await flush()
    expect(tabNames(app)).toEqual(["NEW TAB"])
  })

  test("ctrl+w on a tab with SQL asks first; another key cancels", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!
    mockInput.pressKey("t", { ctrl: true })
    await mockInput.typeText("SELECT 1")
    mockInput.pressKey("w", { ctrl: true })
    await flush()
    expect(app.tabs.all).toHaveLength(2)
    expect(frameText()).toContain("ctrl+w again to close")

    mockInput.pressArrow("left")
    await flush()
    expect(frameText()).not.toContain("ctrl+w again to close")
    mockInput.pressKey("w", { ctrl: true })
    await flush()
    expect(app.tabs.all).toHaveLength(2)

    mockInput.pressKey("w", { ctrl: true })
    await flush()
    expect(tabNames(app)).toEqual(["NEW TAB"])
  })

  test("closing the last tab leaves a fresh empty tab", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!
    await mockInput.typeText("SELECT 1")
    mockInput.pressKey("w", { ctrl: true })
    mockInput.pressKey("w", { ctrl: true })
    await flush()
    expect(tabNames(app)).toEqual(["NEW TAB"])
    expect(app.editor.query).toBe("")
    expect(app.editor.textarea.focused).toBe(true)
  })

  test("ctrl+n renames the active tab; esc cancels", async () => {
    const app = await boot(100, 30, fakeDb())
    const { mockInput, flush } = setup!
    mockInput.pressKey("n", { ctrl: true })
    await flush()
    expect(app.promptDialog.isOpen).toBe(true)
    expect(frameText()).toContain("Rename tab")

    for (let i = 0; i < "NEW TAB".length; i++) mockInput.pressBackspace()
    await mockInput.typeText("users")
    mockInput.pressEnter()
    await flush()
    expect(app.promptDialog.isOpen).toBe(false)
    expect(tabNames(app)).toEqual(["users"])
    expect(tabBarLine()).toContain(" 1 users ")

    mockInput.pressKey("n", { ctrl: true })
    await flush()
    await mockInput.typeText("zzz")
    mockInput.pressEscape()
    await flush()
    expect(tabNames(app)).toEqual(["users"])
  })

  test("results and undo history are per tab", async () => {
    const db = fakeDb({
      execute: async () => ({ kind: "rows", columns: ["id"], rows: [[1]], rowCount: 1, truncated: false, elapsedMs: 1 }),
    })
    const app = await boot(100, 30, db)
    const { mockInput, flush } = setup!
    await mockInput.typeText("SELECT 1")
    mockInput.pressEnter({ ctrl: true })
    await flush()
    expect(frameText()).toContain("1 row")

    mockInput.pressKey("t", { ctrl: true })
    await mockInput.typeText("x")
    await flush()
    expect(frameText()).toContain("no results yet")
    mockInput.pressKey("z", { ctrl: true })
    await flush()
    expect(app.editor.query).toBe("")

    mockInput.pressKey("1", { meta: true })
    await flush()
    expect(frameText()).toContain("1 row")
    expect(app.editor.query).toBe("SELECT 1")
  })

  test("one query at a time; results land in the tab that ran it", async () => {
    let resolve: (value: QueryResult) => void = () => {}
    let calls = 0
    const db = fakeDb({
      execute: () => {
        calls++
        return new Promise<QueryResult>((r) => {
          resolve = r
        })
      },
    })
    const app = await boot(100, 30, db)
    const { mockInput, flush } = setup!
    await mockInput.typeText("SELECT slow")
    mockInput.pressEnter({ ctrl: true })
    mockInput.pressKey("t", { ctrl: true })
    await mockInput.typeText("SELECT 2")
    mockInput.pressEnter({ ctrl: true })
    await flush()
    expect(calls).toBe(1)
    expect(frameText()).toContain("another query is still running")

    resolve({ kind: "command", commandTag: "SELECT", rowCount: 7, elapsedMs: 1 })
    await waitFor(() => app.tabs.all[0]!.results.root.visible === false)
    expect(frameText()).not.toContain("SELECT 7")
    mockInput.pressKey("1", { meta: true })
    await flush()
    expect(frameText()).toContain("SELECT 7")
  })

  test("tabs persist per connection across restarts", async () => {
    const conn = { host: "h", port: 5432, user: "u", database: "d" }
    let app = await boot(100, 30, fakeDb())
    await app.tryConnect(conn)
    app.editor.setQuery("SELECT 1")
    app.tabs.add("orders", "SELECT * FROM orders")
    setup!.renderer.destroy()

    app = await boot(100, 30, fakeDb())
    await app.tryConnect(conn)
    await setup!.flush()
    expect(tabNames(app)).toEqual(["NEW TAB", "orders"])
    expect(app.tabs.activeTabIndex).toBe(1)
    expect(app.editor.query).toBe("SELECT * FROM orders")
  })

  test("first connect appends unsaved tabs after the saved ones", async () => {
    const conn = { host: "h", port: 5432, user: "u", database: "d" }
    let app = await boot(100, 30, fakeDb())
    await app.tryConnect(conn)
    app.editor.setQuery("SELECT saved")
    setup!.renderer.destroy()

    app = await boot(100, 30, fakeDb())
    app.editor.setQuery("SELECT draft")
    await app.tryConnect(conn)
    await setup!.flush()
    expect(app.tabs.all.map((tab) => tab.editor.query)).toEqual(["SELECT saved", "SELECT draft"])
    expect(app.tabs.activeTabIndex).toBe(1)
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
    mockInput.pressEnter()
    await flush()
    mockInput.pressKey("h", { ctrl: true })
    await flush()
    expect(app.helpDialog.isOpen).toBe(false)
    expect(app.dialog.isOpen).toBe(true)
  })
})
