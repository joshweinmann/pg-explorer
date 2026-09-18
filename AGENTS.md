# pg-explorer

TUI PostgreSQL client. Bun + TypeScript + open-tui. See REQUIREMENTS.md and ARCHITECTURE.md.

## Commands

Bun is at `~/.bun/bin/bun` (not on default PATH in non-interactive shells).

```sh
bun run dev            # run the app (needs a TTY)
bun test               # run tests (headless test-renderer based)
bunx tsc --noEmit      # typecheck
bun run scripts/preview.ts   # render one frame to stdout for layout debugging
bun run build          # compile standalone binary (rebuild after source changes)
```

## Docs

- `REQUIREMENTS.md` — product requirements brief
- `ARCHITECTURE.md` — architecture plan and milestones
- `.agents/skills/opentui/` — canonical open-tui reference: read `SKILL.md` first, then the narrower `docs/**/*.mdx` page for the task. Layout rule from the skill: no gaps between panels, compact information-dense layouts.

## Conventions

- No comments referencing the current conversation; comments only where code needs them.
- Pure logic (SQL tokenizer, formatters, pagination, config) lives outside `ui/` so it's unit-testable; `bun test` covers it.
- UI smoke tests use `@opentui/core/testing` (`createTestRenderer`), never a real terminal. Shared helpers live in `src/app.test.ts`: `boot()` for the harness, `fakeDb()` for the database. Assert frames with `captureCharFrame()` and colors with `captureSpans()`. Config tests use tmp-dir paths.
- Keybinds are handled globally in `src/app.ts` via `renderer.keyInput.on("keypress")` + `key.preventDefault()` (globals run before focused-component handlers). Guard panel keys while a dialog is open.
- Colors live only in `src/theme.ts`.
- Focus sync: subscribe to `renderer.on(CliRenderEvents.FOCUSED_RENDERABLE)` and walk the focused renderable's parent chain to a panel root. The event fires *before* `hasFocusedDescendant` flags propagate, so flag checks don't work inside the handler.
- Modals (connection dialog, help dialog): absolute-positioned overlay + high zIndex + opaque panel background, key handling guarded in `app.ts`. Close restores editor focus.
- Selection highlight: light-gray chunk `bg` (`theme.selectBg`), never the INVERSE text attribute.
- Results table is windowed (header + visible slice, sticky header). Capacity must reserve the horizontal-scrollbar row when the table overflows — the ScrollBox outer height includes it. Rows must stay single-line (`sanitizeCellText` in `results/format.ts`); copy-as-JSON uses raw values.
- Mouse: hit-testing returns the ScrollBox content box, so attach row handlers to the viewport and rely on event bubbling. Set `selectable: false` on click-handled text. Double-click detection is manual (no native click count) — consume the pair after firing so consecutive double-clicks don't double-toggle.
- Editor highlighting: `SyntaxStyle` + `registerStyle` per token kind, applied via `addHighlight` on every content change. The line-number gutter needs the editor's inner row Box height to track the editor height.
