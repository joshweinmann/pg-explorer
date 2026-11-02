import type { CliRenderer, KeyEvent } from "@opentui/core"
import { theme } from "../theme"
import { PickerDialog, type PickerItem } from "./picker"
import { connectionId, type StoredConfig } from "../config/config"

export type ConnectionChoice = { kind: "new" } | { kind: "saved"; config: StoredConfig }

export interface ConnectionPickerCallbacks {
  onChoose: (choice: ConnectionChoice) => void
  onEdit: (config: StoredConfig) => void
  onDelete: (config: StoredConfig) => void
  onClose: () => void
}

const HINT = "↑↓ move · enter connect · ctrl+e edit · ctrl+d delete · esc close"
const ACTIVE = "● "
const INACTIVE = "  "

function preview(config: StoredConfig): string {
  return [
    ...(config.name ? [["name", config.name]] : []),
    ["host", config.host],
    ["port", String(config.port)],
    ["user", config.user],
    ["database", config.database],
    ["password", config.password ? "saved" : (config.passwordRef ?? "not saved")],
    ...(config.notes ? [["notes", config.notes]] : []),
  ]
    .map(([label, value]) => `${label!.padEnd(10)}${value}`)
    .join("\n")
}

export class ConnectionPicker {
  readonly picker: PickerDialog<ConnectionChoice>
  private readonly callbacks: ConnectionPickerCallbacks
  private pendingDelete: string | null = null

  constructor(renderer: CliRenderer, callbacks: ConnectionPickerCallbacks) {
    this.callbacks = callbacks
    this.picker = new PickerDialog(renderer, "connection-picker", callbacks.onChoose)
  }

  get root() {
    return this.picker.root
  }

  get isOpen(): boolean {
    return this.picker.isOpen
  }

  open(connections: StoredConfig[], activeId: string | null): void {
    this.pendingDelete = null
    this.picker.open({
      title: "Connections",
      items: this.items(connections, activeId),
      emptyText: "no matching connections",
      hint: HINT,
      plainPreview: true,
      filter: (items, text) => {
        const needle = text.trim().toLowerCase()
        return items.filter((item) => {
          if (item.value.kind === "new") return true
          const { name, notes } = item.value.config
          return [item.label, item.meta, name, notes].some((text) => text?.toLowerCase().includes(needle))
        })
      },
    })
  }

  refresh(connections: StoredConfig[], activeId: string | null): void {
    this.picker.setItems(this.items(connections, activeId))
  }

  close(): void {
    this.pendingDelete = null
    this.picker.close()
  }

  // Returns true when the key was consumed by the open picker.
  handleKey(key: KeyEvent): boolean {
    if (!this.isOpen) return false
    const isDelete = key.ctrl && key.name === "d"
    if (!isDelete && this.pendingDelete) {
      this.pendingDelete = null
      this.picker.setStatus(HINT, theme.dim)
    }
    if (key.name === "escape" || (key.ctrl && key.name === "o")) {
      key.preventDefault()
      this.close()
      this.callbacks.onClose()
      return true
    }
    if (!key.meta && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      this.picker.moveSelection(key.name === "up" ? -1 : 1)
      return true
    }
    if (key.name === "return") {
      key.preventDefault()
      this.picker.pick()
      return true
    }
    const choice = this.picker.selectedItem?.value
    if (key.ctrl && key.name === "e") {
      key.preventDefault()
      if (choice?.kind === "saved") {
        this.close()
        this.callbacks.onEdit(choice.config)
      }
      return true
    }
    if (isDelete) {
      key.preventDefault()
      if (choice?.kind !== "saved") return true
      const id = connectionId(choice.config)
      if (this.pendingDelete === id) {
        this.pendingDelete = null
        this.picker.setStatus(`deleted ${id}`, theme.success)
        this.callbacks.onDelete(choice.config)
      } else {
        this.pendingDelete = id
        this.picker.setStatus(`delete ${id}? ctrl+d again to confirm`, theme.warning)
      }
      return true
    }
    return false
  }

  private items(connections: StoredConfig[], activeId: string | null): PickerItem<ConnectionChoice>[] {
    const items: PickerItem<ConnectionChoice>[] = [
      { label: "+ new connection", meta: "", preview: "create a new connection", value: { kind: "new" } },
    ]
    for (const config of connections) {
      const id = connectionId(config)
      items.push({
        label: `${id === activeId ? ACTIVE : INACTIVE}${config.name ?? id}`,
        meta: config.name ? id : "",
        preview: preview(config),
        value: { kind: "saved", config },
      })
    }
    return items
  }
}
