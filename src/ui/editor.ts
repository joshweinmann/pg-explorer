import {
  BoxRenderable,
  LineNumberRenderable,
  SyntaxStyle,
  RGBA,
  TextareaRenderable,
  type CliRenderer,
} from "@opentui/core"
import { theme } from "../theme"
import { tokenizeLine, type SqlTokenKind } from "../sql/highlight"
import { runTarget, type RunTarget } from "../sql/statements"

const MIN_EDITOR_HEIGHT = 3
const EDITOR_HEIGHT_RATIO = 0.6
const BORDERS = 2

export class Editor {
  readonly root: BoxRenderable
  readonly textarea: TextareaRenderable
  private readonly renderer: CliRenderer
  private readonly row: BoxRenderable
  private readonly gutter: LineNumberRenderable
  private readonly syntaxStyle: SyntaxStyle
  private readonly styleIds: Record<SqlTokenKind, number>
  private contentVersion = 0
  private indicatorKey = ""
  private lastLength = 0

  constructor(
    renderer: CliRenderer,
    onSubmit: () => void,
    options: {
      idSuffix?: string
      onChange?: () => void
      onEdit?: (grew: boolean) => void
      onCursorMove?: () => void
    } = {},
  ) {
    const suffix = options.idSuffix ?? ""
    this.renderer = renderer
    this.root = new BoxRenderable(renderer, {
      id: `editor-panel${suffix}`,
      width: "100%",
      height: MIN_EDITOR_HEIGHT,
      flexDirection: "column",
      focusable: true,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.focus,
      renderBefore: () => this.refreshRunIndicator(),
    })

    this.row = new BoxRenderable(renderer, {
      id: `editor-row${suffix}`,
      width: "100%",
      height: MIN_EDITOR_HEIGHT - BORDERS,
      flexDirection: "row",
    })

    this.textarea = new TextareaRenderable(renderer, {
      id: `query-editor${suffix}`,
      width: "100%",
      height: MIN_EDITOR_HEIGHT - BORDERS,
      flexGrow: 1,
      placeholder: "-- press CTRL-Enter to execute",
      placeholderColor: theme.dim,
      textColor: theme.fg,
      cursorColor: theme.focus,
      wrapMode: "none",
      keyBindings: [
        { name: "return", ctrl: true, action: "submit" },
        { name: "z", ctrl: true, action: "undo" },
        { name: "z", ctrl: true, shift: true, action: "redo" },
      ],
      onSubmit,
      onContentChange: () => {
        this.contentVersion++
        this.resizeToContent()
        this.applyHighlights()
        options.onChange?.()
        const length = this.textarea.plainText.length
        const grew = length > this.lastLength
        this.lastLength = length
        options.onEdit?.(grew)
      },
      onCursorChange: () => options.onCursorMove?.(),
    })

    this.gutter = new LineNumberRenderable(renderer, {
      id: `editor-gutter${suffix}`,
      target: this.textarea,
      minWidth: 3,
      paddingRight: 1,
      fg: theme.gutter,
    })

    this.syntaxStyle = SyntaxStyle.create()
    this.styleIds = {
      keyword: this.syntaxStyle.registerStyle("sql-keyword", {
        fg: RGBA.fromHex(theme.keyword),
        bold: true,
      }),
      string: this.syntaxStyle.registerStyle("sql-string", {
        fg: RGBA.fromHex(theme.string),
      }),
      number: this.syntaxStyle.registerStyle("sql-number", {
        fg: RGBA.fromHex(theme.number),
      }),
      comment: this.syntaxStyle.registerStyle("sql-comment", {
        fg: RGBA.fromHex(theme.comment),
        italic: true,
      }),
    }
    this.textarea.editBuffer.setSyntaxStyle(this.syntaxStyle)

    this.row.add(this.gutter)
    this.root.add(this.row)
  }

  private resizeToContent(): void {
    const lines = this.textarea.plainText.split("\n").length
    const maxByTerminal = Math.floor(this.renderer.terminalHeight * EDITOR_HEIGHT_RATIO)
    const height = Math.max(
      MIN_EDITOR_HEIGHT,
      Math.min(lines + BORDERS, Math.max(MIN_EDITOR_HEIGHT, maxByTerminal)),
    )
    this.root.height = height
    this.row.height = height - BORDERS
    this.textarea.height = height - BORDERS
  }

  private applyHighlights(): void {
    this.textarea.clearAllHighlights()
    const lines = this.textarea.plainText.split("\n")
    for (const [lineIdx, line] of lines.entries()) {
      for (const token of tokenizeLine(line)) {
        this.textarea.addHighlight(lineIdx, {
          start: token.start,
          end: token.end,
          styleId: this.styleIds[token.kind],
          priority: 0,
        })
      }
    }
  }

  // Called every frame; only touches the gutter when cursor, focus, or content changed.
  private refreshRunIndicator(): void {
    const focused = this.textarea.focused
    const key = focused ? `${this.contentVersion}:${this.textarea.cursorOffset}` : "blurred"
    if (key === this.indicatorKey) return
    this.indicatorKey = key
    this.gutter.clearAllLineColors()
    if (!focused) return
    const target = this.runTarget()
    if (!target) return
    const colors = new Map<number, { gutter: string; content: string }>()
    for (let line = target.startLine; line <= target.endLine; line++) {
      colors.set(line, { gutter: theme.runGutterBg, content: "transparent" })
    }
    this.gutter.setLineColors(colors)
  }

  // The statement under the cursor. The textarea reports the cursor in display
  // cells (wide chars count 2); getTextRange maps it back to a string index.
  cursorIndex(): number {
    return this.textarea.getTextRange(0, this.textarea.cursorOffset).length
  }

  runTarget(): RunTarget | null {
    return runTarget(this.textarea.plainText, this.cursorIndex())
  }

  // Screen cell `back` columns left of the cursor; callers pass ASCII-only spans.
  screenPosition(back: number): { x: number; y: number } {
    const cursor = this.textarea.visualCursor
    return {
      x: this.textarea.screenX + cursor.visualCol - back,
      y: this.textarea.screenY + cursor.visualRow,
    }
  }

  replaceBeforeCursor(length: number, text: string): void {
    const { row, col } = this.textarea.logicalCursor
    if (length > 0) this.textarea.deleteRange(row, col - length, row, col)
    this.textarea.insertText(text)
  }

  setQuery(text: string): void {
    this.textarea.replaceText(text)
    this.textarea.gotoBufferEnd()
  }

  focus(): void {
    this.textarea.focus()
  }

  get query(): string {
    return this.textarea.plainText
  }

  destroy(): void {
    this.syntaxStyle.destroy()
  }
}
