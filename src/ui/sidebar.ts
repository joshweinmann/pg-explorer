import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  TextAttributes,
  bold,
  dim,
  fg,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { theme } from "../theme"
import type { DbConnection } from "../db/client"
import type { ColumnInfo, SchemaInfo, TableInfo } from "../db/metadata"

interface SidebarRow {
  id: string
  depth: number
  chunks: TextChunk[]
  schema?: string
  table?: string
}

const EXPANDED = "▾"
const COLLAPSED = "▸"
const MIN_WIDTH = 30
const DOUBLE_CLICK_MS = 350

export class Sidebar {
  readonly root: BoxRenderable
  private readonly renderer: CliRenderer
  readonly viewport: ScrollBoxRenderable
  private readonly message: TextRenderable
  private readonly rowsBox: BoxRenderable

  private db: DbConnection | null = null
  private schemas: SchemaInfo[] = []
  private expandedSchemas = new Set<string>()
  private expandedTables = new Set<string>()
  private rows: SidebarRow[] = []
  private rowRenderables: TextRenderable[] = []
  private cursorIndex = 0
  private lastClickRowId: string | null = null
  private lastClickTime = 0
  private selectedBg = RGBA.fromHex(theme.selectBg)

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.root = new BoxRenderable(renderer, {
      id: "sidebar",
      width: 34,
      height: "100%",
      flexDirection: "column",
      focusable: true,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.focus,
    })

    this.viewport = new ScrollBoxRenderable(renderer, {
      id: "sidebar-scroll",
      width: "100%",
      flexGrow: 1,
    })

    this.rowsBox = new BoxRenderable(renderer, {
      id: "sidebar-rows",
      width: "100%",
      flexDirection: "column",
    })

    this.message = new TextRenderable(renderer, {
      id: "sidebar-message",
      content: "not connected",
      fg: theme.dim,
      wrapMode: "word",
    })

    this.viewport.add(this.rowsBox)
    this.viewport.add(this.message)
    this.root.add(this.viewport)
  }

  focus(): void {
    this.viewport.focus()
  }

  get visibleRowCount(): number {
    return this.rows.length
  }

  get cursor(): number {
    return this.cursorIndex
  }

  reset(message = "not connected", color = theme.dim): void {
    this.db = null
    this.schemas = []
    this.expandedSchemas.clear()
    this.expandedTables.clear()
    this.cursorIndex = 0
    this.setMessage(message, color)
  }

  async load(db: DbConnection): Promise<void> {
    this.db = db
    this.setMessage("loading metadata…", theme.dim)
    try {
      this.schemas = await db.loadSchemasAndTables()
      this.cursorIndex = 0
      this.renderRows()
    } catch (err) {
      this.showError(`metadata error: ${errText(err)}`)
    }
  }

  moveUp(): void {
    if (this.cursorIndex > 0) {
      this.cursorIndex--
      this.renderRows()
    }
  }

  moveDown(): void {
    if (this.cursorIndex < this.rows.length - 1) {
      this.cursorIndex++
      this.renderRows()
    }
  }

  async toggleCurrent(): Promise<void> {
    const row = this.rows[this.cursorIndex]
    if (!row) return
    if (row.id.startsWith("s:")) {
      const schema = row.schema ?? row.id.slice(2)
      if (this.expandedSchemas.has(schema)) this.expandedSchemas.delete(schema)
      else this.expandedSchemas.add(schema)
      this.renderRows()
      return
    }
    if (row.id.startsWith("t:")) {
      const schema = row.schema
      const table = row.table
      if (schema === undefined || table === undefined) return
      const key = `${schema}.${table}`
      if (this.expandedTables.has(key)) {
        this.expandedTables.delete(key)
        this.renderRows()
        return
      }
      const tableInfo = this.findTable(schema, table)
      if (!tableInfo) return
      if (tableInfo.columns === null && this.db) {
        try {
          tableInfo.columns = await this.db.loadTableColumns(schema, table)
        } catch (err) {
          this.showError(`metadata error: ${errText(err)}`)
          return
        }
      }
      this.expandedTables.add(key)
      this.renderRows()
    }
  }

  private findTable(schema: string, table: string): TableInfo | undefined {
    return this.schemas
      .find((s) => s.name === schema)
      ?.tables.find((t) => t.name === table)
  }

  private setMessage(text: string, color: string): void {
    this.rows = []
    this.clearRowRenderables()
    this.message.content = text
    this.message.fg = color
    this.message.visible = true
  }

  private showError(text: string): void {
    this.message.content = text
    this.message.fg = theme.error
    this.message.visible = true
  }

  private clearRowRenderables(): void {
    for (const renderable of this.rowRenderables) {
      this.rowsBox.remove(renderable)
      renderable.destroy()
    }
    this.rowRenderables = []
  }

  private renderRows(): void {
    this.rows = this.computeRows()
    this.clearRowRenderables()
    this.message.visible = this.rows.length === 0
    this.fitWidth()

    for (const [index, row] of this.rows.entries()) {
      const chunks =
        index === this.cursorIndex
          ? row.chunks.map((chunk) => ({ ...chunk, bg: this.selectedBg }))
          : row.chunks
      const renderable = new TextRenderable(this.renderer, {
        id: row.id,
        content: new StyledText(chunks),
        wrapMode: "none",
        height: 1,
        width: "100%",
        selectable: false,
        onMouseDown: () => this.handleRowMouseDown(row.id),
      })
      this.rowsBox.add(renderable)
      this.rowRenderables.push(renderable)
    }

    this.ensureCursorVisible()
  }

  handleRowMouseDown(rowId: string): void {
    const index = this.rows.findIndex((row) => row.id === rowId)
    if (index < 0) return
    const now = Date.now()
    const isDoubleClick =
      this.lastClickRowId === rowId && now - this.lastClickTime < DOUBLE_CLICK_MS

    if (this.cursorIndex !== index) {
      this.cursorIndex = index
      this.renderRows()
    }

    if (isDoubleClick) {
      this.lastClickRowId = null
      this.lastClickTime = 0
      void this.toggleCurrent()
    } else {
      this.lastClickRowId = rowId
      this.lastClickTime = now
    }
  }

  private fitWidth(): void {
    const maxRowWidth = this.rows.reduce((max, row) => {
      const width = row.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      return Math.max(max, width)
    }, 0)
    const cap = Math.floor(this.renderer.terminalWidth / 2)
    this.root.width = Math.max(MIN_WIDTH, Math.min(maxRowWidth + 3, cap))
  }

  private ensureCursorVisible(): void {
    const height = this.viewport.height
    if (typeof height !== "number" || height <= 0) return
    const top = this.viewport.scrollTop
    if (this.cursorIndex < top) {
      this.viewport.scrollTop = this.cursorIndex
    } else if (this.cursorIndex > top + height - 2) {
      this.viewport.scrollTop = this.cursorIndex - height + 2
    }
  }

  private computeRows(): SidebarRow[] {
    const rows: SidebarRow[] = []
    for (const schema of this.schemas) {
      const schemaExpanded = this.expandedSchemas.has(schema.name)
      rows.push({
        id: `s:${schema.name}`,
        depth: 0,
        schema: schema.name,
        chunks: [
          {
            __isChunk: true,
            text: `${schemaExpanded ? EXPANDED : COLLAPSED} `,
            attributes: TextAttributes.BOLD,
          },
          bold(schema.name),
        ],
      })
      if (!schemaExpanded) continue
      for (const table of schema.tables) {
        const key = `${schema.name}.${table.name}`
        const tableExpanded = this.expandedTables.has(key)
        const nameChunks: TextChunk[] =
          table.kind === "view"
            ? [fg(theme.dim)(`${table.name} (view)`)]
            : [fg(theme.fg)(table.name)]
        rows.push({
          id: `t:${schema.name}\u0001${table.name}`,
          depth: 1,
          schema: schema.name,
          table: table.name,
          chunks: [
            { __isChunk: true, text: `  ${tableExpanded ? EXPANDED : COLLAPSED} ` },
            ...nameChunks,
          ],
        })
        if (tableExpanded && table.columns) {
          rows.push(
            ...table.columns.map((column) => this.columnRow(schema.name, table.name, column)),
          )
        }
      }
    }
    return rows
  }

  private columnRow(schema: string, table: string, column: ColumnInfo): SidebarRow {
    const chunks: TextChunk[] = [
      { __isChunk: true, text: "    " },
      fg(theme.fg)(column.name),
      dim(` :${column.dataType}`),
    ]
    if (column.isPrimaryKey) chunks.push(fg(theme.warning)(" [PK]"))
    if (column.isForeignKey) chunks.push(fg(theme.fk)(" [FK]"))
    if (!column.nullable) chunks.push(fg(theme.error)(" NN"))
    return {
      id: `c:${schema}\u0001${table}\u0001${column.name}`,
      depth: 2,
      schema,
      table,
      chunks,
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
