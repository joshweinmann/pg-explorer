import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  TextTableRenderable,
  bold,
  dim,
  fg,
  type CliRenderer,
  type TextChunk,
  type TextTableContent,
} from "@opentui/core"
import { theme } from "../theme"
import {
  commandFooter,
  formatCell,
  MAX_CELL_WIDTH,
  paginate,
  rowsFooter,
  rowToJson,
  truncateForDisplay,
  uniqueColumnNames,
  DEFAULT_PAGE_SIZE,
  type FormattedCell,
} from "../results/format"
import type { QueryResult } from "../db/client"

const CELL_PADDING_X = 1
const DOUBLE_CLICK_MS = 350

type Row = unknown[]
type RowsResult = Extract<QueryResult, { kind: "rows" }>
type CommandResult = Extract<QueryResult, { kind: "command" }>

export class Results {
  readonly root: BoxRenderable
  readonly viewport: ScrollBoxRenderable
  private readonly message: TextRenderable
  private readonly table: TextTableRenderable
  private readonly footer: TextRenderable
  private readonly onCopyRequest: (json: string) => void
  private readonly selectedBg = RGBA.fromHex(theme.selectBg)

  private columns: string[] = []
  private rows: Row[] = []
  private truncated = false
  private rowCap: number | null = null
  private elapsedMs = 0
  private pageIndex = 0
  private selectionIndex = 0
  private windowStart = 0
  private visibleCount = 0
  private lastClickRow: number | null = null
  private lastClickTime = 0

  constructor(renderer: CliRenderer, onCopyRequest: (json: string) => void = () => {}) {
    this.onCopyRequest = onCopyRequest
    this.root = new BoxRenderable(renderer, {
      id: "results-panel",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      focusable: true,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.focus,
      paddingLeft: 1,
    })

    this.viewport = new ScrollBoxRenderable(renderer, {
      id: "results-scroll",
      width: "100%",
      flexGrow: 1,
      scrollX: true,
      onMouseDown: (event) => this.handleTableMouseDown(event.y),
    })

    this.message = new TextRenderable(renderer, {
      id: "results-message",
      content: "no results yet",
      fg: theme.dim,
    })

    this.table = new TextTableRenderable(renderer, {
      id: "results-table",
      content: [],
      visible: false,
      border: true,
      outerBorder: false,
      borderStyle: "single",
      borderColor: theme.border,
      columnWidthMode: "content",
      wrapMode: "none",
      cellPaddingX: CELL_PADDING_X,
      cellPaddingY: 0,
    })

    this.viewport.add(this.message)
    this.viewport.add(this.table)

    this.footer = new TextRenderable(renderer, {
      id: "results-footer",
      content: "",
      fg: theme.dim,
      height: 1,
    })

    this.root.add(this.viewport)
    this.root.add(this.footer)
  }

  focus(): void {
    this.viewport.focus()
  }

  private pageRows(): Row[] {
    const page = paginate(this.rows.length, this.pageIndex, DEFAULT_PAGE_SIZE)
    return this.rows.slice(page.start, page.end)
  }

  showMessage(text: string, color: string): void {
    this.rows = []
    this.selectionIndex = 0
    this.windowStart = 0
    this.table.visible = false
    this.message.visible = true
    this.message.content = text
    this.message.fg = color
    this.footer.content = ""
  }

  setRunning(): void {
    this.footer.content = "running…"
    this.footer.fg = theme.dim
  }

  showError(message: string): void {
    this.showMessage(message, theme.error)
  }

  showRows(result: RowsResult): void {
    this.columns = uniqueColumnNames(result.columns)
    this.rows = result.rows
    this.truncated = result.truncated
    this.rowCap = result.maxRows ?? null
    this.elapsedMs = result.elapsedMs
    this.pageIndex = 0
    this.selectionIndex = 0
    this.windowStart = 0
    this.message.visible = false
    this.table.visible = true
    this.renderPage()
  }

  showCommand(result: CommandResult): void {
    this.rows = []
    this.selectionIndex = 0
    this.windowStart = 0
    this.table.visible = false
    this.message.visible = true
    this.message.content = `${result.commandTag} ${result.rowCount ?? ""}`.trim()
    this.message.fg = theme.success
    this.footer.content = commandFooter(result.commandTag, result.rowCount, result.elapsedMs)
  }

  showCopied(): void {
    this.footer.content = "copied row to clipboard"
    this.footer.fg = theme.success
  }

  nextPage(): void {
    if (this.rows.length === 0) return
    this.pageIndex++
    this.selectionIndex = 0
    this.windowStart = 0
    this.renderPage()
  }

  prevPage(): void {
    if (this.rows.length === 0) return
    this.pageIndex = Math.max(0, this.pageIndex - 1)
    this.selectionIndex = 0
    this.windowStart = 0
    this.renderPage()
  }

  moveSelection(delta: number): void {
    const count = this.pageRows().length
    if (count === 0) return
    this.selectionIndex = Math.min(Math.max(0, this.selectionIndex + delta), count - 1)
    this.renderPage()
  }

  goToSelectionEdge(first: boolean): void {
    const count = this.pageRows().length
    if (count === 0) return
    this.selectionIndex = first ? 0 : count - 1
    this.renderPage()
  }

  selectedRowJson(): string | null {
    const row = this.pageRows()[this.selectionIndex]
    if (!row) return null
    return rowToJson(this.columns, row)
  }

  private renderPage(): void {
    const page = paginate(this.rows.length, this.pageIndex, DEFAULT_PAGE_SIZE)
    this.pageIndex = page.pageIndex
    this.viewport.scrollTop = 0

    const headerCells = this.columns.map((name) => truncateForDisplay(name))
    const bodyRows = this.rows
      .slice(page.start, page.end)
      .map((row) => row.map((value) => formatCell(value)))

    const colWidths = headerCells.map((header, i) => {
      let width = header.length
      for (const row of bodyRows) {
        const cell = row[i]
        if (cell) width = Math.max(width, truncateForDisplay(cell.text).length)
      }
      return Math.min(width, MAX_CELL_WIDTH)
    })
    const tableWidth =
      colWidths.length > 0
        ? colWidths.reduce((sum, width) => sum + width + CELL_PADDING_X * 2, 0) +
          (colWidths.length - 1)
        : 0
    if (colWidths.length > 0) {
      this.table.width = tableWidth
    }

    this.selectionIndex = Math.min(this.selectionIndex, Math.max(0, bodyRows.length - 1))
    const visibleCount = this.visibleRowCapacity(tableWidth)
    if (this.selectionIndex < this.windowStart) this.windowStart = this.selectionIndex
    if (this.selectionIndex >= this.windowStart + visibleCount) {
      this.windowStart = this.selectionIndex - visibleCount + 1
    }
    this.windowStart = Math.min(this.windowStart, Math.max(0, bodyRows.length - visibleCount))
    const visible = bodyRows.slice(this.windowStart, this.windowStart + visibleCount)
    this.visibleCount = visible.length

    const content: TextTableContent = [headerCells.map((name) => [bold(name)])]
    for (const [vi, row] of visible.entries()) {
      const selected = this.windowStart + vi === this.selectionIndex
      content.push(row.map((cell) => [this.cellChunk(cell, selected)]))
    }
    this.table.content = content

    this.footer.content = rowsFooter(
      this.rows.length,
      this.truncated,
      page.pageIndex,
      page.pageCount,
      this.elapsedMs,
      this.rowCap ?? undefined,
    )
    this.footer.fg = theme.dim
  }

  private visibleRowCapacity(tableWidth: number): number {
    const height = this.viewport.height
    const width = this.viewport.width
    if (typeof height !== "number" || height <= 0) return Number.MAX_SAFE_INTEGER
    const scrollbarRows = typeof width === "number" && tableWidth > width ? 1 : 0
    return Math.max(1, Math.floor((height - scrollbarRows - 1) / 2))
  }

  private cellChunk(cell: FormattedCell, selected: boolean): TextChunk {
    const text = truncateForDisplay(cell.text)
    let chunk: TextChunk
    switch (cell.kind) {
      case "null":
        chunk = dim(text)
        break
      case "true":
        chunk = fg(theme.success)(text)
        break
      case "false":
        chunk = fg(theme.error)(text)
        break
      default:
        chunk = { __isChunk: true, text }
        break
    }
    return selected ? { ...chunk, bg: this.selectedBg } : chunk
  }

  private handleTableMouseDown(y: number): void {
    const index = this.rowIndexAt(y)
    if (index === null) return
    const now = Date.now()
    const isDoubleClick = this.lastClickRow === index && now - this.lastClickTime < DOUBLE_CLICK_MS
    this.lastClickRow = index
    this.lastClickTime = now

    if (this.selectionIndex !== index) {
      this.selectionIndex = index
      this.renderPage()
    }

    if (isDoubleClick) {
      this.lastClickRow = null
      this.lastClickTime = 0
      const json = this.selectedRowJson()
      if (json) this.onCopyRequest(json)
    }
  }

  private rowIndexAt(y: number): number | null {
    if (!this.table.visible || this.visibleCount === 0) return null
    const top = this.table.screenY
    if (typeof top !== "number") return null
    const relative = y - top
    if (relative < 2 || (relative - 2) % 2 !== 0) return null
    const within = (relative - 2) / 2
    if (within >= this.visibleCount) return null
    const selection = this.windowStart + within
    return selection < this.pageRows().length ? selection : null
  }
}
