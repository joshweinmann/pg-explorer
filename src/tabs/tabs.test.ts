import { describe, expect, test } from "bun:test"
import { tabAt, tabBarLayout, validateSession } from "./tabs"

describe("validateSession", () => {
  test("keeps valid tabs and clamps active", () => {
    expect(
      validateSession({ active: 5, tabs: [{ name: "a", query: "x" }, { name: 1 }, { name: "b", query: "" }] }),
    ).toEqual({ active: 1, tabs: [{ name: "a", query: "x" }, { name: "b", query: "" }] })
  })

  test("rejects non-objects and empty tab lists", () => {
    expect(validateSession(null)).toBeNull()
    expect(validateSession({ active: 0, tabs: [] })).toBeNull()
    expect(validateSession({ tabs: "x" })).toBeNull()
  })

  test("non-integer active falls back to the first tab", () => {
    expect(validateSession({ active: "2", tabs: [{ name: "a", query: "" }] })?.active).toBe(0)
  })
})

describe("tabBarLayout", () => {
  const names = ["users", "orders", "Query 3"]

  test("everything fits", () => {
    const layout = tabBarLayout(names, 0, 80)
    expect(layout.items.map((i) => i.text)).toEqual([" 1 users ", " 2 orders ", " 3 Query 3 "])
    expect(layout.items.map((i) => i.x)).toEqual([0, 10, 21])
    expect(layout.moreLeft).toBe(false)
    expect(layout.moreRight).toBe(false)
  })

  test("long names are truncated", () => {
    const [item] = tabBarLayout(["x".repeat(40)], 0, 80).items
    expect(item!.text).toBe(` 1 ${"x".repeat(23)}… `)
  })

  test("overflow slides the window to keep the active tab visible", () => {
    const many = Array.from({ length: 10 }, (_, i) => `tab${i}`)
    const layout = tabBarLayout(many, 9, 30)
    expect(layout.items.at(-1)!.index).toBe(9)
    expect(layout.moreLeft).toBe(true)
    expect(layout.moreRight).toBe(false)
    const last = layout.items.at(-1)!
    expect(last.x + last.text.length).toBeLessThanOrEqual(30)
  })

  test("overflow on the right is flagged", () => {
    const many = Array.from({ length: 10 }, (_, i) => `tab${i}`)
    const layout = tabBarLayout(many, 0, 30)
    expect(layout.items[0]!.index).toBe(0)
    expect(layout.moreRight).toBe(true)
    const last = layout.items.at(-1)!
    expect(last.x + last.text.length).toBeLessThanOrEqual(29)
  })

  test("tabAt maps x to a tab, separators to null", () => {
    const layout = tabBarLayout(names, 0, 80)
    expect(tabAt(layout, 0)).toBe(0)
    expect(tabAt(layout, 9)).toBeNull()
    expect(tabAt(layout, 12)).toBe(1)
    expect(tabAt(layout, 79)).toBeNull()
  })
})
