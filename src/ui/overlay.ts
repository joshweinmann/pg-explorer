import { BoxRenderable, type CliRenderer } from "@opentui/core"
import { theme } from "../theme"

// Full-screen dimmed backdrop that centers a modal panel; starts hidden.
export function createOverlay(renderer: CliRenderer, id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    backgroundColor: theme.overlayBg,
    visible: false,
    alignItems: "center",
    justifyContent: "center",
  })
}
