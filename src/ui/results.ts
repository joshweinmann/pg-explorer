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
import { nextSort, sortRows, type SortState } from "../results/sort"
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
  private readonly onSortRequery: (sort: SortState | null) => boolean
  private readonly selectedBg = RGBA.fromHex(theme.selectBg)

  private columns: string[] = []
  private baseRows: Row[] = []
  private rows: Row[] = []
  private sort: SortState | null = null
  private sortFromDb = false
  private colWidths: number[] = []
  private footerText = ""
  private truncated = false
  private rowCap: number | null = null
  private elapsedMs = 0
  private pageIndex = 0
  private selectionIndex = 0
  private windowStart = 0
  private visibleCount = 0
  private lastClickRow: number | null = null
  private lastClickTime = 0

  constructor(
    renderer: CliRenderer,
    onCopyRequest: (json: string) => void = () => {},
    onSortRequery: (sort: SortState | null) => boolean = () => false,
    idSuffix = "",
  ) {
    this.onCopyRequest = onCopyRequest
    this.onSortRequery = onSortRequery
    this.root = new BoxRenderable(renderer, {
      id: `results-panel${idSuffix}`,
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
      id: `results-scroll${idSuffix}`,
      width: "100%",
      flexGrow: 1,
      scrollX: true,
      onMouseDown: (event) => this.handleTableMouseDown(event.x, event.y),
    })

    this.message = new TextRenderable(renderer, {
      id: `results-message${idSuffix}`,
      content: "no results yet",
      fg: theme.dim,
    })

    this.table = new TextTableRenderable(renderer, {
      id: `results-table${idSuffix}`,
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
      id: `results-footer${idSuffix}`,
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
    this.baseRows = []
    this.rows = []
    this.sort = null
    this.selectionIndex = 0
    this.windowStart = 0
    this.table.visible = false
    this.message.visible = true
    this.message.content = text
    this.message.fg = color
    this.setFooter("")
  }

  // Temporary, so a failed sort re-run can restore the footer of the rows still shown.
  setRunning(): void {
    this.showNotice("running…", theme.dim)
  }

  showError(message: string): void {
    this.showMessage(message, theme.error)
  }

  // `sort` marks rows the database already ordered (re-run of a capped result).
  showRows(result: RowsResult, sort: SortState | null = null): void {
    this.columns = uniqueColumnNames(result.columns)
    this.baseRows = result.rows
    this.rows = result.rows
    this.sort = sort
    this.sortFromDb = sort !== null
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
    this.baseRows = []
    this.rows = []
    this.sort = null
    this.selectionIndex = 0
    this.windowStart = 0
    this.table.visible = false
    this.message.visible = true
    this.message.content = `${result.commandTag} ${result.rowCount ?? ""}`.trim()
    this.message.fg = theme.success
    this.setFooter(commandFooter(result.commandTag, result.rowCount, result.elapsedMs))
  }

  showCopied(): void {
    this.showNotice("copied row to clipboard", theme.success)
  }

  // Temporary footer text; clearNotice() restores the regular footer.
  showNotice(text: string, color: string): void {
    this.footer.content = text
    this.footer.fg = color
  }

  clearNotice(): void {
    this.footer.content = this.footerText
    this.footer.fg = theme.dim
  }

  private setFooter(text: string): void {
    this.footerText = text
    this.footer.content = text
    this.footer.fg = theme.dim
  }

  get sortState(): SortState | null {
    return this.sort
  }

  // Capped results are re-queried when the owner can do that safely, so the order
  // covers every row; otherwise only the fetched rows are sorted (noted in the footer).
  sortByColumn(column: number): void {
    if (column < 0 || column >= this.columns.length) return
    const next = nextSort(this.sort, column)
    if (this.truncated && this.onSortRequery(next)) return
    this.sort = next
    this.sortFromDb = false
    this.rows = next ? sortRows(this.baseRows, next) : this.baseRows
    this.pageIndex = 0
    this.selectionIndex = 0
    this.windowStart = 0
    this.renderPage()
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

    const headerCells = this.columns.map((name, i) => this.headerText(name, i))
    const bodyRows = this.rows
      .slice(page.start, page.end)
      .map((row) => row.map((value) => formatCell(value)))

    const colWidths = (this.colWidths = headerCells.map((header, i) => {
      let width = header.length
      for (const row of bodyRows) {
        const cell = row[i]
        if (cell) width = Math.max(width, truncateForDisplay(cell.text).length)
      }
      return Math.min(width, MAX_CELL_WIDTH)
    }))
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

    const content: TextTableContent = [
      headerCells.map((name, i) =>
        i === this.sort?.column ? [fg(theme.focus)(bold(name))] : [bold(name)],
      ),
    ]
    for (const [vi, row] of visible.entries()) {
      const selected = this.windowStart + vi === this.selectionIndex
      content.push(row.map((cell) => [this.cellChunk(cell, selected)]))
    }
    this.table.content = content

    const footer = rowsFooter(
      this.rows.length,
      this.truncated,
      page.pageIndex,
      page.pageCount,
      this.elapsedMs,
      this.rowCap ?? undefined,
    )
    const partialSort = this.truncated && this.sort !== null && !this.sortFromDb
    this.setFooter(partialSort ? `${footer} · sorted fetched rows` : footer)
  }

  private headerText(name: string, column: number): string {
    if (this.sort?.column !== column) return truncateForDisplay(name)
    const arrow = this.sort.dir === "asc" ? "▲" : "▼"
    return `${truncateForDisplay(name, MAX_CELL_WIDTH - 2)} ${arrow}`
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

  private handleTableMouseDown(x: number, y: number): void {
    const column = this.headerColumnAt(x, y)
    if (column !== null) {
      this.lastClickRow = null
      this.sortByColumn(column)
      return
    }
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

  private headerColumnAt(x: number, y: number): number | null {
    if (!this.table.visible || y !== this.table.screenY) return null
    let left = this.table.screenX
    for (const [i, width] of this.colWidths.entries()) {
      const right = left + width + CELL_PADDING_X * 2
      if (x >= left && x < right) return i
      left = right + 1
    }
    return null
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
