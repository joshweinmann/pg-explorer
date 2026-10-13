import { createCliRenderer } from "@opentui/core"
import { theme } from "./theme"
import { App } from "./app"
import { loadConfig } from "./config/config"
import { errorMessage } from "./errors"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  backgroundColor: theme.bg,
})

const app = new App(renderer)

try {
  app.startup(await loadConfig())
} catch (err) {
  app.showConfigError(errorMessage(err))
}
