import { splitStatements } from "../sql/statements"

export type SortDir = "asc" | "desc"

export interface SortState {
  column: number
  dir: SortDir
}

export function nextSort(current: SortState | null, column: number): SortState | null {
  if (!current || current.column !== column) return { column, dir: "asc" }
  if (current.dir === "asc") return { column, dir: "desc" }
  return null
}

const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?infinity$|^nan$/i

// The driver returns int8/numeric as strings, so a column whose non-null values
// all look numeric (including NaN/Infinity) is compared numerically.
function isNumericColumn(rows: unknown[][], column: number): boolean {
  let seen = false
  for (const row of rows) {
    const value = row[column]
    if (value === null || value === undefined) continue
    if (typeof value === "number" || typeof value === "bigint") {
      seen = true
      continue
    }
    if (typeof value !== "string" || !NUMERIC.test(value.trim())) return false
    seen = true
  }
  return seen
}

// Postgres order: -Infinity < finite < Infinity < NaN.
function numericRank(value: unknown): number {
  const text = typeof value === "string" ? value.trim().toLowerCase() : null
  if (typeof value === "number" ? Number.isNaN(value) : text === "nan") return 3
  if (value === Infinity || text === "infinity" || text === "+infinity") return 2
  if (value === -Infinity || text === "-infinity") return 0
  return 1
}

// Exact comparison of plain decimal strings of any length (no exponent).
export function compareDecimalStrings(a: string, b: string): number {
  const parse = (text: string) => {
    const trimmed = text.trim()
    const negative = trimmed.startsWith("-")
    const unsigned = trimmed.replace(/^[+-]/, "")
    const [intRaw = "", fracRaw = ""] = unsigned.split(".")
    const int = intRaw.replace(/^0+/, "")
    const frac = fracRaw.replace(/0+$/, "")
    const zero = int === "" && frac === ""
    return { negative: negative && !zero, int, frac }
  }
  const x = parse(a)
  const y = parse(b)
  if (x.negative !== y.negative) return x.negative ? -1 : 1
  let magnitude = 0
  if (x.int.length !== y.int.length) magnitude = x.int.length - y.int.length
  else if (x.int !== y.int) magnitude = x.int < y.int ? -1 : 1
  else {
    const width = Math.max(x.frac.length, y.frac.length)
    const fx = x.frac.padEnd(width, "0")
    const fy = y.frac.padEnd(width, "0")
    magnitude = fx === fy ? 0 : fx < fy ? -1 : 1
  }
  return Math.sign(x.negative ? -magnitude : magnitude)
}

function compareNumeric(a: unknown, b: unknown): number {
  const ra = numericRank(a)
  const rb = numericRank(b)
  if (ra !== rb || ra !== 1) return ra - rb
  if (typeof a === "string" && typeof b === "string" && PLAIN_DECIMAL.test(a.trim()) && PLAIN_DECIMAL.test(b.trim())) {
    return compareDecimalStrings(a, b)
  }
  const x = typeof a === "bigint" ? a : Number(a)
  const y = typeof b === "bigint" ? b : Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function compareNonNull(a: unknown, b: unknown, numeric: boolean): number {
  if (numeric) return compareNumeric(a, b)
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  const x = typeof a === "object" ? JSON.stringify(a) : String(a)
  const y = typeof b === "object" ? JSON.stringify(b) : String(b)
  return x.localeCompare(y)
}

// Stable; nulls sort last ascending and first descending, matching Postgres defaults.
export function sortRows(rows: unknown[][], sort: SortState): unknown[][] {
  const numeric = isNumericColumn(rows, sort.column)
  const sign = sort.dir === "asc" ? 1 : -1
  return rows.toSorted((ra, rb) => {
    const a = ra[sort.column]
    const b = rb[sort.column]
    const aNull = a === null || a === undefined
    const bNull = b === null || b === undefined
    if (aNull || bNull) return sign * (Number(aNull) - Number(bNull))
    return sign * compareNonNull(a, b, numeric)
  })
}

const READ_ONLY_START = /^(select|with|values|table)\b/i
const WRITES = /\b(insert|update|delete|merge|truncate|into|call|copy|nextval|setval)\b/i

// One left-to-right pass so whichever construct starts first wins (a quote
// inside a comment does not open a string, and vice versa).
const NON_CODE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|"(?:[^"]|"")*"|\/\*[\s\S]*?\*\/|--[^\n]*/g

function maskStringsAndComments(sql: string): string {
  return sql.replace(NON_CODE, " ")
}

// A capped result may only be re-run with ORDER BY when that is safe: a single
// read-only statement. Returns the statement without its `;` and surrounding
// comments, or null when the sort must stay in memory.
export function requeryableQuery(query: string): string | null {
  const ranges = splitStatements(query)
  if (ranges.length !== 1) return null
  const statement = query.slice(ranges[0]!.start, ranges[0]!.end).replace(/;$/, "").trim()
  const code = maskStringsAndComments(statement).trim()
  if (!READ_ONLY_START.test(code) || WRITES.test(code)) return null
  return statement
}

export function orderByQuery(statement: string, sort: SortState): string {
  return `SELECT * FROM (\n${statement}\n) AS sorted ORDER BY ${sort.column + 1} ${sort.dir.toUpperCase()}`
}
