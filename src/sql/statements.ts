export interface TextRange {
  start: number
  end: number
}

export interface RunTarget extends TextRange {
  text: string
  startLine: number
  endLine: number
}

const WORD_CHAR = /[A-Za-z0-9_$]/
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

// Ranges cover code only: leading/trailing whitespace and comments are excluded,
// a terminating `;` is included. Segments holding only comments are dropped.
export function splitStatements(text: string): TextRange[] {
  const ranges: TextRange[] = []
  let codeStart = -1
  let codeEnd = -1
  let i = 0

  const markCode = (from: number, to: number) => {
    if (codeStart < 0) codeStart = from
    codeEnd = to
  }
  const flush = () => {
    if (codeStart >= 0) ranges.push({ start: codeStart, end: codeEnd })
    codeStart = -1
    codeEnd = -1
  }

  while (i < text.length) {
    const ch = text[i]!

    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? text.length : nl
      continue
    }

    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++
          j += 2
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--
          j += 2
        } else {
          j++
        }
      }
      i = j
      continue
    }

    if (ch === "'") {
      const prev = text[i - 1]
      const escapes = (prev === "E" || prev === "e") && !WORD_CHAR.test(text[i - 2] ?? "")
      let j = i + 1
      while (j < text.length) {
        if (escapes && text[j] === "\\") {
          j += 2
          continue
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      j = Math.min(j, text.length)
      markCode(i, j)
      i = j
      continue
    }

    if (ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      j = Math.min(j, text.length)
      markCode(i, j)
      i = j
      continue
    }

    if (ch === "$" && !WORD_CHAR.test(text[i - 1] ?? "")) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length)
        const j = close < 0 ? text.length : close + tag[0].length
        markCode(i, j)
        i = j
        continue
      }
    }

    if (ch === ";") {
      markCode(i, i + 1)
      flush()
      i++
      continue
    }

    if (!/\s/.test(ch)) markCode(i, i + 1)
    i++
  }

  flush()
  return ranges
}

function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

// The statement containing the cursor, or the one sharing its line when the
// cursor sits in whitespace/comments between statements (preceding one wins).
export function statementAt(text: string, cursor: number, ranges = splitStatements(text)): TextRange | null {
  const inside = ranges.find((r) => r.start <= cursor && cursor <= r.end)
  if (inside) return inside
  const prev = ranges.findLast((r) => r.end < cursor)
  if (prev && !text.slice(prev.end, cursor).includes("\n")) return prev
  const next = ranges.find((r) => r.start > cursor)
  if (next && !text.slice(cursor, next.start).includes("\n")) return next
  return null
}

export function runTarget(text: string, cursor: number): RunTarget | null {
  const range = statementAt(text, cursor)
  if (!range) return null
  return {
    ...range,
    text: text.slice(range.start, range.end),
    startLine: lineAt(text, range.start),
    endLine: lineAt(text, range.end - 1),
  }
}
