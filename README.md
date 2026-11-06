# pg-explorer

A minimalist TUI PostgreSQL client. Black background, white text, color reserved for feedback — errors, connection status, constraint markers, and syntax highlighting.

## Features

- **Schema browser** — expandable schemas → tables/views, each with collapsible **columns** (data types and `PK` / `FK` / `NN` markers), **indexes**, **constraints**, and **triggers** groups; rows too long for the sidebar end in `…`
- **SQL editor** — line numbers, keyword/string/number/comment highlighting, auto-growing height, undo/redo; `CTRL-Enter` runs the statement under the cursor (highlighted in the gutter), `CTRL-X` runs `EXPLAIN` on it
- **Autocomplete** — table, column, and keyword suggestions while typing; `CTRL-Space` opens them on demand. Columns of tables referenced in the statement are loaded on demand, and aliases resolve
- **Running queries** — the results footer shows a live timer; starting a new query cancels the running one
- **Results grid** — bordered table with sticky header, pagination, row selection, mouse-wheel scrolling, copy-row-as-JSON, and click-to-sort headers. `EXPLAIN` output is shown as plain, untruncated text
- **Tabs** — each tab has its own SQL and results; tabs are saved per connection and restored on reconnect
- **Query history & favorites** — per-connection, searchable pickers (`CTRL-R` / `CTRL-F`)
- **Saved connections** — `CTRL-O` lists saved connections with optional names and notes; masked password input; passwords are saved to the config file, or kept in 1Password via an `op://` reference; SSL is used when the server supports it
- **In-app keybind help** — `CTRL-H`

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 (also used to build the standalone binary)
- A reachable PostgreSQL server
- A terminal with kitty keyboard protocol support (e.g. Ghostty) for `CTRL-Enter` and friends

## Install & run

```sh
git clone <repo-url> pg-explorer
cd pg-explorer
bun install

bun run dev        # run from source (needs a TTY)

# or install the pg-explorer command (compiles a standalone
# binary with no runtime deps into ~/.local/bin):
bun run install
pg-explorer        # works from any directory
```

On launch the connections picker opens: pick a saved connection (connects immediately if its password is saved) or `+ new connection`.

## Config

Settings live at `~/.config/pg-explorer/config` (TOML), kept owner-only (`0600`) because it stores passwords. Every successful connect saves the connection (with its password) and moves it to the top of the list. A legacy single `[connection]` table is still read. If the file fails to parse, the app shows the error and leaves the file untouched until it is fixed.

```toml
[[connections]]
name = "Local"
host = "localhost"
port = 5432
user = "postgres"
database = "mydb"
password = "secret"
notes = "scratch database"

[[connections]]
name = "Prod read replica"
host = "replica.example.com"
port = 5432
user = "readonly"
database = "app"
passwordRef = "op://Engineering/prod-replica/password"
```

`name` and `notes` are optional and searchable in the connections picker. Entering a password that starts with `op://` stores it as `passwordRef`; the secret is read with the [1Password CLI](https://developer.1password.com/docs/cli/) (`op read`) on each connect and never written to the config file.

Query history, favorites, and open tabs are stored per connection in `~/.config/pg-explorer/history.json` (last 500, deduplicated), `favorites.json`, and `tabs.json`.

## Keybinds

Also available anytime inside the app with `CTRL-H`.

### Global

| Keys | Action |
| ---- | ------ |
| `ctrl+q` | Quit |
| `ctrl+o` | Connections |
| `ctrl+b` | Toggle sidebar |
| `ctrl+1 / 2 / 3` | Focus sidebar / editor / results |
| `tab / shift+tab` | Cycle panel focus |
| `ctrl+r` | Query history |
| `ctrl+f` | Favorite queries |
| `ctrl+h` | This help |
| `esc` | Close dialog |

### Editor

| Keys | Action |
| ---- | ------ |
| `ctrl+enter` | Run the statement under the cursor (cancels a running query) |
| `ctrl+x` | `EXPLAIN` the statement under the cursor |
| `ctrl+space` | Autocomplete |
| `tab / enter` | Accept suggestion |
| `ctrl+z` / `ctrl+shift+z` | Undo / redo |
| `ctrl+s` | Save as favorite |

### Tabs

| Keys | Action |
| ---- | ------ |
| `ctrl+t` / `ctrl+w` | New / close tab (press `ctrl+w` twice if the tab has SQL) |
| `alt+1` … `alt+9` | Jump to tab |
| `ctrl+n` | Rename tab |
| `click tab` | Switch to tab |

### Pickers (history, favorites, connections)

| Keys | Action |
| ---- | ------ |
| type | Filter |
| `up / down` | Move |
| `enter` | Pick |
| `ctrl+s` | History: favorite · Favorites: remove |
| `ctrl+e` / `ctrl+d` | Connections: edit / delete (press twice) |

### Sidebar

| Keys | Action |
| ---- | ------ |
| `up / down` | Move cursor |
| `enter / space` | Expand / collapse |
| `r` | Refresh schemas |
| `click` | Select row |
| `double-click` | Expand / collapse |

### Results

| Keys | Action |
| ---- | ------ |
| `up / down` | Move row selection |
| `left / right` | Scroll sideways |
| mouse wheel | Scroll rows (selection stays put) |
| `home / end` | First / last row |
| `pageup / pagedown` | Previous / next page |
| `n / p` | Next / previous page |
| `c` | Copy row as JSON |
| `click` | Select row |
| `double-click` | Copy row as JSON |
| `click header` | Sort asc / desc / off (a capped single read-only query is re-run with `ORDER BY`; otherwise only the fetched rows are sorted) |

## Tech stack

- Runtime: Bun + TypeScript
- UI: [@opentui/core](https://opentui.com) (imperative renderables)
- Database: [postgres.js](https://github.com/porsager/postgres)
- Config: TOML via [smol-toml](https://github.com/squirrelchat/smol-toml)

## Development

```sh
bun test               # headless test-renderer suite
bunx tsc --noEmit      # typecheck
bun run scripts/preview.ts   # render one frame to stdout for layout debugging
```

Pure logic (SQL tokenizer, formatters, pagination, config) lives outside `ui/` and is unit-tested; UI behavior is covered by headless smoke tests. See `REQUIREMENTS.md` and `ARCHITECTURE.md` for the product brief and design, and `AGENTS.md` for contributor conventions.
