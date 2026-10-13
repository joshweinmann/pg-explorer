import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { theme } from "../theme"
import { createOverlay } from "./overlay"

const DIALOG_WIDTH = 44

// Single-line text prompt (e.g. renaming a tab). Escape is handled by the app.
export class PromptDialog {
  readonly root: BoxRenderable
  private readonly panel: BoxRenderable
  private readonly input: InputRenderable
  private onSubmit: ((value: string) => void) | null = null
  private opened = false

  constructor(renderer: CliRenderer) {
    this.root = createOverlay(renderer, "prompt-dialog-overlay")
    this.panel = new BoxRenderable(renderer, {
      id: "prompt-dialog",
      width: DIALOG_WIDTH,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.focus,
      backgroundColor: theme.bg,
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.input = new InputRenderable(renderer, {
      id: "prompt-dialog-input",
      width: "100%",
      textColor: theme.fg,
      cursorColor: theme.focus,
    })
    this.input.on(InputRenderableEvents.ENTER, () => {
      const submit = this.onSubmit
      const value = this.input.value
      this.close()
      submit?.(value)
    })
    this.panel.add(this.input)
    this.panel.add(
      new TextRenderable(renderer, {
        id: "prompt-dialog-hint",
        content: "enter save · esc cancel",
        fg: theme.dim,
        height: 1,
      }),
    )
    this.root.add(this.panel)
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(title: string, value: string, onSubmit: (value: string) => void): void {
    this.onSubmit = onSubmit
    this.panel.title = ` ${title} `
    this.input.value = value
    this.opened = true
    this.root.visible = true
    this.input.focus()
  }

  close(): void {
    this.input.blur()
    this.opened = false
    this.root.visible = false
    this.onSubmit = null
  }
}
