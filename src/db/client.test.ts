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

  test("a password reference is resolved before connecting", async () => {
    const refs: string[] = []
    const db = new DbService({
      connectTimeoutSeconds: 1,
      readSecret: async (ref) => {
        refs.push(ref)
        return "pw"
      },
    })
    const config = { host: "127.0.0.1", port: 1, user: "nobody", database: "none" }
    await expect(db.connect({ ...config, passwordRef: "op://V/I/p" })).rejects.toThrow()
    await expect(db.connect({ ...config, password: "direct", passwordRef: "op://V/I/p" })).rejects.toThrow()
    expect(refs).toEqual(["op://V/I/p"])
  })

  test("a failed secret read rejects and leaves service disconnected", async () => {
    const db = new DbService({
      readSecret: async () => {
        throw new DbError("1Password: item not found", "SECRET_READ")
      },
    })
    await expect(
      db.connect({ host: "127.0.0.1", port: 1, user: "u", database: "d", passwordRef: "op://V/I/p" }),
    ).rejects.toThrow("1Password: item not found")
    expect(db.connected).toBe(false)
  })

  test("connection failure is normalized and leaves service disconnected", async () => {
    const db = new DbService({ connectTimeoutSeconds: 1 })
    await expect(
      db.connect({ host: "127.0.0.1", port: 1, user: "nobody", database: "none" }),
    ).rejects.toThrow()
    expect(db.connected).toBe(false)
  })
})
