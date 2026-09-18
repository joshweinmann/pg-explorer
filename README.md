# pg-explorer

A minimalist TUI PostgreSQL client. Black background, white text, color reserved for feedback — errors, connection status, constraint markers, and syntax highlighting.

## Features

- **Schema browser** — expandable schemas → tables/views → columns tree with data types and `PK` / `FK` / `NN` markers
- **SQL editor** — line numbers, keyword/string/number/comment highlighting, auto-growing height, `CTRL-Enter` to execute
- **Results grid** — bordered table with sticky header, pagination, row selection, and copy-row-as-JSON
- **Connection dialog** — masked password input; credentials (minus password) persist to config
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

On first launch with saved credentials, the connection dialog opens pre-filled and only asks for the password.

## Config

Settings live at `~/.config/pg-explorer/config` (TOML). The password is never written to disk — it is prompted every launch.

```toml
[connection]
host = "localhost"
port = 5432
user = "postgres"
database = "mydb"
```

## Keybinds

Also available anytime inside the app with `CTRL-H`.

### Global

| Keys | Action |
| ---- | ------ |
| `ctrl+q` | Quit |
| `ctrl+o` | Connection dialog |
| `ctrl+b` | Toggle sidebar |
| `ctrl+1 / 2 / 3` | Focus sidebar / editor / results |
| `tab / shift+tab` | Cycle panel focus |
| `ctrl+h` | This help |
| `esc` | Close dialog |

### Editor

| Keys | Action |
| ---- | ------ |
| `ctrl+enter` | Execute query |

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
| `home / end` | First / last row |
| `pageup / pagedown` | Previous / next page |
| `n / p` | Next / previous page |
| `c` | Copy row as JSON |
| `click` | Select row |
| `double-click` | Copy row as JSON |

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
