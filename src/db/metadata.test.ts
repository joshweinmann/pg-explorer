import { describe, expect, test } from "bun:test"
import { indexSummary, mergeColumns, rowsToSchemas, triggerSummary } from "./metadata"

describe("rowsToSchemas", () => {
  test("groups tables by schema and sorts both levels", () => {
    const schemas = rowsToSchemas([
      { table_schema: "zeta", table_name: "b_table", table_type: "BASE TABLE" },
      { table_schema: "alpha", table_name: "z_table", table_type: "BASE TABLE" },
      { table_schema: "alpha", table_name: "a_table", table_type: "BASE TABLE" },
    ])
    expect(schemas.map((s) => s.name)).toEqual(["alpha", "zeta"])
    expect(schemas[0]?.tables.map((t) => t.name)).toEqual(["a_table", "z_table"])
    expect(schemas[0]?.tables[0]?.kind).toBe("table")
    expect(schemas[0]?.tables[0]?.columns).toBeNull()
  })

  test("maps views", () => {
    const schemas = rowsToSchemas([
      { table_schema: "public", table_name: "v_users", table_type: "VIEW" },
    ])
    expect(schemas[0]?.tables[0]).toEqual({ name: "v_users", kind: "view", columns: null })
  })

  test("empty input yields empty list", () => {
    expect(rowsToSchemas([])).toEqual([])
  })
})

describe("mergeColumns", () => {
  const columns = [
    { column_name: "id", data_type: "integer", is_nullable: "NO" },
    { column_name: "email", data_type: "text", is_nullable: "YES" },
    { column_name: "org_id", data_type: "bigint", is_nullable: "NO" },
  ]

  test("attaches PK and FK flags", () => {
    const merged = mergeColumns(columns, [
      { column_name: "id", constraint_type: "PRIMARY KEY" },
      { column_name: "org_id", constraint_type: "FOREIGN KEY" },
    ])
    expect(merged).toEqual([
      { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
      { name: "email", dataType: "text", nullable: true, isPrimaryKey: false, isForeignKey: false },
      { name: "org_id", dataType: "bigint", nullable: false, isPrimaryKey: false, isForeignKey: true },
    ])
  })

  test("composite primary keys mark all member columns", () => {
    const merged = mergeColumns(columns, [
      { column_name: "id", constraint_type: "PRIMARY KEY" },
      { column_name: "email", constraint_type: "PRIMARY KEY" },
    ])
    expect(merged[0]?.isPrimaryKey).toBe(true)
    expect(merged[1]?.isPrimaryKey).toBe(true)
  })

  test("no constraints leaves plain columns", () => {
    const merged = mergeColumns(columns, [])
    expect(merged.every((c) => !c.isPrimaryKey && !c.isForeignKey)).toBe(true)
  })
})

describe("indexSummary", () => {
  test("keeps the method, columns, and predicate", () => {
    expect(indexSummary("CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)")).toBe("btree (id)")
    expect(
      indexSummary("CREATE INDEX live ON public.users USING btree (email) WHERE (deleted_at IS NULL)"),
    ).toBe("btree (email) WHERE (deleted_at IS NULL)")
  })
})

describe("triggerSummary", () => {
  test("keeps timing, events, and function", () => {
    expect(
      triggerSummary(
        "CREATE TRIGGER audit BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION audit_fn()",
      ),
    ).toBe("BEFORE INSERT OR UPDATE audit_fn()")
  })

  test("falls back to the full definition", () => {
    expect(triggerSummary("something else")).toBe("something else")
  })
})
