import {
  BoxRenderable,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
} from "@opentui/core"
import { theme } from "../theme"

const DIALOG_WIDTH = 62

interface HelpSection {
  title: string
  rows: [string, string][]
}

const SECTIONS: HelpSection[] = [
  {
    title: "Global",
    rows: [
      ["ctrl+q", "quit"],
      ["ctrl+o", "connection dialog"],
      ["ctrl+b", "toggle sidebar"],
      ["ctrl+1 / 2 / 3", "focus panel"],
      ["tab / shift+tab", "cycle panel focus"],
      ["ctrl+h", "this help"],
      ["esc", "close dialog"],
    ],
  },
  {
    title: "Editor",
    rows: [["ctrl+enter", "execute query"]],
  },
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
      ["pageup / pagedown", "previous / next page"],
      ["n / p", "next / previous page"],
      ["c", "copy row as JSON"],
      ["click", "select row"],
      ["double-click", "copy row as JSON"],
    ],
  },
]

export class HelpDialog {
  readonly root: BoxRenderable
  private opened = false

  constructor(renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "help-dialog-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      backgroundColor: "#000000CC",
      visible: false,
      alignItems: "center",
      justifyContent: "center",
    })

    const panel = new BoxRenderable(renderer, {
      id: "help-dialog",
      width: DIALOG_WIDTH,
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

    for (const section of SECTIONS) {
      panel.add(
        new TextRenderable(renderer, {
          id: `help-dialog-section-${section.title}`,
          content: section.title,
          fg: theme.warning,
          attributes: TextAttributes.BOLD,
          height: 1,
        }),
      )
      for (const [keys, description] of section.rows) {
        panel.add(
          new TextRenderable(renderer, {
            id: `help-dialog-row-${section.title}-${keys}`,
            content: `  ${keys.padEnd(25)}${description}`,
            fg: theme.fg,
            height: 1,
            wrapMode: "none",
          }),
        )
      }
    }

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
