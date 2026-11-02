import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  type InputRenderableOptions,
} from "@opentui/core"
import { theme } from "../theme"
import { createOverlay } from "./overlay"
import { MaskedInput } from "./masked-input"
import type { ConnectionFormValues } from "../config/config"

const FIELD_LABELS = ["name", "host", "port", "user", "database", "password", "notes"] as const
const PASSWORD_INDEX = FIELD_LABELS.indexOf("password")
const DIALOG_WIDTH = 60
const LABEL_WIDTH = 10

export interface ConnectionDialogCallbacks {
  onSubmit: (values: ConnectionFormValues) => void
  onCancel: () => void
}

export class ConnectionDialog {
  readonly root: BoxRenderable
  private readonly fields: InputRenderable[]
  private readonly status: TextRenderable
  private readonly callbacks: ConnectionDialogCallbacks
  private opened = false

  constructor(renderer: CliRenderer, callbacks: ConnectionDialogCallbacks) {
    this.callbacks = callbacks

    this.root = createOverlay(renderer, "connection-dialog-overlay")

    const panel = new BoxRenderable(renderer, {
      id: "connection-dialog",
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
        id: "connection-dialog-title",
        content: "CONNECT TO POSTGRES",
        fg: theme.fg,
        attributes: TextAttributes.BOLD,
        height: 1,
      }),
    )

    this.fields = FIELD_LABELS.map((label) => this.buildField(renderer, panel, label))

    this.status = new TextRenderable(renderer, {
      id: "connection-dialog-status",
      content: "",
      fg: theme.dim,
      height: 3,
      wrapMode: "word",
    })
    panel.add(this.status)

    panel.add(
      new TextRenderable(renderer, {
        id: "connection-dialog-hint",
        content: "↑↓ switch field · enter=connect · esc=cancel",
        fg: theme.dim,
        height: 1,
      }),
    )

    this.root.add(panel)
  }

  private buildField(
    renderer: CliRenderer,
    panel: BoxRenderable,
    label: string,
  ): InputRenderable {
    const row = new BoxRenderable(renderer, {
      id: `connection-dialog-row-${label}`,
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      paddingTop: 1,
    })

    row.add(
      new TextRenderable(renderer, {
        id: `connection-dialog-label-${label}`,
        content: label.padEnd(LABEL_WIDTH),
        fg: theme.dim,
        width: LABEL_WIDTH,
      }),
    )

    const options: InputRenderableOptions = {
      id: `connection-dialog-input-${label}`,
      placeholder: label === "password" ? "type password" : "",
      textColor: theme.fg,
      cursorColor: theme.focus,
      width: DIALOG_WIDTH - LABEL_WIDTH - 2 * 3,
      keyBindings: [{ name: "return", ctrl: true, action: "submit" }],
    }

    const input =
      label === "password"
        ? new MaskedInput(renderer, options)
        : new InputRenderable(renderer, options)

    input.on(InputRenderableEvents.ENTER, () => this.callbacks.onSubmit(this.getValues()))

    row.add(input)
    panel.add(row)
    return input
  }

  get isOpen(): boolean {
    return this.opened
  }

  get focusedFieldIndex(): number {
    return this.fields.findIndex((field) => field.focused)
  }

  open(prefill: ConnectionFormValues, focusPassword = false): void {
    FIELD_LABELS.forEach((label, i) => {
      if (label !== "password") this.setField(i, prefill[label])
    })
    const password = this.fields[PASSWORD_INDEX]
    if (password instanceof MaskedInput) password.realValue = prefill.password

    this.status.content = ""
    this.status.fg = theme.dim
    this.opened = true
    this.root.visible = true

    const target = focusPassword ? this.fields[PASSWORD_INDEX] : this.fields[0]
    target?.focus()
  }

  close(): void {
    this.opened = false
    this.root.visible = false
  }

  showError(message: string): void {
    this.status.content = message
    this.status.fg = theme.error
  }

  showConnecting(): void {
    this.status.content = "connecting…"
    this.status.fg = theme.dim
  }

  private setField(index: number, value: string): void {
    const field = this.fields[index]
    if (field) field.value = value
  }

  moveFocus(delta: number): void {
    const current = this.focusedFieldIndex
    const base = current < 0 ? 0 : current
    const next = Math.min(Math.max(0, base + delta), this.fields.length - 1)
    this.fields[next]?.focus()
  }

  getValues(): ConnectionFormValues {
    const values = Object.fromEntries(
      FIELD_LABELS.map((label, i) => [label, this.fields[i]?.value ?? ""]),
    ) as unknown as ConnectionFormValues
    const password = this.fields[PASSWORD_INDEX]
    if (password instanceof MaskedInput) values.password = password.realValue
    return values
  }
}
