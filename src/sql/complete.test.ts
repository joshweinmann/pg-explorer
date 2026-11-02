import { describe, expect, test } from "bun:test"
import { complete, statementTables } from "./complete"
import type { SchemaInfo } from "../db/metadata"

function schemas(): SchemaInfo[] {
  return [
    {
      name: "public",
      tables: [
        {
          name: "users",
          kind: "table",
          columns: [
            { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
            { name: "email", dataType: "text", nullable: false, isPrimaryKey: false, isForeignKey: false },
          ],
        },
        { name: "UserTags", kind: "table", columns: null },
      ],
    },
    { name: "archive", tables: [{ name: "user_log", kind: "view", columns: null }] },
  ]
}

function labels(text: string, manual = false): string[] | undefined {
  return complete(text, text.length, schemas(), manual)?.items.map((i) => i.label)
}

describe("complete", () => {
  test("suggests tables after FROM, qualifying non-public schemas and quoting mixed case", () => {
    expect(labels("select * from us")).toEqual(['"UserTags"', "archive.user_log", "users"])
  })

  test("returns the replaced range", () => {
    expect(complete("select * from us", 16, schemas())).toMatchObject({ start: 14, end: 16 })
  })

  test("suggests keywords matching the typed case", () => {
    expect(labels("sel")).toEqual(["select"])
    expect(labels("SEL")).toEqual(["SELECT"])
  })

  test("suggests columns of referenced tables first", () => {
    const text = "select em from users"
    expect(complete(text, 9, schemas())?.items[0]).toEqual({ label: "email", insert: "email", kind: "column" })
  })

  test("resolves aliases after a dot", () => {
    const text = "select u. from users u"
    expect(complete(text, 9, schemas())?.items.map((i) => i.label)).toEqual(["email", "id"])
  })

  test("suggests a schema's tables after schema.", () => {
    expect(labels("select * from archive.")).toEqual(["user_log"])
  })

  test("needs a prefix unless triggered manually", () => {
    expect(labels("select * from ")).toBeUndefined()
    expect(labels("select * from ", true)).toHaveLength(3)
  })

  test("skips strings, comments, numbers and exact matches", () => {
    expect(labels("select 'sel")).toBeUndefined()
    expect(labels("-- sel")).toBeUndefined()
    expect(labels("select 12")).toBeUndefined()
    expect(labels("select * from users")).toBeUndefined()
  })
})

describe("statementTables", () => {
  test("finds tables and aliases in the cursor's statement only", () => {
    const text = "select 1 from archive.user_log;\nselect * from users as u join \"UserTags\" t on true"
    const refs = statementTables(text, text.length, schemas())
    expect(refs.map((r) => [r.schema, r.table.name, r.alias])).toEqual([
      ["public", "users", "u"],
      ["public", "UserTags", "t"],
    ])
  })

  test("ignores keywords in the alias position", () => {
    const refs = statementTables("select * from users where id = 1", 5, schemas())
    expect(refs.map((r) => r.alias)).toEqual([null])
  })
})
