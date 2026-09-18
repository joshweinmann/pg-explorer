import { BoxRenderable, CliRenderEvents, type CliRenderer, type Renderable } from "@opentui/core"
import { Header } from "./ui/header"
import { Sidebar } from "./ui/sidebar"
import { Editor } from "./ui/editor"
import { Results } from "./ui/results"
import { ConnectionDialog } from "./ui/dialog"
import { HelpDialog } from "./ui/help-dialog"
import { initialAppState, type AppState, type FocusPanel } from "./state"
import { DbService, DbError, type DbConnection } from "./db/client"
import {
  defaultConfigPath,
  defaultFormValues,
  normalizeConnection,
  saveConfig,
  toFormValues,
  type ConnectionFormValues,
  type StoredConfig,
} from "./config/config"
import { theme } from "./theme"

export class App {
  private readonly renderer: CliRenderer
  readonly state: AppState
  readonly header: Header
  readonly sidebar: Sidebar
  readonly editor: Editor
  readonly results: Results
  readonly dialog: ConnectionDialog
  readonly helpDialog: HelpDialog
  readonly db: DbConnection
  private readonly configPath: string
  private running = false

  constructor(
    renderer: CliRenderer,
    db: DbConnection = new DbService(),
    configPath: string = defaultConfigPath(),
  ) {
    this.renderer = renderer
    this.state = initialAppState()
    this.db = db
    this.configPath = configPath
    this.header = new Header(renderer)
    this.sidebar = new Sidebar(renderer)
    this.editor = new Editor(renderer, () => this.executeQuery())
    this.results = new Results(renderer, (json) => this.copyRowToClipboard(json))
    this.dialog = new ConnectionDialog(renderer, {
      onSubmit: (values) => void this.submitConnection(values),
      onCancel: () => this.focusPanel("editor"),
    })
    this.helpDialog = new HelpDialog(renderer)
    this.buildLayout()
    this.renderer.root.add(this.dialog.root)
    this.renderer.root.add(this.helpDialog.root)
    this.setupKeybinds()
    this.setupFocusSync()
    this.focusPanel("editor")
  }

  private anyDialogOpen(): boolean {
    return this.dialog.isOpen || this.helpDialog.isOpen
  }

  private setupFocusSync(): void {
    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (renderable: Renderable | null) => {
      if (!renderable || this.dialog.isOpen) return
      const panel = this.panelFor(renderable)
      if (panel) this.state.focus = panel
    })
  }

  private panelFor(renderable: Renderable): FocusPanel | null {
    let current: Renderable | null = renderable
    while (current) {
      if (current === this.sidebar.root) return "sidebar"
      if (current === this.editor.root) return "editor"
      if (current === this.results.root) return "results"
      current = current.parent
    }
    return null
  }

  private buildLayout(): void {
    const body = new BoxRenderable(this.renderer, {
      id: "body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
    })

    body.add(this.sidebar.root)

    const main = new BoxRenderable(this.renderer, {
      id: "main",
      flexGrow: 1,
      flexDirection: "column",
    })
    main.add(this.editor.root)
    main.add(this.results.root)
    body.add(main)

    this.renderer.root.add(this.header.root)
    this.renderer.root.add(body)
  }

  private setupKeybinds(): void {
    this.renderer.keyInput.on("keypress", (key) => {
      if (this.dialog.isOpen && key.name === "escape") {
        key.preventDefault()
        this.dialog.close()
        this.focusPanel("editor")
        return
      }
      if (
        this.dialog.isOpen &&
        !key.ctrl &&
        !key.meta &&
        (key.name === "up" || key.name === "down")
      ) {
        key.preventDefault()
        this.dialog.moveFocus(key.name === "up" ? -1 : 1)
        return
      }
      if (this.helpDialog.isOpen && (key.name === "escape" || (key.ctrl && key.name === "h"))) {
        key.preventDefault()
        this.helpDialog.close()
        return
      }
      if (key.ctrl) {
        switch (key.name) {
          case "q":
            key.preventDefault()
            this.quit()
            break
          case "h":
            if (this.dialog.isOpen) break
            key.preventDefault()
            this.helpDialog.open()
            break
          case "b":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.toggleSidebar()
            break
          case "o":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.openConnectionDialog()
            break
          case "1":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.focusPanel("sidebar")
            break
          case "2":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.focusPanel("editor")
            break
          case "3":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.focusPanel("results")
            break
        }
        return
      }
      if (this.anyDialogOpen()) return
      if (key.name === "tab" && !key.meta) {
        key.preventDefault()
        this.cycleFocus(key.shift ? -1 : 1)
        return
      }
      if (this.state.focus === "results") {
        switch (key.name) {
          case "up":
          case "k":
            key.preventDefault()
            this.results.moveSelection(-1)
            break
          case "down":
          case "j":
            key.preventDefault()
            this.results.moveSelection(1)
            break
          case "home":
            key.preventDefault()
            this.results.goToSelectionEdge(true)
            break
          case "end":
            key.preventDefault()
            this.results.goToSelectionEdge(false)
            break
          case "pagedown":
          case "n":
            key.preventDefault()
            this.results.nextPage()
            break
          case "pageup":
          case "p":
            key.preventDefault()
            this.results.prevPage()
            break
          case "c":
            key.preventDefault()
            this.copySelectedRow()
            break
        }
        return
      }
      if (this.state.focus === "sidebar") {
        switch (key.name) {
          case "up":
            key.preventDefault()
            this.sidebar.moveUp()
            break
          case "down":
            key.preventDefault()
            this.sidebar.moveDown()
            break
          case "return":
          case "space":
            key.preventDefault()
            void this.sidebar.toggleCurrent()
            break
          case "r":
            key.preventDefault()
            if (this.db.connected) void this.sidebar.load(this.db)
            break
        }
      }
    })
  }

  focusPanel(panel: FocusPanel): void {
    if (panel === "sidebar" && !this.state.sidebarVisible) {
      this.state.sidebarVisible = true
      this.sidebar.root.visible = true
    }
    this.state.focus = panel
    if (panel === "sidebar") this.sidebar.focus()
    else if (panel === "editor") this.editor.focus()
    else this.results.focus()
  }

  cycleFocus(direction: 1 | -1): void {
    const order: FocusPanel[] = this.state.sidebarVisible
      ? ["sidebar", "editor", "results"]
      : ["editor", "results"]
    const current = order.indexOf(this.state.focus)
    const next = order[(current + direction + order.length) % order.length] ?? "editor"
    this.focusPanel(next)
  }

  copySelectedRow(): void {
    const json = this.results.selectedRowJson()
    if (!json) return
    this.copyRowToClipboard(json)
  }

  private copyRowToClipboard(json: string): void {
    this.renderer.copyToClipboardOSC52(json)
    this.results.showCopied()
  }

  toggleSidebar(): void {
    this.state.sidebarVisible = !this.state.sidebarVisible
    this.sidebar.root.visible = this.state.sidebarVisible
    if (!this.state.sidebarVisible && this.state.focus === "sidebar") {
      this.focusPanel("editor")
    }
  }

  async executeQuery(): Promise<void> {
    const query = this.editor.query.trim()
    if (!query || this.running) return
    if (!this.db.connected) {
      this.results.showError("not connected to a database")
      return
    }
    this.running = true
    this.results.setRunning()
    try {
      const result = await this.db.execute(query)
      if (result.kind === "rows") this.results.showRows(result)
      else this.results.showCommand(result)
    } catch (err) {
      if (err instanceof DbError || err instanceof Error) {
        this.results.showError(err.message)
      } else {
        this.results.showError(String(err))
      }
    } finally {
      this.running = false
    }
  }

  async tryConnect(config: StoredConfig): Promise<void> {
    this.header.setConnection("connecting", `${config.user}@${config.host}…`)
    try {
      await this.db.connect(config)
      this.state.connection = "connected"
      this.header.setConnection(
        "connected",
        `${config.user}@${config.host}:${config.port}/${config.database}`,
      )
      void this.sidebar.load(this.db)
    } catch (err) {
      this.state.connection = "error"
      this.header.setConnection("error")
      this.sidebar.reset()
      const message = err instanceof Error ? err.message : String(err)
      this.results.showMessage(`connection failed: ${message}`, theme.error)
    }
  }

  startup(config: StoredConfig | null): void {
    if (!config) return
    if (config.password) void this.tryConnect(config)
    else this.openConnectionDialog(config)
  }

  openConnectionDialog(prefill?: StoredConfig): void {
    const values = prefill ? toFormValues(prefill) : defaultFormValues()
    this.dialog.open(values, prefill !== undefined)
  }

  async submitConnection(values: ConnectionFormValues): Promise<void> {
    const normalized = normalizeConnection(values)
    if ("error" in normalized) {
      this.dialog.showError(normalized.error)
      return
    }
    const config = normalized.config
    this.dialog.showConnecting()
    this.header.setConnection("connecting", `${config.user}@${config.host}…`)
    try {
      await this.db.connect(config)
      this.state.connection = "connected"
      this.header.setConnection(
        "connected",
        `${config.user}@${config.host}:${config.port}/${config.database}`,
      )
      this.dialog.close()
      this.focusPanel("editor")
      void this.sidebar.load(this.db)
      try {
        await saveConfig(config, this.configPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.results.showMessage(`connected, but failed to save config: ${message}`, theme.warning)
      }
    } catch (err) {
      this.state.connection = "error"
      this.header.setConnection("error")
      const message = err instanceof Error ? err.message : String(err)
      this.dialog.showError(message)
    }
  }

  showConfigError(message: string): void {
    this.header.setConnection("error")
    this.results.showMessage(`config error: ${message}`, theme.error)
  }

  quit(): void {
    void this.db.disconnect()
    this.editor.destroy()
    this.renderer.destroy()
  }
}
