import { describe, expect, test } from "bun:test"
import {
  commandFooter,
  formatCell,
  formatElapsed,
  paginate,
  rowsFooter,
  rowToJson,
  truncateForDisplay,
  uniqueColumnNames,
} from "./format"

describe("truncateForDisplay", () => {
  test("short text passes through", () => {
    expect(truncateForDisplay("hello")).toBe("hello")
  })

  test("text at the cap is unchanged", () => {
    const exact = "a".repeat(40)
    expect(truncateForDisplay(exact)).toBe(exact)
  })

  test("text over the cap truncates with an ellipsis", () => {
    expect(truncateForDisplay("b".repeat(41))).toBe(`${"b".repeat(39)}…`)
    expect(truncateForDisplay("c".repeat(100))).toHaveLength(40)
  })

  test("custom max width", () => {
    expect(truncateForDisplay("abcdef", 4)).toBe("abc…")
  })
})

describe("formatCell", () => {
  test("null and undefined render as dim null marker", () => {
    expect(formatCell(null)).toEqual({ text: "∅", kind: "null" })
    expect(formatCell(undefined)).toEqual({ text: "∅", kind: "null" })
  })

  test("booleans render as true/false", () => {
    expect(formatCell(true)).toEqual({ text: "true", kind: "true" })
    expect(formatCell(false)).toEqual({ text: "false", kind: "false" })
  })

  test("numbers and bigints render as strings", () => {
    expect(formatCell(42)).toEqual({ text: "42", kind: "number" })
    expect(formatCell(9n)).toEqual({ text: "9", kind: "number" })
    expect(formatCell(1.5)).toEqual({ text: "1.5", kind: "number" })
  })

  test("dates render as ISO strings", () => {
    const date = new Date("2026-09-18T00:00:00.000Z")
    expect(formatCell(date)).toEqual({ text: "2026-09-18T00:00:00.000Z", kind: "text" })
  })

  test("strings pass through", () => {
    expect(formatCell("hello")).toEqual({ text: "hello", kind: "text" })
  })

  test("objects render as JSON", () => {
    expect(formatCell({ a: 1 })).toEqual({ text: '{"a":1}', kind: "text" })
    expect(formatCell([1, 2])).toEqual({ text: "[1,2]", kind: "text" })
  })

  test("line breaks render as backslash-n", () => {
    expect(formatCell("a\nb")).toEqual({ text: "a\\nb", kind: "text" })
    expect(formatCell("a\r\nb\rc")).toEqual({ text: "a\\nb\\nc", kind: "text" })
  })

  test("tabs render as two spaces", () => {
    expect(formatCell("a\tb")).toEqual({ text: "a  b", kind: "text" })
  })
})

describe("uniqueColumnNames", () => {
  test("deduplicates repeated column names", () => {
    expect(uniqueColumnNames(["id", "id"])).toEqual(["id", "id_2"])
    expect(uniqueColumnNames(["id", "id", "id"])).toEqual(["id", "id_2", "id_3"])
  })

  test("leaves distinct names untouched", () => {
    expect(uniqueColumnNames(["a", "b", "c"])).toEqual(["a", "b", "c"])
  })
})

describe("rowToJson", () => {
  test("maps columns to values", () => {
    expect(rowToJson(["id", "name"], [1, "a"])).toBe('{"id":1,"name":"a"}')
  })

  test("missing values become null", () => {
    expect(rowToJson(["id", "name"], [1])).toBe('{"id":1,"name":null}')
    expect(rowToJson(["a"], [undefined])).toBe('{"a":null}')
    expect(rowToJson(["a"], [null])).toBe('{"a":null}')
  })

  test("nested values serialize inline", () => {
    expect(rowToJson(["meta"], [{ x: [1, 2] }])).toBe('{"meta":{"x":[1,2]}}')
  })
})

describe("paginate", () => {
  test("empty result set yields a single empty page", () => {
    expect(paginate(0, 0)).toEqual({ start: 0, end: 0, pageIndex: 0, pageCount: 1 })
  })

  test("exact single page", () => {
    expect(paginate(50, 0)).toEqual({ start: 0, end: 50, pageIndex: 0, pageCount: 1 })
  })

  test("partial second page", () => {
    expect(paginate(51, 0)).toEqual({ start: 0, end: 50, pageIndex: 0, pageCount: 2 })
    expect(paginate(51, 1)).toEqual({ start: 50, end: 51, pageIndex: 1, pageCount: 2 })
  })

  test("clamps out-of-range page index", () => {
    expect(paginate(120, 99)).toEqual({ start: 100, end: 120, pageIndex: 2, pageCount: 3 })
    expect(paginate(120, -1)).toEqual({ start: 0, end: 50, pageIndex: 0, pageCount: 3 })
  })

  test("custom page size", () => {
    expect(paginate(10, 1, 7)).toEqual({ start: 7, end: 10, pageIndex: 1, pageCount: 2 })
  })
})

describe("formatElapsed", () => {
  test("milliseconds under one second", () => {
    expect(formatElapsed(3.21)).toBe("3.2ms")
    expect(formatElapsed(999.94)).toBe("999.9ms")
  })

  test("seconds at or above one second", () => {
    expect(formatElapsed(1234)).toBe("1.23s")
    expect(formatElapsed(60_000)).toBe("60.00s")
  })
})

describe("footers", () => {
  test("rows footer", () => {
    expect(rowsFooter(2, false, 0, 1, 3.21)).toBe("2 rows · page 1/1 · 3.2ms")
    expect(rowsFooter(1, false, 0, 1, 5)).toBe("1 row · page 1/1 · 5.0ms")
    expect(rowsFooter(6000, true, 2, 120, 1500)).toBe(
      "6000 rows · page 3/120 · 1.50s · capped at 5000",
    )
  })

  test("command footer", () => {
    expect(commandFooter("INSERT", 1, 1.04)).toBe("INSERT 1 · 1.0ms")
    expect(commandFooter("CREATE TABLE", null, 12.5)).toBe("CREATE TABLE · 12.5ms")
  })
})
