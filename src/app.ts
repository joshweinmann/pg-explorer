import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import { Header } from "./ui/header"
import { Sidebar } from "./ui/sidebar"
import type { Editor } from "./ui/editor"
import type { Results } from "./ui/results"
import { Tabs, type Tab } from "./ui/tabs"
import { PromptDialog } from "./ui/prompt-dialog"
import { ConnectionDialog } from "./ui/dialog"
import { HelpDialog } from "./ui/help-dialog"
import { QueryPickers } from "./ui/query-pickers"
import { ConnectionPicker, type ConnectionChoice } from "./ui/connection-picker"
import { CompletionPopup } from "./ui/completion-popup"
import { complete, statementTables } from "./sql/complete"
import { initialAppState, type AppState, type FocusPanel } from "./state"
import { DbService, DbError, type DbConnection } from "./db/client"
import {
  connectionId,
  defaultFormValues,
  normalizeConnection,
  removeConnection,
  saveConfig,
  toFormValues,
  upsertConnection,
  type AppConfig,
  type ConnectionFormValues,
  type StoredConfig,
} from "./config/config"
import { orderByQuery, requeryableQuery, type SortState } from "./results/sort"
import { KeyedStore } from "./config/keyed-store"
import { DEFAULT_TAB_NAME, validateSession, type TabSession } from "./tabs/tabs"
import { defaultAppPaths, type AppPaths } from "./config/paths"
import { theme } from "./theme"
import { errorMessage } from "./errors"

export class App {
  private readonly renderer: CliRenderer
  readonly state: AppState
  readonly header: Header
  readonly sidebar: Sidebar
  readonly tabs: Tabs
  readonly dialog: ConnectionDialog
  readonly helpDialog: HelpDialog
  readonly promptDialog: PromptDialog
  readonly pickers: QueryPickers
  readonly connectionPicker: ConnectionPicker
  readonly completion: CompletionPopup
  private completionManual = false
  private applyingCompletion = false
  readonly db: DbConnection
  private readonly configPath: string
  private readonly tabStore: KeyedStore<TabSession>
  private tabSaveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingCloseTabId: number | null = null
  private currentRun: Promise<void> | null = null
  private runId = 0
  private quitting = false
  private connections: StoredConfig[] = []
  private activeId: string | null = null
  private lastConnectedId: string | null = null
  private editingId: string | undefined
  private lastConnectError = ""
  private configLoadError: string | null = null

  constructor(
    renderer: CliRenderer,
    db: DbConnection = new DbService(),
    paths: AppPaths = defaultAppPaths(),
  ) {
    this.renderer = renderer
    this.state = initialAppState()
    this.db = db
    this.configPath = paths.config
    this.header = new Header(renderer)
    this.sidebar = new Sidebar(renderer)
    this.completion = new CompletionPopup(renderer)
    this.tabStore = new KeyedStore(paths.tabs, validateSession)
    this.tabs = new Tabs(renderer, {
      onSubmit: (tab) => {
        this.closeCompletion()
        void this.executeQuery(tab)
      },
      onCopy: (tab, json) => this.copyRowToClipboard(tab, json),
      onSortRequery: (tab, sort) => this.requestSortRequery(tab, sort),
      onChange: () => this.scheduleTabSave(),
      onEdit: (tab, grew) => {
        if (grew || this.completion.isOpen) this.updateCompletion(tab)
      },
      onCursorMove: (tab) => {
        if (this.completion.isOpen) this.updateCompletion(tab)
      },
      onActivate: () => {
        this.closeCompletion()
        if (!this.anyDialogOpen() && this.state.focus !== "sidebar") this.focusPanel(this.state.focus)
      },
    })
    this.dialog = new ConnectionDialog(renderer, {
      onSubmit: (values) => void this.submitConnection(values),
      onCancel: () => this.focusPanel("editor"),
    })
    this.helpDialog = new HelpDialog(renderer)
    this.promptDialog = new PromptDialog(renderer)
    this.pickers = new QueryPickers(
      renderer,
      { history: paths.history, favorites: paths.favorites },
      {
        onPick: (query) => {
          this.editor.setQuery(query)
          this.focusPanel("editor")
        },
        onClose: () => this.focusPanel("editor"),
        notify: (text, color) => this.results.showNotice(text, color),
      },
    )
    this.connectionPicker = new ConnectionPicker(renderer, {
      onChoose: (choice) => this.chooseConnection(choice),
      onEdit: (config) => this.openConnectionDialog(config, { edit: true }),
      onDelete: (config) => void this.deleteConnection(config),
      onClose: () => this.focusPanel("editor"),
    })
    this.tabs.add()
    this.buildLayout()
    this.renderer.root.add(this.completion.root)
    this.renderer.root.add(this.dialog.root)
    this.renderer.root.add(this.helpDialog.root)
    for (const root of this.pickers.roots) this.renderer.root.add(root)
    this.renderer.root.add(this.connectionPicker.root)
    this.renderer.root.add(this.promptDialog.root)
    this.renderer.once("destroy", () => this.flushTabs(this.lastConnectedId))
    this.setupKeybinds()
    this.setupFocusSync()
    this.focusPanel("editor")
  }

  get editor(): Editor {
    return this.tabs.active.editor
  }

  get results(): Results {
    return this.tabs.active.results
  }

  private anyDialogOpen(): boolean {
    return (
      this.dialog.isOpen ||
      this.helpDialog.isOpen ||
      this.pickers.isOpen ||
      this.connectionPicker.isOpen ||
      this.promptDialog.isOpen
    )
  }

  private setupFocusSync(): void {
    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (renderable: Renderable | null) => {
      if (renderable !== this.editor.textarea) this.closeCompletion()
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

    body.add(this.tabs.container)

    this.renderer.root.add(this.header.root)
    this.renderer.root.add(body)
  }

  private setupKeybinds(): void {
    this.renderer.keyInput.on("keypress", (key) => {
      if (this.pendingCloseTabId !== null && !(key.ctrl && key.name === "w")) {
        const pending = this.tabs.all.find((tab) => tab.id === this.pendingCloseTabId)
        this.pendingCloseTabId = null
        pending?.results.clearNotice()
      }
      if (this.promptDialog.isOpen) {
        if (key.name === "escape") {
          key.preventDefault()
          this.promptDialog.close()
          this.focusPanel("editor")
        }
        return
      }
      if (this.dialog.isOpen && key.name === "escape") {
        key.preventDefault()
        this.editingId = undefined
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
      if (this.pickers.handleKey(key)) return
      if (this.connectionPicker.handleKey(key)) return
      if (this.helpDialog.isOpen && (key.name === "escape" || (key.ctrl && key.name === "h"))) {
        key.preventDefault()
        this.helpDialog.close()
        return
      }
      if (this.completion.isOpen && this.handleCompletionKey(key)) return
      if (key.meta && !key.ctrl && !this.anyDialogOpen() && /^[1-9]$/.test(key.name)) {
        key.preventDefault()
        this.tabs.activate(Number(key.name) - 1)
        return
      }
      if (key.ctrl) {
        switch (key.name) {
          case "t":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.tabs.add()
            this.focusPanel("editor")
            break
          case "w":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.closeActiveTab()
            break
          case "n":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.renameActiveTab()
            break
          case "q":
            key.preventDefault()
            this.quit()
            break
          case "h":
            if (this.anyDialogOpen() && !this.helpDialog.isOpen) break
            key.preventDefault()
            this.helpDialog.open()
            break
          case "b":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.toggleSidebar()
            break
          case "r":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            void this.pickers.openHistory()
            break
          case "f":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            void this.pickers.openFavorites()
            break
          case "s": {
            if (this.anyDialogOpen() || this.state.focus !== "editor") break
            key.preventDefault()
            const target = this.editor.runTarget()
            if (target) void this.pickers.saveFavorite(target.text)
            break
          }
          case "x":
            if (this.anyDialogOpen() || this.state.focus !== "editor") break
            key.preventDefault()
            void this.explainQuery()
            break
          case "space":
            if (this.anyDialogOpen() || this.state.focus !== "editor") break
            key.preventDefault()
            this.completionManual = true
            this.updateCompletion(this.tabs.active)
            break
          case "o":
            if (this.anyDialogOpen()) break
            key.preventDefault()
            this.openConnectionPicker()
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

  private handleCompletionKey(key: KeyEvent): boolean {
    if (key.ctrl || key.meta) return false
    switch (key.name) {
      case "up":
      case "down":
        key.preventDefault()
        this.completion.move(key.name === "up" ? -1 : 1)
        return true
      case "tab":
      case "return":
        if (key.shift) return false
        key.preventDefault()
        this.acceptCompletion()
        return true
      case "escape":
        key.preventDefault()
        this.closeCompletion()
        return true
    }
    return false
  }

  private updateCompletion(tab: Tab): void {
    if (this.applyingCompletion) return
    const editor = tab.editor
    if (tab !== this.tabs.active || !editor.textarea.focused || this.anyDialogOpen()) {
      this.closeCompletion()
      return
    }
    const text = editor.query
    const cursor = editor.cursorIndex()
    const schemas = this.sidebar.loadedSchemas
    const result = complete(text, cursor, schemas, this.completionManual)
    if (result) {
      const back = cursor - result.start
      this.completion.show(result, () => editor.screenPosition(back))
    } else {
      this.closeCompletion()
    }

    const missing = statementTables(text, cursor, schemas).filter((ref) => ref.table.columns === null)
    if (missing.length === 0) return
    const manual = this.completionManual
    void Promise.all(
      missing.map((ref) => this.sidebar.ensureColumns(ref.schema, ref.table).catch(() => {})),
    ).then(() => {
      if (editor.query !== text || editor.cursorIndex() !== cursor) return
      this.completionManual = manual
      this.updateCompletion(tab)
    })
  }

  private acceptCompletion(): void {
    const current = this.completion.current
    const item = this.completion.selectedItem
    if (!current || !item) return
    this.applyingCompletion = true
    try {
      this.editor.replaceBeforeCursor(current.end - current.start, item.insert)
    } finally {
      this.applyingCompletion = false
    }
    this.closeCompletion()
  }

  private closeCompletion(): void {
    this.completionManual = false
    this.completion.hide()
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
    this.copyRowToClipboard(this.tabs.active, json)
  }

  private copyRowToClipboard(tab: Tab, json: string): void {
    this.renderer.copyToClipboardOSC52(json)
    tab.results.showCopied()
  }

  private closeActiveTab(): void {
    const tab = this.tabs.active
    if (tab.editor.query.trim() && this.pendingCloseTabId !== tab.id) {
      this.pendingCloseTabId = tab.id
      tab.results.showNotice("tab has SQL · ctrl+w again to close", theme.warning)
      return
    }
    this.pendingCloseTabId = null
    this.tabs.close(this.tabs.activeTabIndex)
  }

  private renameActiveTab(): void {
    const index = this.tabs.activeTabIndex
    this.promptDialog.open("Rename tab", this.tabs.active.name, (name) => {
      this.tabs.rename(index, name)
      this.focusPanel("editor")
    })
  }

  // Tabs belong to the last connection that succeeded, even while a later attempt has failed.
  private scheduleTabSave(): void {
    if (!this.lastConnectedId) return
    if (this.tabSaveTimer) clearTimeout(this.tabSaveTimer)
    this.tabSaveTimer = setTimeout(() => this.flushTabs(this.lastConnectedId), 300)
  }

  private flushTabs(id: string | null): void {
    if (this.tabSaveTimer) clearTimeout(this.tabSaveTimer)
    this.tabSaveTimer = null
    if (!id) return
    const session = this.tabs.session()
    try {
      this.tabStore.updateSync(id, () => session)
    } catch {
      // Losing tab state must not block switching connections or quitting.
    }
  }

  // First connect keeps the current tabs unless the connection has saved ones
  // (unsaved non-empty tabs are appended); a switch always swaps the whole set.
  private async loadTabsFor(id: string, firstConnect: boolean): Promise<void> {
    let saved: TabSession | null = null
    try {
      saved = await this.tabStore.load(id)
    } catch {
      saved = null
    }
    if (firstConnect) {
      if (!saved) return
      const unsaved = this.tabs.session().tabs.filter((tab) => tab.query.trim())
      this.tabs.replaceAll({
        active: unsaved.length > 0 ? saved.tabs.length : saved.active,
        tabs: [...saved.tabs, ...unsaved],
      })
      return
    }
    this.tabs.replaceAll(saved ?? { active: 0, tabs: [{ name: DEFAULT_TAB_NAME, query: "" }] })
  }

  toggleSidebar(): void {
    this.state.sidebarVisible = !this.state.sidebarVisible
    this.sidebar.root.visible = this.state.sidebarVisible
    if (!this.state.sidebarVisible && this.state.focus === "sidebar") {
      this.focusPanel("editor")
    }
  }

  async executeQuery(tab: Tab = this.tabs.active): Promise<void> {
    const query = tab.editor.runTarget()?.text.trim()
    if (!query) return
    if (await this.run(tab, query, query, null)) await this.pickers.recordRun(query)
  }

  async explainQuery(tab: Tab = this.tabs.active): Promise<void> {
    const query = tab.editor.runTarget()?.text.trim()
    if (!query) return
    const explain = `EXPLAIN ${query}`
    await this.run(tab, explain, explain, null)
  }

  // Returns false when the capped result's query can't be re-run safely; the
  // results panel then sorts the fetched rows instead.
  private requestSortRequery(tab: Tab, sort: SortState | null): boolean {
    const statement = tab.lastQuery ? requeryableQuery(tab.lastQuery) : null
    if (!statement || this.currentRun) return false
    void this.rerunSorted(tab, statement, sort)
    return true
  }

  private async rerunSorted(tab: Tab, statement: string, sort: SortState | null): Promise<void> {
    const sql = sort ? orderByQuery(statement, sort) : statement
    await this.run(tab, sql, tab.lastQuery ?? statement, sort, { keepRowsOnError: true })
  }

  // One query at a time across all tabs; a new run cancels the current one, and
  // results land in the tab that started it.
  private async run(
    tab: Tab,
    sql: string,
    sourceQuery: string,
    sort: SortState | null,
    options: { keepRowsOnError?: boolean } = {},
  ): Promise<boolean> {
    const id = ++this.runId
    while (this.currentRun) {
      this.db.cancel()
      await this.currentRun
      if (id !== this.runId) return false
    }
    if (!this.db.connected) {
      tab.results.showError("not connected to a database")
      return false
    }
    let finished = () => {}
    this.currentRun = new Promise((resolve) => (finished = resolve))
    tab.lastQuery = sourceQuery
    tab.results.setRunning()
    const alive = () => !this.quitting && this.tabs.all.includes(tab)
    try {
      const result = await this.db.execute(sql)
      if (!alive()) return true
      if (result.kind === "rows") tab.results.showRows(result, sort)
      else tab.results.showCommand(result)
      return true
    } catch (err) {
      if (!alive()) return false
      if (id !== this.runId) {
        if (options.keepRowsOnError) tab.results.clearNotice()
        else tab.results.showMessage("query cancelled", theme.warning)
        return false
      }
      if (options.keepRowsOnError) {
        tab.results.clearNotice()
        tab.results.showNotice(`sort failed: ${errorMessage(err)}`, theme.error)
      } else {
        tab.results.showError(errorMessage(err))
      }
      return false
    } finally {
      this.currentRun = null
      finished()
    }
  }

  startup(config: AppConfig): void {
    this.connections = config.connections
    this.openConnectionPicker()
  }

  openConnectionPicker(): void {
    this.connectionPicker.open(this.connections, this.activeId)
  }

  private chooseConnection(choice: ConnectionChoice): void {
    if (choice.kind === "new") this.openConnectionDialog()
    else if (choice.config.password || choice.config.passwordRef) void this.tryConnect(choice.config)
    else this.openConnectionDialog(choice.config)
  }

  // Connects with a saved password; on failure the dialog opens prefilled with the error.
  async tryConnect(config: StoredConfig): Promise<void> {
    if (await this.connect(config)) {
      if (!this.anyDialogOpen()) this.focusPanel("editor")
      return
    }
    this.openConnectionDialog(config)
    this.dialog.showError(this.lastConnectError)
  }

  openConnectionDialog(prefill?: StoredConfig, options: { edit?: boolean } = {}): void {
    this.connectionPicker.close()
    this.editingId = options.edit && prefill ? connectionId(prefill) : undefined
    const values = prefill ? toFormValues(prefill) : defaultFormValues()
    this.dialog.open(values, prefill !== undefined && !options.edit)
  }

  async submitConnection(values: ConnectionFormValues): Promise<void> {
    const normalized = normalizeConnection(values)
    if ("error" in normalized) {
      this.dialog.showError(normalized.error)
      return
    }
    this.dialog.showConnecting()
    if (await this.connect(normalized.config, this.editingId)) {
      this.editingId = undefined
      this.dialog.close()
      this.focusPanel("editor")
    } else {
      this.dialog.showError(this.lastConnectError)
    }
  }

  // `replaceId` is the saved connection being edited; it is dropped in favor of `config`.
  private async connect(config: StoredConfig, replaceId?: string): Promise<boolean> {
    const id = connectionId(config)
    this.header.setConnection("connecting", `${config.name ?? `${config.user}@${config.host}`}…`)
    try {
      await this.db.connect(config)
    } catch (err) {
      this.activeId = null
      this.pickers.connectionKey = null
      this.state.connection = "error"
      this.header.setConnection("error")
      this.sidebar.reset()
      this.lastConnectError = errorMessage(err)
      return false
    }
    const previous = this.lastConnectedId
    if (previous !== id) this.flushTabs(previous)
    this.activeId = id
    this.lastConnectedId = id
    this.pickers.connectionKey = id
    this.state.connection = "connected"
    this.header.setConnection("connected", config.name ?? id)
    void this.sidebar.load(this.db)
    if (previous !== id) await this.loadTabsFor(id, previous === null)
    this.connections = upsertConnection(this.connections, config, replaceId)
    await this.persistConnections("connected, but failed to save config")
    return true
  }

  private async deleteConnection(config: StoredConfig): Promise<void> {
    this.connections = removeConnection(this.connections, connectionId(config))
    this.connectionPicker.refresh(this.connections, this.activeId)
    await this.persistConnections("failed to save config")
  }

  private async persistConnections(failurePrefix: string): Promise<void> {
    if (this.configLoadError) {
      this.results.showNotice(`config not saved: fix the config file first (${this.configLoadError})`, theme.warning)
      return
    }
    try {
      await saveConfig({ connections: this.connections }, this.configPath)
    } catch (err) {
      this.results.showMessage(`${failurePrefix}: ${errorMessage(err)}`, theme.warning)
    }
  }

  // The file is left untouched from here on so a parse error can't turn into lost connections.
  showConfigError(message: string): void {
    this.configLoadError = message
    this.header.setConnection("error")
    this.results.showMessage(`config error: ${message}`, theme.error)
  }

  quit(): void {
    this.quitting = true
    this.db.cancel()
    void this.db.disconnect()
    this.renderer.destroy()
    for (const tab of this.tabs.all) {
      tab.editor.destroy()
      tab.results.destroy()
    }
  }
}
