import { SQL_KEYWORDS } from "./keywords"

export type SqlTokenKind = "keyword" | "string" | "number" | "comment"

export interface SqlToken {
  start: number
  end: number
  kind: SqlTokenKind
}

const DIGIT = /[0-9]/
const WORD_START = /[A-Za-z_]/
const WORD_CHAR = /[A-Za-z0-9_$]/

export function tokenizeLine(line: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let i = 0

  while (i < line.length) {
    const ch = line[i]!

    if (ch === "-" && line[i + 1] === "-") {
      tokens.push({ start: i, end: line.length, kind: "comment" })
      break
    }

    if (ch === "'") {
      let j = i + 1
      let closed = false
      while (j < line.length) {
        if (line[j] === "'") {
          if (line[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          closed = true
          break
        }
        j++
      }
      if (!closed) j = line.length
      tokens.push({ start: i, end: j, kind: "string" })
      i = j
      continue
    }

    if (ch === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j++
      if (j < line.length) j++
      i = j
      continue
    }

    if (DIGIT.test(ch)) {
      let j = i
      while (j < line.length && /[0-9]/.test(line[j]!)) j++
      if (line[j] === "." && line[j + 1] !== undefined && /[0-9]/.test(line[j + 1]!)) {
        j++
        while (j < line.length && /[0-9]/.test(line[j]!)) j++
      }
      tokens.push({ start: i, end: j, kind: "number" })
      i = j
      continue
    }

    if (WORD_START.test(ch)) {
      let j = i
      while (j < line.length && WORD_CHAR.test(line[j]!)) j++
      if (SQL_KEYWORDS.has(line.slice(i, j).toUpperCase())) {
        tokens.push({ start: i, end: j, kind: "keyword" })
      }
      i = j
      continue
    }

    i++
  }

  return tokens
}
