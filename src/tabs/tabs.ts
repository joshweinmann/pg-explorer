export interface SavedTab {
  name: string
  query: string
}

export interface TabSession {
  active: number
  tabs: SavedTab[]
}

export const MAX_TAB_NAME = 24
const SEPARATOR = "│"
const MORE_LEFT = "‹"
const MORE_RIGHT = "›"

export function validateSession(value: unknown): TabSession | null {
  const session = value as TabSession
  if (!session || typeof session !== "object" || !Array.isArray(session.tabs)) return null
  const tabs = session.tabs.filter(
    (tab): tab is SavedTab => typeof tab?.name === "string" && typeof tab?.query === "string",
  )
  if (tabs.length === 0) return null
  const active = Number.isInteger(session.active) ? Math.min(Math.max(0, session.active), tabs.length - 1) : 0
  return { active, tabs }
}

export const DEFAULT_TAB_NAME = "NEW TAB"

export interface TabBarItem {
  index: number
  x: number
  text: string
}

export interface TabBarLayout {
  items: TabBarItem[]
  moreLeft: boolean
  moreRight: boolean
}

function label(name: string, index: number): string {
  const short = name.length > MAX_TAB_NAME ? `${name.slice(0, MAX_TAB_NAME - 1)}…` : name
  return ` ${index + 1} ${short} `
}

// Lays tabs out left to right, sliding the window so the active tab is always visible.
export function tabBarLayout(names: string[], active: number, width: number): TabBarLayout {
  const labels = names.map(label)
  const span = (from: number, to: number) => {
    let total = 0
    for (let i = from; i <= to; i++) total += labels[i]!.length + (i > from ? SEPARATOR.length : 0)
    return total
  }
  let start = 0
  while (start < active && (start > 0 ? MORE_LEFT.length : 0) + span(start, active) + MORE_RIGHT.length > width) {
    start++
  }
  const items: TabBarItem[] = []
  let x = start > 0 ? MORE_LEFT.length : 0
  let end = start
  for (let i = start; i < labels.length; i++) {
    const sep = i > start ? SEPARATOR.length : 0
    const reserve = i < labels.length - 1 ? MORE_RIGHT.length : 0
    if (i > active && x + sep + labels[i]!.length + reserve > width) break
    x += sep
    items.push({ index: i, x, text: labels[i]! })
    x += labels[i]!.length
    end = i
  }
  return { items, moreLeft: start > 0, moreRight: end < labels.length - 1 }
}

export function tabAt(layout: TabBarLayout, x: number): number | null {
  const item = layout.items.find((i) => x >= i.x && x < i.x + i.text.length)
  return item ? item.index : null
}

export const TAB_SEPARATOR = SEPARATOR
export const TAB_MORE_LEFT = MORE_LEFT
export const TAB_MORE_RIGHT = MORE_RIGHT
