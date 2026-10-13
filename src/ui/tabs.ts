import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import { theme } from "../theme"
import { Editor } from "./editor"
import { Results } from "./results"
import type { SortState } from "../results/sort"
import {
  DEFAULT_TAB_NAME,
  tabAt,
  tabBarLayout,
  TAB_MORE_LEFT,
  TAB_MORE_RIGHT,
  TAB_SEPARATOR,
  type TabBarLayout,
  type TabSession,
} from "../tabs/tabs"

export interface Tab {
  readonly id: number
  name: string
  readonly editor: Editor
  readonly results: Results
  lastQuery: string | null
}

export interface TabHooks {
  onSubmit: (tab: Tab) => void
  onCopy: (tab: Tab, json: string) => void
  onSortRequery: (tab: Tab, sort: SortState | null) => boolean
  onChange: () => void
  onActivate: (tab: Tab) => void
}

// Owns every tab's editor/results pair inside `container`; only the active pair is visible.
// Starts empty: the owner calls add() once it can receive hook calls.
export class Tabs {
  readonly container: BoxRenderable
  private readonly renderer: CliRenderer
  private readonly bar: TextRenderable
  private readonly hooks: TabHooks
  private tabs: Tab[] = []
  private activeIndex = 0
  private nextId = 1
  private layout: TabBarLayout = { items: [], moreLeft: false, moreRight: false }

  constructor(renderer: CliRenderer, hooks: TabHooks) {
    this.renderer = renderer
    this.hooks = hooks
    this.container = new BoxRenderable(renderer, {
      id: "main",
      flexGrow: 1,
      flexDirection: "column",
    })
    this.bar = new TextRenderable(renderer, {
      id: "tab-bar",
      width: "100%",
      height: 1,
      content: "",
      wrapMode: "none",
      selectable: false,
      onSizeChange: () => this.refreshBar(),
      onMouseDown: (event) => {
        const index = tabAt(this.layout, event.x - this.bar.screenX)
        if (index !== null) this.activate(index)
      },
    })
    this.container.add(this.bar)
  }

  get active(): Tab {
    return this.tabs[this.activeIndex]!
  }

  get all(): readonly Tab[] {
    return this.tabs
  }

  get activeTabIndex(): number {
    return this.activeIndex
  }

  add(name?: string, query = ""): Tab {
    const id = this.nextId++
    const suffix = id === 1 ? "" : `-${id}`
    let tab: Tab
    const editor = new Editor(this.renderer, () => this.hooks.onSubmit(tab), {
      idSuffix: suffix,
      onChange: () => this.hooks.onChange(),
    })
    const results = new Results(
      this.renderer,
      (json) => this.hooks.onCopy(tab, json),
      (sort) => this.hooks.onSortRequery(tab, sort),
      suffix,
    )
    tab = {
      id,
      name: name ?? DEFAULT_TAB_NAME,
      editor,
      results,
      lastQuery: null,
    }
    if (query) editor.textarea.setText(query)
    this.container.add(editor.root)
    this.container.add(results.root)
    this.tabs.push(tab)
    this.activate(this.tabs.length - 1)
    return tab
  }

  activate(index: number): void {
    if (index < 0 || index >= this.tabs.length) return
    this.activeIndex = index
    for (const [i, tab] of this.tabs.entries()) {
      tab.editor.root.visible = i === index
      tab.results.root.visible = i === index
    }
    this.refreshBar()
    this.hooks.onChange()
    this.hooks.onActivate(this.active)
  }

  // Closing the last tab leaves a fresh empty one.
  close(index: number): void {
    const tab = this.tabs[index]
    if (!tab) return
    this.destroyTab(tab)
    this.tabs.splice(index, 1)
    if (this.tabs.length === 0) {
      this.add()
      return
    }
    this.activate(Math.min(index, this.tabs.length - 1))
  }

  rename(index: number, name: string): void {
    const tab = this.tabs[index]
    const trimmed = name.trim()
    if (!tab || !trimmed) return
    tab.name = trimmed
    this.refreshBar()
    this.hooks.onChange()
  }

  session(): TabSession {
    return {
      active: this.activeIndex,
      tabs: this.tabs.map((tab) => ({ name: tab.name, query: tab.editor.query })),
    }
  }

  replaceAll(session: TabSession): void {
    for (const tab of this.tabs) this.destroyTab(tab)
    this.tabs = []
    for (const saved of session.tabs) this.add(saved.name, saved.query)
    if (this.tabs.length === 0) this.add()
    this.activate(Math.min(session.active, this.tabs.length - 1))
  }

  private destroyTab(tab: Tab): void {
    tab.editor.destroy()
    this.container.remove(tab.editor.root)
    this.container.remove(tab.results.root)
    tab.editor.root.destroyRecursively()
    tab.results.root.destroyRecursively()
  }

  // Before the first layout the bar has no width yet; onSizeChange redraws once it does.
  private refreshBar(): void {
    const width = this.bar.width || this.renderer.terminalWidth
    const names = this.tabs.map((tab) => tab.name)
    this.layout = tabBarLayout(names, this.activeIndex, width)
    const chunks: TextChunk[] = []
    if (this.layout.moreLeft) chunks.push(fg(theme.dim)(TAB_MORE_LEFT))
    for (const [i, item] of this.layout.items.entries()) {
      if (i > 0) chunks.push(fg(theme.border)(TAB_SEPARATOR))
      chunks.push(item.index === this.activeIndex ? fg(theme.focus)(bold(item.text)) : fg(theme.dim)(item.text))
    }
    if (this.layout.moreRight) chunks.push(fg(theme.dim)(TAB_MORE_RIGHT))
    this.bar.content = new StyledText(chunks)
  }
}
