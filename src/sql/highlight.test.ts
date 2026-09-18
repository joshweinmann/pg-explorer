import { describe, expect, test } from "bun:test"
import { tokenizeLine } from "./highlight"

function kinds(tokens: ReturnType<typeof tokenizeLine>) {
  return tokens.map((token) => token.kind)
}

describe("tokenizeLine", () => {
  test("highlights keywords case-insensitively", () => {
    expect(tokenizeLine("SELECT * FROM users")).toEqual([
      { start: 0, end: 6, kind: "keyword" },
      { start: 9, end: 13, kind: "keyword" },
    ])
    expect(tokenizeLine("select from")).toEqual([
      { start: 0, end: 6, kind: "keyword" },
      { start: 7, end: 11, kind: "keyword" },
    ])
  })

  test("does not match keywords inside longer words", () => {
    expect(tokenizeLine("SELECTED selects")).toEqual([])
    expect(tokenizeLine("my_selection")).toEqual([])
  })

  test("tokenizes strings with escaped quotes", () => {
    expect(tokenizeLine("'it''s'")).toEqual([{ start: 0, end: 7, kind: "string" }])
    expect(tokenizeLine("WHERE name = 'a''b'")).toEqual([
      { start: 0, end: 5, kind: "keyword" },
      { start: 13, end: 19, kind: "string" },
    ])
  })

  test("unterminated strings highlight to end of line", () => {
    expect(tokenizeLine("'abc")).toEqual([{ start: 0, end: 4, kind: "string" }])
  })

  test("comments run to end of line", () => {
    expect(tokenizeLine("SELECT 1 -- a note")).toEqual([
      { start: 0, end: 6, kind: "keyword" },
      { start: 7, end: 8, kind: "number" },
      { start: 9, end: 18, kind: "comment" },
    ])
  })

  test("double dashes inside strings are not comments", () => {
    expect(tokenizeLine("'a--b'")).toEqual([{ start: 0, end: 6, kind: "string" }])
  })

  test("tokenizes numbers but not digits inside words", () => {
    expect(tokenizeLine("WHERE id = 42")).toEqual([
      { start: 0, end: 5, kind: "keyword" },
      { start: 11, end: 13, kind: "number" },
    ])
    expect(tokenizeLine("LIMIT 3.14")).toEqual([
      { start: 0, end: 5, kind: "keyword" },
      { start: 6, end: 10, kind: "number" },
    ])
    expect(tokenizeLine("col1")).toEqual([])
  })

  test("quoted identifiers produce no tokens", () => {
    expect(tokenizeLine('"user table"')).toEqual([])
  })

  test("empty and plain lines produce no tokens", () => {
    expect(tokenizeLine("")).toEqual([])
    expect(tokenizeLine("    ")).toEqual([])
    expect(tokenizeLine("plain_identifier = plain")).toEqual([])
  })

  test("mixed statement", () => {
    expect(tokenizeLine("INSERT INTO t VALUES (1, 'x') -- done")).toEqual([
      { start: 0, end: 6, kind: "keyword" },
      { start: 7, end: 11, kind: "keyword" },
      { start: 14, end: 20, kind: "keyword" },
      { start: 22, end: 23, kind: "number" },
      { start: 25, end: 28, kind: "string" },
      { start: 30, end: 37, kind: "comment" },
    ])
  })
})
