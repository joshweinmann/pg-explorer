import { describe, expect, test } from "bun:test"
import { DbError, DbService } from "./client"

describe("DbService", () => {
  test("execute before connect rejects with DbError", async () => {
    const db = new DbService()
    expect(db.connected).toBe(false)
    try {
      await db.execute("SELECT 1")
      throw new Error("expected execute to reject")
    } catch (err) {
      expect(err).toBeInstanceOf(DbError)
      expect((err as DbError).code).toBe("NO_CONNECTION")
    }
  })

  test("connection failure is normalized and leaves service disconnected", async () => {
    const db = new DbService({ connectTimeoutSeconds: 1 })
    await expect(
      db.connect({ host: "127.0.0.1", port: 1, user: "nobody", database: "none" }),
    ).rejects.toThrow()
    expect(db.connected).toBe(false)
  })
})
