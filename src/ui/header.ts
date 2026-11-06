import {
  ASCIIFontRenderable,
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { theme } from "../theme"
import type { ConnectionState } from "../state"

const STATUS_TEXT: Record<ConnectionState, string> = {
  disconnected: "● disconnected",
  connecting: "● connecting…",
  connected: "● connected",
  error: "● error",
}

const STATUS_COLOR: Record<ConnectionState, string> = {
  disconnected: theme.error,
  connecting: theme.warning,
  connected: theme.success,
  error: theme.error,
}

export class Header {
  readonly root: BoxRenderable
  private readonly status: TextRenderable

  constructor(renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "header",
      width: "100%",
      height: 2,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: 1,
      paddingRight: 1,
    })

    const title = new ASCIIFontRenderable(renderer, {
      id: "header-title",
      text: "PG EXPLORER",
      font: "tiny",
      color: theme.fk,
      selectable: false,
    })

    const spacer = new BoxRenderable(renderer, {
      id: "header-spacer",
      flexGrow: 1,
      height: 1,
    })

    this.status = new TextRenderable(renderer, {
      id: "header-status",
      content: STATUS_TEXT.disconnected,
      fg: STATUS_COLOR.disconnected,
    })

    this.root.add(title)
    this.root.add(spacer)
    this.root.add(this.status)
  }

  setConnection(state: ConnectionState, label?: string): void {
    const text = label ? `● ${label}` : STATUS_TEXT[state]
    this.status.content = text
    this.status.fg = STATUS_COLOR[state]
  }
}
