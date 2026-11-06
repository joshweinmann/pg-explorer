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
import { errorMessage } from "../errors"
import type { DbConnection } from "../db/client"
import type { ColumnInfo, SchemaInfo, TableDetails, TableInfo } from "../db/metadata"

interface SidebarRow {
  id: string
  depth: number
  chunks: TextChunk[]
  schema?: string
  table?: string
}

type Group = "columns" | "indexes" | "constraints" | "triggers"

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
  private columnLoads = new Map<string, Promise<void>>()
  private details = new Map<string, TableDetails>()
  private detailLoads = new Map<string, Promise<void>>()
  private toggledGroups = new Set<string>()
  private rows: SidebarRow[] = []
  private rowRenderables: TextRenderable[] = []
  private cursorIndex = 0
  private lastClickRowId: string | null = null
  private lastClickTime = 0
  private selectedFg = RGBA.fromHex(theme.selectFg)

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
    this.columnLoads.clear()
    this.details.clear()
    this.detailLoads.clear()
    this.toggledGroups.clear()
    this.cursorIndex = 0
    this.setMessage(message, color)
  }

  async load(db: DbConnection): Promise<void> {
    this.db = db
    this.setMessage("loading metadata…", theme.dim)
    try {
      this.schemas = await db.loadSchemasAndTables()
      this.columnLoads.clear()
      this.details.clear()
      this.detailLoads.clear()
      this.cursorIndex = 0
      this.renderRows()
    } catch (err) {
      this.showError(`metadata error: ${errorMessage(err)}`)
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
    if (row.id.startsWith("g:")) {
      const key = row.id.slice(2)
      if (this.toggledGroups.has(key)) this.toggledGroups.delete(key)
      else this.toggledGroups.add(key)
      this.renderRows()
      return
    }
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
      try {
        await Promise.all([this.ensureColumns(schema, tableInfo), this.ensureDetails(schema, table)])
      } catch (err) {
        this.showError(`metadata error: ${errorMessage(err)}`)
        return
      }
      this.expandedTables.add(key)
      this.renderRows()
    }
  }

  get loadedSchemas(): SchemaInfo[] {
    return this.schemas
  }

  async ensureColumns(schema: string, table: TableInfo): Promise<void> {
    if (table.columns !== null || !this.db) return
    const key = `${schema}.${table.name}`
    let pending = this.columnLoads.get(key)
    if (!pending) {
      pending = this.db
        .loadTableColumns(schema, table.name)
        .then((columns) => {
          table.columns = columns
        })
        .finally(() => this.columnLoads.delete(key))
      this.columnLoads.set(key, pending)
    }
    await pending
  }

  private async ensureDetails(schema: string, table: string): Promise<void> {
    const key = `${schema}.${table}`
    if (this.details.has(key) || !this.db) return
    let pending = this.detailLoads.get(key)
    if (!pending) {
      pending = this.db
        .loadTableDetails(schema, table)
        .then((details) => {
          this.details.set(key, details)
        })
        .finally(() => this.detailLoads.delete(key))
      this.detailLoads.set(key, pending)
    }
    await pending
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
    const maxWidth = this.fitWidth() - 4

    for (const [index, row] of this.rows.entries()) {
      const fitted = fitChunks(row.chunks, maxWidth)
      const chunks =
        index === this.cursorIndex
          ? fitted.map((chunk) => ({ ...chunk, fg: this.selectedFg }))
          : fitted
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

  private fitWidth(): number {
    const maxRowWidth = this.rows.reduce((max, row) => {
      const width = row.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      return Math.max(max, width)
    }, 0)
    const cap = Math.floor(this.renderer.terminalWidth * 0.75)
    const width = Math.max(MIN_WIDTH, Math.min(maxRowWidth + 4, cap))
    this.root.width = width
    return width
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
          rows.push(...this.tableRows(schema.name, table.name, table.columns))
        }
      }
    }
    return rows
  }

  private tableRows(schema: string, table: string, columns: ColumnInfo[]): SidebarRow[] {
    const details = this.details.get(`${schema}.${table}`)
    const item = (kind: string, name: string, chunks: TextChunk[]): SidebarRow => ({
      id: `${kind}:${schema}\u0001${table}\u0001${name}`,
      depth: 3,
      schema,
      table,
      chunks: [{ __isChunk: true, text: "      " }, fg(theme.fg)(name), ...chunks],
    })
    const rows = this.groupRows(schema, table, "columns", columns.map((column) => this.columnRow(item, column)))
    if (!details) return rows
    rows.push(
      ...this.groupRows(
        schema,
        table,
        "indexes",
        details.indexes.map((index) =>
          item("i", index.name, [
            dim(` ${index.summary}`),
            ...(index.unique ? [fg(theme.warning)(" [UQ]")] : []),
          ]),
        ),
      ),
      ...this.groupRows(
        schema,
        table,
        "constraints",
        details.constraints.map((constraint) =>
          item("k", constraint.name, [dim(` ${constraint.definition}`)]),
        ),
      ),
      ...this.groupRows(
        schema,
        table,
        "triggers",
        details.triggers.map((trigger) =>
          item("r", trigger.name, [
            dim(` ${trigger.summary}`),
            ...(trigger.enabled ? [] : [fg(theme.error)(" disabled")]),
          ]),
        ),
      ),
    )
    return rows
  }

  private groupRows(schema: string, table: string, group: Group, items: SidebarRow[]): SidebarRow[] {
    const key = `${schema}\u0001${table}\u0001${group}`
    const expanded = (group === "columns") !== this.toggledGroups.has(key)
    const marker = items.length === 0 ? " " : expanded ? EXPANDED : COLLAPSED
    const header: SidebarRow = {
      id: `g:${key}`,
      depth: 2,
      schema,
      table,
      chunks: [
        { __isChunk: true, text: `    ${marker} ` },
        fg(items.length === 0 ? theme.dim : theme.fg)(group),
        dim(` (${items.length})`),
      ],
    }
    return expanded ? [header, ...items] : [header]
  }

  private columnRow(
    item: (kind: string, name: string, chunks: TextChunk[]) => SidebarRow,
    column: ColumnInfo,
  ): SidebarRow {
    const chunks: TextChunk[] = [dim(` :${column.dataType}`)]
    if (column.isPrimaryKey) chunks.push(fg(theme.warning)(" [PK]"))
    if (column.isForeignKey) chunks.push(fg(theme.fk)(" [FK]"))
    if (!column.nullable) chunks.push(fg(theme.error)(" NN"))
    return item("c", column.name, chunks)
  }
}

function fitChunks(chunks: TextChunk[], maxWidth: number): TextChunk[] {
  const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
  if (total <= maxWidth) return chunks
  const fitted: TextChunk[] = []
  let remaining = maxWidth - 1
  for (const chunk of chunks) {
    if (remaining <= 0) break
    fitted.push({ ...chunk, text: chunk.text.slice(0, remaining) })
    remaining -= chunk.text.length
  }
  fitted.push(dim("…"))
  return fitted
}
