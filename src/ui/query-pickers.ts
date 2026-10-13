import type { CliRenderer, KeyEvent } from "@opentui/core"
import { theme } from "../theme"
import { errorMessage } from "../errors"
import { PickerDialog, type PickerItem } from "./picker"
import {
  addEntry,
  addFavorite,
  matchesFilter,
  QueryStore,
  relativeTime,
  removeEntry,
  type HistoryEntry,
} from "../history/history"

export interface QueryPickerCallbacks {
  onPick: (query: string) => void
  onClose: () => void
  notify: (text: string, color: string) => void
}

const STAR = "★ "
const NO_STAR = "  "


function oneLine(query: string): string {
  return query.replace(/\s+/g, " ")
}

function filterByQuery(items: PickerItem<string>[], text: string): PickerItem<string>[] {
  return items.filter((item) => matchesFilter(item.value, text))
}

// History (ctrl+r) and favorites (ctrl+f) pickers plus their per-connection stores.
export class QueryPickers {
  readonly history: PickerDialog<string>
  readonly favorites: PickerDialog<string>
  connectionKey: string | null = null
  private readonly historyStore: QueryStore
  private readonly favoritesStore: QueryStore
  private readonly callbacks: QueryPickerCallbacks
  private historyEntries: HistoryEntry[] = []
  private favoriteEntries: HistoryEntry[] = []

  constructor(
    renderer: CliRenderer,
    paths: { history: string; favorites: string },
    callbacks: QueryPickerCallbacks,
  ) {
    this.callbacks = callbacks
    this.historyStore = new QueryStore(paths.history)
    this.favoritesStore = new QueryStore(paths.favorites)
    this.history = new PickerDialog(renderer, "history-picker", callbacks.onPick)
    this.favorites = new PickerDialog(renderer, "favorites-picker", callbacks.onPick)
  }

  get roots() {
    return [this.history.root, this.favorites.root]
  }

  get isOpen(): boolean {
    return this.history.isOpen || this.favorites.isOpen
  }

  // Returns true when the key was consumed by an open picker.
  handleKey(key: KeyEvent): boolean {
    const picker = this.history.isOpen ? this.history : this.favorites.isOpen ? this.favorites : null
    if (!picker) return false
    const toggleKey = picker === this.history ? "r" : "f"
    if (key.name === "escape" || (key.ctrl && key.name === toggleKey)) {
      key.preventDefault()
      picker.close()
      this.callbacks.onClose()
      return true
    }
    if (!key.meta && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      picker.moveSelection(key.name === "up" ? -1 : 1)
      return true
    }
    if (key.name === "return") {
      key.preventDefault()
      picker.pick()
      return true
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      if (picker === this.history) void this.starSelectedHistory()
      else void this.removeSelectedFavorite()
      return true
    }
    return false
  }

  async recordRun(query: string): Promise<void> {
    const key = this.connectionKey
    if (!key) return
    // History is best-effort; a failed write must not disturb the result view.
    await this.historyStore.update(key, (entries) => addEntry(entries, query, new Date())).catch(() => {})
  }

  async saveFavorite(query: string): Promise<void> {
    const key = this.connectionKey
    if (!key) {
      this.callbacks.notify("connect to a database to save favorites", theme.warning)
      return
    }
    try {
      let added = false
      await this.favoritesStore.update(key, (entries) => {
        const next = addFavorite(entries, query, new Date())
        added = next !== entries
        return next
      })
      if (added) this.callbacks.notify("saved to favorites", theme.success)
      else this.callbacks.notify("already a favorite", theme.warning)
    } catch (err) {
      this.callbacks.notify(`failed to save favorite: ${errorMessage(err)}`, theme.error)
    }
  }

  async openHistory(): Promise<void> {
    const key = this.connectionKey
    let emptyText = "no history yet for this connection"
    this.historyEntries = []
    this.favoriteEntries = []
    if (!key) {
      emptyText = "connect to a database to see its history"
    } else {
      try {
        ;[this.historyEntries, this.favoriteEntries] = await Promise.all([
          this.historyStore.load(key),
          this.favoritesStore.load(key),
        ])
      } catch (err) {
        emptyText = `failed to load history: ${errorMessage(err)}`
      }
    }
    if (this.isOpen) return
    this.history.open({
      title: "History",
      items: this.historyItems(),
      emptyText,
      hint: "↑↓ move · enter pick · ctrl+s favorite · esc close",
      filter: filterByQuery,
    })
  }

  async openFavorites(): Promise<void> {
    const key = this.connectionKey
    let emptyText = "no favorites yet · ctrl+s in the editor or history saves one"
    this.favoriteEntries = []
    if (!key) {
      emptyText = "connect to a database to see its favorites"
    } else {
      try {
        this.favoriteEntries = await this.favoritesStore.load(key)
      } catch (err) {
        emptyText = `failed to load favorites: ${errorMessage(err)}`
      }
    }
    if (this.isOpen) return
    this.favorites.open({
      title: "Favorites",
      items: this.favoriteItems(),
      emptyText,
      hint: "↑↓ move · enter pick · ctrl+s remove · esc close",
      filter: filterByQuery,
    })
  }

  private historyItems(): PickerItem<string>[] {
    const starred = new Set(this.favoriteEntries.map((entry) => entry.query))
    const now = new Date()
    return this.historyEntries.map((entry) => ({
      label: `${starred.has(entry.query) ? STAR : NO_STAR}${oneLine(entry.query)}`,
      meta: relativeTime(new Date(entry.ranAt), now),
      preview: entry.query,
      value: entry.query,
    }))
  }

  private favoriteItems(): PickerItem<string>[] {
    const now = new Date()
    return this.favoriteEntries.map((entry) => ({
      label: oneLine(entry.query),
      meta: relativeTime(new Date(entry.ranAt), now),
      preview: entry.query,
      value: entry.query,
    }))
  }

  private async starSelectedHistory(): Promise<void> {
    const key = this.connectionKey
    const query = this.history.selectedItem?.value
    if (!key || !query) return
    if (this.favoriteEntries.some((entry) => entry.query === query)) {
      this.history.setStatus("already a favorite", theme.warning)
      return
    }
    try {
      this.favoriteEntries = await this.favoritesStore.update(key, (entries) =>
        addFavorite(entries, query, new Date()),
      )
      this.history.setItems(this.historyItems())
      this.history.setStatus("saved to favorites", theme.success)
    } catch (err) {
      this.history.setStatus(`failed to save favorite: ${errorMessage(err)}`, theme.error)
    }
  }

  private async removeSelectedFavorite(): Promise<void> {
    const key = this.connectionKey
    const query = this.favorites.selectedItem?.value
    if (!key || !query) return
    try {
      this.favoriteEntries = await this.favoritesStore.update(key, (entries) => removeEntry(entries, query))
      this.favorites.setItems(this.favoriteItems())
      this.favorites.setStatus("removed from favorites", theme.success)
    } catch (err) {
      this.favorites.setStatus(`failed to remove favorite: ${errorMessage(err)}`, theme.error)
    }
  }
}
