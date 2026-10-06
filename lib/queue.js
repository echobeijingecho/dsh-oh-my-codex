// Bridges push-based subprocess/SDK notifications to the adapter's pull stream.
export class EventQueue {
  items = []
  bytes = 0
  waiter = undefined
  ended = false
  error = undefined

  push(value) {
    if (this.ended) return
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.bytes + bytes > 8 * 1024 * 1024) {
      this.fail(new Error('Engine event buffer exceeded its limit'))
      return
    }
    this.items.push({ value, bytes })
    this.bytes += bytes
    this.wake()
  }

  wake() {
    this.waiter?.()
    this.waiter = undefined
  }

  end() { this.ended = true; this.wake() }
  fail(error) { this.error = error; this.end() }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.error) throw this.error
      const item = this.items.shift()
      if (item) {
        this.bytes -= item.bytes
        yield item.value
      } else if (this.ended) return
      else await new Promise(resolve => { this.waiter = resolve })
    }
  }
}
