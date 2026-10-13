import { join } from "node:path"
import { homedir } from "node:os"

export interface AppPaths {
  config: string
  history: string
  favorites: string
  tabs: string
}

// Every file the app writes lives under one directory, so tests can redirect all of them at once.
export function appPathsIn(dir: string): AppPaths {
  return {
    config: join(dir, "config"),
    history: join(dir, "history.json"),
    favorites: join(dir, "favorites.json"),
    tabs: join(dir, "tabs.json"),
  }
}

export function defaultAppPaths(): AppPaths {
  return appPathsIn(join(homedir(), ".config", "pg-explorer"))
}
