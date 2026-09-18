import { createCliRenderer } from "@opentui/core"
import { theme } from "./theme"
import { App } from "./app"
import { loadConfig } from "./config/config"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  backgroundColor: theme.bg,
})

const app = new App(renderer)

try {
  const config = await loadConfig()
  app.startup(config)
} catch (err) {
  app.showConfigError(err instanceof Error ? err.message : String(err))
}
