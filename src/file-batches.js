/** Batch attachments only from the same conversation AND sender. Preserve @/reply/media segments. */
export class FileBatches {
  constructor({ emit, onError = () => {}, delayMs = 2500, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { emit, onError, delayMs, setTimer, clearTimer });
    this.pending = new Map();
  }
  enqueue(chatKey, event) {
    const key = JSON.stringify([chatKey, String(event.user_id)]);
    const entry = this.pending.get(key) || { segments: [], event, timer: null };
    entry.segments.push(...(event.message || []));
    entry.event = event;
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => {
      this.pending.delete(key);
      Promise.resolve().then(() => this.emit({ ...entry.event, message: entry.segments, __batch: true })).catch(this.onError);
    }, this.delayMs);
    this.pending.set(key, entry);
  }
  close() { for (const entry of this.pending.values()) this.clearTimer(entry.timer); this.pending.clear(); }
}
