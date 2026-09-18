export type CellKind = "text" | "null" | "true" | "false" | "number"

export interface FormattedCell {
  text: string
  kind: CellKind
}

export const MAX_ROWS_NOTE = 5000
export const DEFAULT_PAGE_SIZE = 50
export const MAX_CELL_WIDTH = 40

export function truncateForDisplay(text: string, maxWidth = MAX_CELL_WIDTH): string {
  if (text.length <= maxWidth) return text
  return `${text.slice(0, maxWidth - 1)}…`
}

export function formatCell(value: unknown): FormattedCell {
  if (value === null || value === undefined) return { text: "∅", kind: "null" }
  if (typeof value === "boolean") return { text: value ? "true" : "false", kind: value ? "true" : "false" }
  if (typeof value === "number" || typeof value === "bigint")
    return { text: String(value), kind: "number" }
  if (value instanceof Date) return { text: value.toISOString(), kind: "text" }
  if (typeof value === "string") return { text: sanitizeCellText(value), kind: "text" }
  if (typeof value === "object") return { text: JSON.stringify(value), kind: "text" }
  return { text: sanitizeCellText(String(value)), kind: "text" }
}

export function sanitizeCellText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n").replace(/\t/g, "  ")
}

export function uniqueColumnNames(columns: string[]): string[] {
  const used = new Set<string>()
  return columns.map((name) => {
    if (!used.has(name)) {
      used.add(name)
      return name
    }
    let counter = 2
    let candidate = `${name}_${counter}`
    while (used.has(candidate)) {
      counter++
      candidate = `${name}_${counter}`
    }
    used.add(candidate)
    return candidate
  })
}

export function rowToJson(columns: string[], row: unknown[]): string {
  const obj: Record<string, unknown> = {}
  columns.forEach((name, i) => {
    obj[name] = row[i] ?? null
  })
  return JSON.stringify(obj)
}

export interface PageSlice {
  start: number
  end: number
  pageIndex: number
  pageCount: number
}

export function paginate(rowCount: number, pageIndex: number, pageSize = DEFAULT_PAGE_SIZE): PageSlice {
  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize))
  const clamped = Math.min(Math.max(0, pageIndex), pageCount - 1)
  const start = clamped * pageSize
  return { start, end: Math.min(start + pageSize, rowCount), pageIndex: clamped, pageCount }
}

export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${elapsedMs.toFixed(1)}ms`
  return `${(elapsedMs / 1000).toFixed(2)}s`
}

export function rowsFooter(
  rowCount: number,
  truncated: boolean,
  pageIndex: number,
  pageCount: number,
  elapsedMs: number,
  rowCap: number = MAX_ROWS_NOTE,
): string {
  const noun = rowCount === 1 ? "row" : "rows"
  const parts = [`${rowCount} ${noun}`, `page ${pageIndex + 1}/${pageCount}`, formatElapsed(elapsedMs)]
  if (truncated) parts.push(`capped at ${rowCap}`)
  return parts.join(" · ")
}

export function commandFooter(commandTag: string, rowCount: number | null, elapsedMs: number): string {
  const tag = rowCount === null ? commandTag : `${commandTag} ${rowCount}`
  return `${tag} · ${formatElapsed(elapsedMs)}`
}
