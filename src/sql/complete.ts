import type { SchemaInfo, TableInfo } from "../db/metadata"
import { SQL_KEYWORDS } from "./keywords"
import { tokenizeLine } from "./highlight"
import { statementAt } from "./statements"

export type CompletionKind = "column" | "table" | "keyword"

export interface CompletionItem {
  label: string
  insert: string
  kind: CompletionKind
}

export interface Completion {
  start: number
  end: number
  items: CompletionItem[]
}

export interface TableRef {
  schema: string
  table: TableInfo
  alias: string | null
}

const WORD_CHAR = /[A-Za-z0-9_$]/
const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/
const TABLE_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE"])
const IDENT = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`
const TABLE_REF = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENT}(?:\\.${IDENT})?)(?:\\s+(?:AS\\s+)?(${IDENT}))?`,
  "gi",
)
const KIND_ORDER: Record<CompletionKind, number> = { column: 0, table: 1, keyword: 2 }

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replaceAll('""', '"') : ident.toLowerCase()
}

function quoteIdent(name: string): string {
  return PLAIN_IDENT.test(name) && !SQL_KEYWORDS.has(name.toUpperCase())
    ? name
    : `"${name.replaceAll('"', '""')}"`
}

function findTable(schemas: SchemaInfo[], schema: string | null, name: string): TableRef | null {
  const candidates = schemas
    .filter((s) => schema === null || s.name === schema)
    .flatMap((s) => s.tables.filter((t) => t.name === name).map((table) => ({ schema: s.name, table })))
  const match = candidates.find((c) => c.schema === "public") ?? candidates[0]
  return match ? { ...match, alias: null } : null
}

// Tables named after FROM/JOIN/UPDATE/INTO in the statement under the cursor.
export function statementTables(text: string, cursor: number, schemas: SchemaInfo[]): TableRef[] {
  const range = statementAt(text, cursor)
  const statement = range ? text.slice(range.start, Math.max(range.end, cursor)) : ""
  const refs: TableRef[] = []
  for (const match of statement.matchAll(TABLE_REF)) {
    const parts = match[1]!.match(new RegExp(IDENT, "g"))!.map(unquote)
    const ref = parts.length === 2 ? findTable(schemas, parts[0]!, parts[1]!) : findTable(schemas, null, parts[0]!)
    if (!ref) continue
    const alias = match[2] && !SQL_KEYWORDS.has(match[2].toUpperCase()) ? unquote(match[2]) : null
    refs.push({ ...ref, alias })
  }
  return refs
}

function insideStringOrComment(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const col = offset - lineStart
  const lineEnd = text.indexOf("\n", offset)
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
  return tokenizeLine(line).some(
    (t) => (t.kind === "string" || t.kind === "comment") && t.start < col && col <= t.end,
  )
}

function wordBefore(text: string, end: number): { word: string; start: number } {
  let start = end
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--
  return { word: text.slice(start, end), start }
}

function tableItem(schema: string, table: TableInfo, qualify: boolean): CompletionItem {
  const name = quoteIdent(table.name)
  const insert = qualify && schema !== "public" ? `${quoteIdent(schema)}.${name}` : name
  return { label: insert, insert, kind: "table" }
}

function columnItems(refs: TableRef[]): CompletionItem[] {
  return refs.flatMap((ref) =>
    (ref.table.columns ?? []).map((c) => ({ label: c.name, insert: quoteIdent(c.name), kind: "column" as const })),
  )
}

// `manual` allows an empty prefix (explicit trigger); otherwise only a typed word or `x.` opens suggestions.
export function complete(
  text: string,
  cursor: number,
  schemas: SchemaInfo[],
  manual = false,
): Completion | null {
  const { word: prefix, start } = wordBefore(text, cursor)
  if (insideStringOrComment(text, cursor)) return null
  if (/^[0-9$]/.test(prefix)) return null

  let items: CompletionItem[]
  const qualified = text[start - 1] === "."
  if (qualified) {
    const qualifier = wordBefore(text, start - 1).word.toLowerCase()
    if (!qualifier) return null
    const schema = schemas.find((s) => s.name === qualifier)
    const refs = statementTables(text, cursor, schemas).filter(
      (r) => r.alias === qualifier || (r.alias === null && r.table.name === qualifier),
    )
    items = [...columnItems(refs), ...(schema?.tables.map((t) => tableItem(schema.name, t, false)) ?? [])]
  } else {
    if (!prefix && !manual) return null
    let before = start
    while (before > 0 && /\s/.test(text[before - 1]!)) before--
    const previous = wordBefore(text, before).word.toUpperCase()
    const tables = schemas.flatMap((s) => s.tables.map((t) => tableItem(s.name, t, true)))
    if (TABLE_KEYWORDS.has(previous)) {
      items = tables
    } else {
      const lower = prefix !== "" && prefix === prefix.toLowerCase()
      const keywords = [...SQL_KEYWORDS].map((k) => {
        const insert = lower ? k.toLowerCase() : k
        return { label: insert, insert, kind: "keyword" as const }
      })
      items = [...columnItems(statementTables(text, cursor, schemas)), ...tables, ...keywords]
    }
  }

  const needle = prefix.toLowerCase()
  const seen = new Set<string>()
  const matches = items
    .filter((item) => {
      const name = item.label.slice(item.label.lastIndexOf(".") + 1).replaceAll('"', "").toLowerCase()
      const hit = item.label.toLowerCase().startsWith(needle) || name.startsWith(needle)
      if (!hit || item.insert === prefix || seen.has(item.insert)) return false
      seen.add(item.insert)
      return true
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label))
  return matches.length ? { start, end: cursor, items: matches } : null
}
