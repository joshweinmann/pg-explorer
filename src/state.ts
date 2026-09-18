export type FocusPanel = "sidebar" | "editor" | "results"

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error"

export interface AppState {
  focus: FocusPanel
  sidebarVisible: boolean
  connection: ConnectionState
}

export function initialAppState(): AppState {
  return {
    focus: "editor",
    sidebarVisible: true,
    connection: "disconnected",
  }
}
