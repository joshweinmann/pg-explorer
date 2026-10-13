import { KeyedStore } from "../config/keyed-store"

export interface HistoryEntry {
  query: string
  ranAt: string
}

export const HISTORY_LIMIT = 500

// Newest first; an identical query moves to the top instead of duplicating.
export function addEntry(
  entries: HistoryEntry[],
  query: string,
  now: Date,
  limit = HISTORY_LIMIT,
): HistoryEntry[] {
  const trimmed = query.trim()
  const rest = entries.filter((entry) => entry.query !== trimmed)
  return [{ query: trimmed, ranAt: now.toISOString() }, ...rest].slice(0, limit)
}

// Leaves the list untouched when the query is already a favorite.
export function addFavorite(entries: HistoryEntry[], query: string, now: Date): HistoryEntry[] {
  const trimmed = query.trim()
  if (entries.some((entry) => entry.query === trimmed)) return entries
  return [{ query: trimmed, ranAt: now.toISOString() }, ...entries]
}

export function removeEntry(entries: HistoryEntry[], query: string): HistoryEntry[] {
  return entries.filter((entry) => entry.query !== query)
}

export function matchesFilter(query: string, text: string): boolean {
  return query.toLowerCase().includes(text.trim().toLowerCase())
}

export function relativeTime(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry
  return typeof entry?.query === "string" && typeof entry?.ranAt === "string"
}

export function validateEntries(value: unknown): HistoryEntry[] | null {
  return Array.isArray(value) ? value.filter(isEntry) : null
}

// Per-connection query lists in one JSON file (used for history and favorites).
export class QueryStore {
  private readonly store: KeyedStore<HistoryEntry[]>

  constructor(path: string) {
    this.store = new KeyedStore(path, validateEntries)
  }

  async load(key: string): Promise<HistoryEntry[]> {
    return (await this.store.load(key)) ?? []
  }

  update(key: string, change: (entries: HistoryEntry[]) => HistoryEntry[]): Promise<HistoryEntry[]> {
    return this.store.update(key, (current) => change(current ?? []))
  }
}
