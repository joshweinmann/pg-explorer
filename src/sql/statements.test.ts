import { describe, expect, test } from "bun:test"
import { runTarget, splitStatements, statementAt } from "./statements"

function texts(sql: string): string[] {
  return splitStatements(sql).map((r) => sql.slice(r.start, r.end))
}

describe("splitStatements", () => {
  test("splits on semicolons and trims whitespace", () => {
    expect(texts("SELECT 1;\n  SELECT 2 ;\nSELECT 3")).toEqual([
      "SELECT 1;",
      "SELECT 2 ;",
      "SELECT 3",
    ])
  })

  test("ignores semicolons inside strings, identifiers, and comments", () => {
    const sql = `SELECT ';', "a;b", 'it''s;' -- x; y\nFROM t /* ; /* nested; */ ; */;\nSELECT 2;`
    expect(texts(sql)).toEqual([
      `SELECT ';', "a;b", 'it''s;' -- x; y\nFROM t /* ; /* nested; */ ; */;`,
      "SELECT 2;",
    ])
  })

  test("handles E-strings with backslash escapes", () => {
    expect(texts("SELECT E'a\\';b'; SELECT 2")).toEqual(["SELECT E'a\\';b';", "SELECT 2"])
  })

  test("handles dollar-quoted bodies", () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END $body$ LANGUAGE plpgsql;"
    expect(texts(`${fn}\nSELECT $$a;b$$;`)).toEqual([fn, "SELECT $$a;b$$;"])
  })

  test("positional parameters are not dollar quotes", () => {
    expect(texts("SELECT $1; SELECT $2")).toEqual(["SELECT $1;", "SELECT $2"])
  })

  test("excludes leading and trailing comments, drops comment-only segments", () => {
    expect(texts("-- header\nSELECT 1; -- trailing\n/* done */")).toEqual(["SELECT 1;"])
  })

  test("empty and whitespace-only input yields nothing", () => {
    expect(splitStatements("")).toEqual([])
    expect(splitStatements("  \n ;; ")).toEqual([
      { start: 4, end: 5 },
      { start: 5, end: 6 },
    ])
  })
})

describe("statementAt", () => {
  const sql = "SELECT 1;\nSELECT 2;\n\nSELECT 3"

  test("finds the statement containing the cursor", () => {
    expect(statementAt(sql, 3)).toEqual({ start: 0, end: 9 })
    expect(statementAt(sql, 12)).toEqual({ start: 10, end: 19 })
    expect(statementAt(sql, sql.length)).toEqual({ start: 21, end: 29 })
  })

  test("cursor right after the semicolon picks that statement", () => {
    expect(statementAt(sql, 9)).toEqual({ start: 0, end: 9 })
  })

  test("cursor on a blank line between statements picks nothing", () => {
    expect(statementAt(sql, 20)).toBeNull()
  })

  test("cursor in leading whitespace on a statement's line picks it", () => {
    expect(statementAt("SELECT 1;\n   SELECT 2", 11)).toEqual({ start: 13, end: 21 })
  })
})

describe("runTarget", () => {
  const sql = "SELECT 1;\nSELECT 2\n  FROM t;\nSELECT 3;"

  test("statement under cursor with its line span", () => {
    expect(runTarget(sql, 12)).toMatchObject({
      text: "SELECT 2\n  FROM t;",
      startLine: 1,
      endLine: 2,
    })
  })

  test("single-line statement spans one line", () => {
    expect(runTarget(sql, 3)).toMatchObject({ text: "SELECT 1;", startLine: 0, endLine: 0 })
  })

  test("blank cursor line runs nothing", () => {
    expect(runTarget("SELECT 1;\n\n", 11)).toBeNull()
  })
})
