import { InputRenderable, type InputRenderableOptions, type KeyEvent, type RenderContext } from "@opentui/core"

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
    this.value = "•".repeat(value.length)
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
      this.value = "•".repeat(this.buffer.length)
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
      this.value = "•".repeat(this.buffer.length)
      return true
    }
    return false
  }
}
