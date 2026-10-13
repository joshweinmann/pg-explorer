import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { isMissingFile } from "../errors"

type Validate<T> = (value: unknown) => T | null

function parseFile<T>(json: string, validate: Validate<T>): Record<string, T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const result: Record<string, T> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const valid = validate(value)
    if (valid !== null) result[key] = valid
  }
  return result
}

// One JSON file holding a value per connection id. Unreadable or invalid
// content is treated as empty rather than blocking the app.
//
// Writes are a synchronous read-modify-write: the files are small, and doing it
// in one tick means writes from this process can never interleave or clobber
// each other. Concurrent app instances can still lose a race, but only for
// the key they both wrote.
export class KeyedStore<T> {
  constructor(
    private readonly path: string,
    private readonly validate: Validate<T>,
  ) {}

  async load(key: string): Promise<T | null> {
    try {
      return parseFile(await readFile(this.path, "utf8"), this.validate)[key] ?? null
    } catch (err) {
      if (isMissingFile(err)) return null
      throw err
    }
  }

  async update(key: string, change: (current: T | null) => T): Promise<T> {
    return this.updateSync(key, change)
  }

  updateSync(key: string, change: (current: T | null) => T): T {
    let all: Record<string, T> = {}
    try {
      all = parseFile(readFileSync(this.path, "utf8"), this.validate)
    } catch (err) {
      if (!isMissingFile(err)) throw err
    }
    const next = change(all[key] ?? null)
    all[key] = next
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(all), "utf8")
    renameSync(tmp, this.path)
    return next
  }
}
