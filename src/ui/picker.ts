import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { theme } from "../theme"
import { createOverlay } from "./overlay"
import { tokenizeLine, type SqlTokenKind } from "../sql/highlight"

export interface PickerItem<T> {
  label: string
  meta: string
  preview: string
  value: T
}

export interface PickerSource<T> {
  title: string
  items: PickerItem<T>[]
  filter: (items: PickerItem<T>[], text: string) => PickerItem<T>[]
  emptyText: string
  hint: string
  plainPreview?: boolean
}

const MAX_WIDTH = 120
const MAX_HEIGHT = 30
const MARGIN_X = 4
const MARGIN_Y = 2
const LIST_RATIO = 0.45
const BORDERS = 2
const PADDING_X = 1
const INPUT_ROWS = 1
const HINT_ROWS = 1

const TOKEN_COLORS: Record<SqlTokenKind, string> = {
  keyword: theme.keyword,
  string: theme.string,
  number: theme.number,
  comment: theme.comment,
}

function highlightSqlLine(line: string): TextChunk[] {
  const chunks: TextChunk[] = []
  let pos = 0
  for (const token of tokenizeLine(line)) {
    if (token.start > pos) chunks.push(fg(theme.fg)(line.slice(pos, token.start)))
    chunks.push(fg(TOKEN_COLORS[token.kind])(line.slice(token.start, token.end)))
    pos = token.end
  }
  if (pos < line.length) chunks.push(fg(theme.fg)(line.slice(pos)))
  return chunks
}

function fit(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text.padEnd(width)
  return `${text.slice(0, width - 1)}…`
}

export class PickerDialog<T> {
  readonly root: BoxRenderable
  private readonly renderer: CliRenderer
  private readonly panel: BoxRenderable
  private readonly input: InputRenderable
  private readonly list: TextRenderable
  private readonly preview: TextRenderable
  private readonly previewBox: BoxRenderable
  private readonly hint: TextRenderable
  private readonly onPick: (value: T) => void
  private readonly selectedBg = RGBA.fromHex(theme.selectBg)

  private source: PickerSource<T> | null = null
  private filtered: PickerItem<T>[] = []
  private selection = 0
  private top = 0
  private listWidth = 0
  private bodyRows = 0
  private opened = false

  constructor(renderer: CliRenderer, id: string, onPick: (value: T) => void) {
    this.renderer = renderer
    this.onPick = onPick

    this.root = createOverlay(renderer, `${id}-overlay`)

    this.panel = new BoxRenderable(renderer, {
      id,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.focus,
      backgroundColor: theme.bg,
      paddingLeft: PADDING_X,
      paddingRight: PADDING_X,
    })

    const inputRow = new BoxRenderable(renderer, {
      id: `${id}-input-row`,
      width: "100%",
      height: INPUT_ROWS,
      flexDirection: "row",
    })
    inputRow.add(new TextRenderable(renderer, { id: `${id}-prompt`, content: "> ", fg: theme.focus, width: 2 }))
    this.input = new InputRenderable(renderer, {
      id: `${id}-input`,
      flexGrow: 1,
      textColor: theme.fg,
      cursorColor: theme.focus,
      placeholder: "type to filter",
      placeholderColor: theme.dim,
    })
    this.input.on(InputRenderableEvents.INPUT, () => this.applyFilter())
    inputRow.add(this.input)

    const body = new BoxRenderable(renderer, {
      id: `${id}-body`,
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
    })
    this.list = new TextRenderable(renderer, {
      id: `${id}-list`,
      content: "",
      wrapMode: "none",
      selectable: false,
    })
    this.previewBox = new BoxRenderable(renderer, {
      id: `${id}-preview-box`,
      flexGrow: 1,
      border: ["left"],
      borderStyle: "single",
      borderColor: theme.border,
      paddingLeft: 1,
    })
    this.preview = new TextRenderable(renderer, {
      id: `${id}-preview`,
      content: "",
      wrapMode: "none",
    })
    this.previewBox.add(this.preview)
    body.add(this.list)
    body.add(this.previewBox)

    this.hint = new TextRenderable(renderer, {
      id: `${id}-hint`,
      content: "",
      fg: theme.dim,
      height: HINT_ROWS,
    })

    this.panel.add(inputRow)
    this.panel.add(body)
    this.panel.add(this.hint)
    this.root.add(this.panel)

    renderer.on("resize", () => {
      if (this.opened) this.layout()
    })
  }

  get isOpen(): boolean {
    return this.opened
  }

  get selectedItem(): PickerItem<T> | null {
    return this.filtered[this.selection] ?? null
  }

  get visibleItems(): PickerItem<T>[] {
    return this.filtered
  }

  open(source: PickerSource<T>): void {
    this.source = source
    this.opened = true
    this.root.visible = true
    this.panel.title = ` ${source.title} `
    this.input.value = ""
    this.setStatus(source.hint, theme.dim)
    this.layout()
    this.applyFilter()
    this.input.focus()
  }

  close(): void {
    this.input.blur()
    this.opened = false
    this.root.visible = false
    this.source = null
    this.filtered = []
  }

  // Swaps in new items (e.g. after a star/remove) keeping the filter and cursor position.
  setItems(items: PickerItem<T>[]): void {
    if (!this.source) return
    this.source = { ...this.source, items }
    this.filtered = this.source.filter(items, this.input.value)
    this.selection = Math.min(this.selection, Math.max(0, this.filtered.length - 1))
    this.renderBody()
  }

  setStatus(text: string, color: string): void {
    this.hint.content = text
    this.hint.fg = color
  }

  moveSelection(delta: number): void {
    if (this.filtered.length === 0) return
    this.selection = Math.min(Math.max(0, this.selection + delta), this.filtered.length - 1)
    this.renderBody()
  }

  pick(): void {
    const item = this.selectedItem
    if (!item) return
    this.close()
    this.onPick(item.value)
  }

  private layout(): void {
    const width = Math.max(20, Math.min(MAX_WIDTH, this.renderer.terminalWidth - MARGIN_X))
    const height = Math.max(8, Math.min(MAX_HEIGHT, this.renderer.terminalHeight - MARGIN_Y))
    this.panel.width = width
    this.panel.height = height
    const inner = width - BORDERS - PADDING_X * 2
    this.listWidth = Math.floor(inner * LIST_RATIO)
    this.list.width = this.listWidth
    this.bodyRows = height - BORDERS - INPUT_ROWS - HINT_ROWS
    this.renderBody()
  }

  private applyFilter(): void {
    if (!this.source) return
    this.filtered = this.source.filter(this.source.items, this.input.value)
    this.selection = 0
    this.top = 0
    this.renderBody()
  }

  private renderBody(): void {
    if (!this.source) return
    if (this.filtered.length === 0) {
      this.list.content = new StyledText([fg(theme.dim)(this.source.emptyText)])
      this.preview.content = ""
      return
    }
    const rows = Math.max(1, this.bodyRows)
    if (this.selection < this.top) this.top = this.selection
    if (this.selection >= this.top + rows) this.top = this.selection - rows + 1

    const metaWidth = Math.max(...this.filtered.map((item) => item.meta.length))
    const labelWidth = this.listWidth - metaWidth - 2
    const chunks: TextChunk[] = []
    for (const [i, item] of this.filtered.slice(this.top, this.top + rows).entries()) {
      if (i > 0) chunks.push(fg(theme.fg)("\n"))
      const label = fg(theme.fg)(fit(item.label, labelWidth))
      const meta = fg(theme.dim)(` ${item.meta.padStart(metaWidth)} `)
      if (this.top + i === this.selection) {
        chunks.push({ ...label, bg: this.selectedBg }, { ...meta, bg: this.selectedBg })
      } else {
        chunks.push(label, meta)
      }
    }
    this.list.content = new StyledText(chunks)

    const previewChunks: TextChunk[] = []
    for (const [i, line] of (this.selectedItem?.preview ?? "").split("\n").entries()) {
      if (i >= rows) break
      if (i > 0) previewChunks.push(fg(theme.fg)("\n"))
      if (this.source.plainPreview) previewChunks.push(fg(theme.fg)(line))
      else previewChunks.push(...highlightSqlLine(line))
    }
    this.preview.content = new StyledText(previewChunks)
  }
}
