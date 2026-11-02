import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from "@opentui/core"
import { theme } from "../theme"
import { createOverlay } from "./overlay"

const KEY_WIDTH = 17
const COLUMN_WIDTH = 45
const COLUMN_GAP = 2

interface HelpSection {
  title: string
  rows: [string, string][]
}

const COLUMNS: HelpSection[][] = [
  [
    {
      title: "Global",
      rows: [
        ["ctrl+q", "quit"],
        ["ctrl+o", "connections"],
        ["ctrl+b", "toggle sidebar"],
        ["ctrl+1 / 2 / 3", "focus panel"],
        ["tab / shift+tab", "cycle panel focus"],
        ["ctrl+r", "query history"],
        ["ctrl+f", "favorite queries"],
        ["ctrl+h", "this help"],
        ["esc", "close dialog"],
      ],
    },
    {
      title: "Editor",
      rows: [
        ["ctrl+enter", "run statement at cursor"],
        ["ctrl+z", "undo"],
        ["ctrl+shift+z", "redo"],
        ["ctrl+s", "save as favorite"],
        ["ctrl+space", "autocomplete"],
        ["tab / enter", "accept suggestion"],
      ],
    },
    {
      title: "Pickers",
      rows: [
        ["type", "filter"],
        ["up / down", "move"],
        ["enter", "pick"],
        ["ctrl+s", "favorite / unfavorite"],
        ["ctrl+e / ctrl+d", "edit / delete connection"],
      ],
    },
  ],
  [
    {
      title: "Sidebar",
      rows: [
        ["up / down", "move cursor"],
        ["enter / space", "expand / collapse"],
        ["r", "refresh schemas"],
        ["click", "select row"],
        ["double-click", "expand / collapse"],
      ],
    },
    {
      title: "Results",
      rows: [
        ["up / down", "move row selection"],
        ["left / right", "scroll sideways"],
        ["home / end", "first / last row"],
        ["pgup/pgdn, p/n", "previous / next page"],
        ["c", "copy row as JSON"],
        ["click", "select row"],
        ["double-click", "copy row as JSON"],
        ["click header", "sort asc / desc / off"],
      ],
    },
    {
      title: "Tabs",
      rows: [
        ["ctrl+t / ctrl+w", "new / close tab"],
        ["alt+1 … 9", "jump to tab"],
        ["ctrl+n", "rename tab"],
        ["click tab", "switch to tab"],
      ],
    },
  ],
]

export class HelpDialog {
  readonly root: BoxRenderable
  private opened = false

  constructor(renderer: CliRenderer) {
    this.root = createOverlay(renderer, "help-dialog-overlay")

    const panel = new BoxRenderable(renderer, {
      id: "help-dialog",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.focus,
      backgroundColor: theme.bg,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
    })

    panel.add(
      new TextRenderable(renderer, {
        id: "help-dialog-title",
        content: "KEYBOARD SHORTCUTS",
        fg: theme.fg,
        attributes: TextAttributes.BOLD,
        height: 1,
      }),
    )

    const columns = new BoxRenderable(renderer, {
      id: "help-dialog-columns",
      flexDirection: "row",
      gap: COLUMN_GAP,
    })
    for (const [index, sections] of COLUMNS.entries()) {
      const column = new BoxRenderable(renderer, {
        id: `help-dialog-column-${index}`,
        width: COLUMN_WIDTH,
        flexDirection: "column",
      })
      for (const section of sections) {
        column.add(
          new TextRenderable(renderer, {
            id: `help-dialog-section-${section.title}`,
            content: section.title,
            fg: theme.warning,
            attributes: TextAttributes.BOLD,
            height: 1,
          }),
        )
        for (const [keys, description] of section.rows) {
          column.add(
            new TextRenderable(renderer, {
              id: `help-dialog-row-${section.title}-${keys}`,
              content: `  ${keys.padEnd(KEY_WIDTH)}${description}`,
              fg: theme.fg,
              height: 1,
              wrapMode: "none",
            }),
          )
        }
      }
      columns.add(column)
    }
    panel.add(columns)

    panel.add(
      new TextRenderable(renderer, {
        id: "help-dialog-hint",
        content: "esc / ctrl+h to close",
        fg: theme.dim,
        height: 1,
      }),
    )

    this.root.add(panel)
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    this.opened = true
    this.root.visible = true
  }

  close(): void {
    this.opened = false
    this.root.visible = false
  }
}
