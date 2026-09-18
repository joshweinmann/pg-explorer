import { createTestRenderer } from "@opentui/core/testing"
import { App } from "../src/app"
import type { DbConnection } from "../src/db/client"
import type { ColumnInfo, SchemaInfo } from "../src/db/metadata"

const schemas: SchemaInfo[] = [
  {
    name: "public",
    tables: [
      { name: "users", kind: "table", columns: null },
      { name: "active_users", kind: "view", columns: null },
    ],
  },
]

const columns: ColumnInfo[] = [
  { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
  { name: "email", dataType: "text", nullable: false, isPrimaryKey: false, isForeignKey: false },
  { name: "org_id", dataType: "bigint", nullable: true, isPrimaryKey: false, isForeignKey: true },
]

const rows = [[1, "alice", true]]

const db: DbConnection = {
  connected: true,
  connect: async () => {},
  disconnect: async () => {},
  execute: async () => ({
    kind: "rows" as const,
    columns: ["id", "email", "org_id"],
    rows,
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 3.21,
  }),
  loadSchemasAndTables: async () => schemas,
  loadTableColumns: async () => columns,
}

const setup = await createTestRenderer({ width: 110, height: 34, kittyKeyboard: true })
const app = new App(setup.renderer, db, "/tmp/pg-explorer-preview-config")
await setup.flush()

await app.tryConnect({ host: "localhost", port: 5432, user: "alice", database: "widgets" })
await setup.flush()

const { mockInput, mockMouse, flush } = setup
mockInput.pressKey("h", { ctrl: true })
await flush()

console.log(setup.captureCharFrame())
setup.renderer.destroy()
