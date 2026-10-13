import { describe, expect, test } from "bun:test"
import { compareDecimalStrings, nextSort, orderByQuery, requeryableQuery, sortRows } from "./sort"

describe("nextSort", () => {
  test("cycles asc → desc → off on the same column", () => {
    const asc = nextSort(null, 1)
    expect(asc).toEqual({ column: 1, dir: "asc" })
    const desc = nextSort(asc, 1)
    expect(desc).toEqual({ column: 1, dir: "desc" })
    expect(nextSort(desc, 1)).toBeNull()
  })

  test("a different column starts ascending", () => {
    expect(nextSort({ column: 0, dir: "desc" }, 2)).toEqual({ column: 2, dir: "asc" })
  })
})

describe("sortRows", () => {
  const col = (rows: unknown[][]) => rows.map((r) => r[0])

  test("numeric strings sort numerically", () => {
    const rows = [["10"], ["9"], ["-1.5"], ["100"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual(["-1.5", "9", "10", "100"])
  })

  test("mixed text column sorts as text", () => {
    const rows = [["b"], ["10"], ["a"], ["9"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual(["10", "9", "a", "b"])
  })

  test("numbers, bigints, dates, and booleans", () => {
    expect(col(sortRows([[3], [1], [2]], { column: 0, dir: "desc" }))).toEqual([3, 2, 1])
    expect(col(sortRows([[3n], [10n]], { column: 0, dir: "asc" }))).toEqual([3n, 10n])
    const d1 = new Date("2024-01-01")
    const d2 = new Date("2023-01-01")
    expect(col(sortRows([[d1], [d2]], { column: 0, dir: "asc" }))).toEqual([d2, d1])
    expect(col(sortRows([[true], [false]], { column: 0, dir: "asc" }))).toEqual([false, true])
  })

  test("nulls last ascending, first descending", () => {
    const rows = [[null], ["b"], [undefined], ["a"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual(["a", "b", null, undefined])
    expect(col(sortRows(rows, { column: 0, dir: "desc" }))).toEqual([null, undefined, "b", "a"])
  })

  test("is stable and does not mutate input", () => {
    const rows = [["x", 1], ["y", 2], ["x", 3]]
    const sorted = sortRows(rows, { column: 0, dir: "asc" })
    expect(sorted.map((r) => r[1])).toEqual([1, 3, 2])
    expect(rows.map((r) => r[1])).toEqual([1, 2, 3])
  })
})

describe("requeryableQuery", () => {
  test("strips the semicolon and surrounding comments of a single SELECT", () => {
    expect(requeryableQuery("-- lead\nSELECT a FROM t; -- note")).toBe("SELECT a FROM t")
    expect(requeryableQuery("with x as (select 1) select * from x")).toBe("with x as (select 1) select * from x")
    expect(requeryableQuery("VALUES (1), (2)")).toBe("VALUES (1), (2)")
  })

  test("rejects statements that write or have side effects", () => {
    expect(requeryableQuery("INSERT INTO t SELECT 1 RETURNING *")).toBeNull()
    expect(requeryableQuery("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBeNull()
    expect(requeryableQuery("SELECT * INTO copy FROM t")).toBeNull()
    expect(requeryableQuery("SELECT nextval('s') FROM generate_series(1, 10)")).toBeNull()
    expect(requeryableQuery("SELECT * FROM t FOR UPDATE")).toBeNull()
  })

  test("rejects multiple statements and non-queries", () => {
    expect(requeryableQuery("SELECT 1; SELECT 2")).toBeNull()
    expect(requeryableQuery("EXPLAIN SELECT 1")).toBeNull()
    expect(requeryableQuery("")).toBeNull()
  })

  test("write keywords inside strings or comments do not block", () => {
    expect(requeryableQuery("SELECT 'delete' AS op -- don't update\nFROM t")).toBe(
      "SELECT 'delete' AS op -- don't update\nFROM t",
    )
  })

  test("a quote inside a comment does not hide later code", () => {
    expect(requeryableQuery("SELECT 1 -- it's\n, (SELECT 'x') FROM t WHERE a IN (SELECT nextval('s'))")).toBeNull()
  })
})

describe("orderByQuery", () => {
  test("wraps the statement and orders by column ordinal", () => {
    expect(orderByQuery("SELECT a, b FROM t", { column: 1, dir: "desc" })).toBe(
      "SELECT * FROM (\nSELECT a, b FROM t\n) AS sorted ORDER BY 2 DESC",
    )
  })

  test("trailing line comment cannot swallow the closing paren", () => {
    expect(orderByQuery("SELECT 1 -- note", { column: 0, dir: "asc" })).toBe(
      "SELECT * FROM (\nSELECT 1 -- note\n) AS sorted ORDER BY 1 ASC",
    )
  })
})

describe("numeric precision and special values", () => {
  const col = (rows: unknown[][]) => rows.map((r) => r[0])

  test("int8 strings beyond 2^53 sort exactly", () => {
    const rows = [["9007199254740993"], ["9007199254740992"], ["-9007199254740993"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual([
      "-9007199254740993",
      "9007199254740992",
      "9007199254740993",
    ])
  })

  test("long numeric strings compare digit by digit", () => {
    const rows = [["12345678901234567890.0000000002"], ["12345678901234567890.0000000001"], ["-0.5"], ["0"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual([
      "-0.5",
      "0",
      "12345678901234567890.0000000001",
      "12345678901234567890.0000000002",
    ])
  })

  test("NaN and Infinity keep the column numeric, in Postgres order", () => {
    const rows = [["NaN"], ["10"], ["Infinity"], ["9"], ["-Infinity"]]
    expect(col(sortRows(rows, { column: 0, dir: "asc" }))).toEqual(["-Infinity", "9", "10", "Infinity", "NaN"])
    const floats = [[Number.NaN], [1], [Infinity], [-Infinity]]
    expect(col(sortRows(floats, { column: 0, dir: "asc" }))).toEqual([-Infinity, 1, Infinity, Number.NaN])
  })

  test("compareDecimalStrings handles signs, zeros, and padding", () => {
    expect(compareDecimalStrings("-0", "0")).toBe(0)
    expect(compareDecimalStrings("1.50", "1.5")).toBe(0)
    expect(compareDecimalStrings("-2", "-10")).toBe(1)
    expect(compareDecimalStrings("007", "7")).toBe(0)
    expect(compareDecimalStrings(".5", "0.49")).toBe(1)
  })
})
