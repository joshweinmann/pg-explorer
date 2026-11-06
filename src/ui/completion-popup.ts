import {
  BoxRenderable,
  RGBA,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { theme } from "../theme"
import type { Completion, CompletionItem, CompletionKind } from "../sql/complete"

const MAX_ROWS = 8
const MAX_LABEL = 40
const KIND_TAG: Record<CompletionKind, string> = { column: "col", table: "tbl", keyword: "kw" }

export class CompletionPopup {
  readonly root: BoxRenderable
  private readonly renderer: CliRenderer
  private readonly list: TextRenderable
  private readonly selectedFg = RGBA.fromHex(theme.popupSelectFg)
  private completion: Completion | null = null
  private selected = 0
  private scroll = 0
  private anchor: () => { x: number; y: number } = () => ({ x: 0, y: 0 })

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.root = new BoxRenderable(renderer, {
      id: "completion-popup",
      position: "absolute",
      zIndex: 50,
      visible: false,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.bg,
      renderBefore: () => this.place(),
    })
    this.list = new TextRenderable(renderer, {
      id: "completion-list",
      content: "",
      wrapMode: "none",
      selectable: false,
    })
    this.root.add(this.list)
  }

  get isOpen(): boolean {
    return this.completion !== null
  }

  get current(): Completion | null {
    return this.completion
  }

  get selectedItem(): CompletionItem | null {
    return this.completion?.items[this.selected] ?? null
  }

  // `anchor` gives the screen cell where the replaced word starts. It is read at render
  // time because the editor may resize (and re-scroll) in the same tick as the edit.
  show(completion: Completion, anchor: () => { x: number; y: number }): void {
    this.anchor = anchor
    const previous = this.selectedItem?.insert
    this.completion = completion
    const keep = completion.items.findIndex((item) => item.insert === previous)
    this.selected = Math.max(0, keep)
    this.scroll = 0
    this.render()
    this.root.width = this.innerWidth() + 2
    this.root.height = Math.min(MAX_ROWS, completion.items.length) + 2
    this.place()
    this.root.visible = true
  }

  private place(): void {
    if (!this.completion) return
    const { x, y } = this.anchor()
    const width = this.innerWidth() + 2
    const height = Math.min(MAX_ROWS, this.completion.items.length) + 2
    const below = y + 1
    const top = below + height <= this.renderer.terminalHeight ? below : Math.max(0, y - height)
    const left = Math.max(0, Math.min(x - 2, this.renderer.terminalWidth - width))
    if (this.root.top === top && this.root.left === left) return
    this.root.top = top
    this.root.left = left
    this.renderer.requestRender()
  }

  hide(): void {
    this.completion = null
    this.root.visible = false
  }

  move(delta: number): void {
    const count = this.completion?.items.length ?? 0
    if (!count) return
    this.selected = (this.selected + delta + count) % count
    this.render()
  }

  private innerWidth(): number {
    const items = this.completion?.items ?? []
    const label = Math.min(MAX_LABEL, Math.max(...items.map((i) => i.label.length)))
    return label + 5
  }

  private render(): void {
    const items = this.completion?.items ?? []
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + MAX_ROWS) this.scroll = this.selected - MAX_ROWS + 1
    const labelWidth = this.innerWidth() - 5
    const chunks: TextChunk[] = []
    for (const [offset, item] of items.slice(this.scroll, this.scroll + MAX_ROWS).entries()) {
      if (offset > 0) chunks.push(fg(theme.fg)("\n"))
      const label = item.label.length > labelWidth ? `${item.label.slice(0, labelWidth - 1)}…` : item.label
      const row = [
        fg(theme.fg)(` ${label.padEnd(labelWidth)} `),
        fg(theme.dim)(KIND_TAG[item.kind].padEnd(3)),
      ]
      chunks.push(
        ...(this.scroll + offset === this.selected ? row.map((c) => ({ ...c, fg: this.selectedFg })) : row),
      )
    }
    this.list.content = new StyledText(chunks)
  }
}
