import { InputRenderable, type InputRenderableOptions, type KeyEvent, type RenderContext } from "@opentui/core"
import { OP_PREFIX } from "../config/config"

export class MaskedInput extends InputRenderable {
  private buffer = ""

  constructor(ctx: RenderContext, options: InputRenderableOptions = {}) {
    super(ctx, options)
  }

  get realValue(): string {
    return this.buffer
  }

  set realValue(value: string) {
    this.buffer = value
    this.value = this.display()
  }

  // A 1Password reference is not a secret, so it stays readable.
  private display(): string {
    return this.buffer.startsWith(OP_PREFIX) ? this.buffer : "•".repeat(this.buffer.length)
  }

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "return" || key.name === "kpenter" || key.name === "enter") {
      this.submit()
      return true
    }
    if (key.name === "escape") return true
    if (key.ctrl || key.meta) return false
    if (key.name === "backspace") {
      this.buffer = this.buffer.slice(0, -1)
      this.value = this.display()
      return true
    }
    // Accumulate the full sequence so pastes work, but ignore sequences with
    // control characters (arrows, function keys, etc.).
    if (
      key.sequence &&
      key.sequence.length > 0 &&
      !/[\u0000-\u001f\u007f]/.test(key.sequence)
    ) {
      this.buffer += key.sequence
      this.value = this.display()
      return true
    }
    return false
  }
}
