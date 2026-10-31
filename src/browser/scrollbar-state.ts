export interface Thumb {
  readonly offset: number;
  readonly size: number;
}

// Keep the visual thumb independent of the native scroll position while search
// results arrive. Interpolate toward the endpoint in the direction of travel:
// https://madebyevan.com/algos/non-euclidean-scrollbar/
export class ScrollbarState {
  offset = 0;
  viewport = 0;
  total = 0;
  private start = 0;
  private size = 1;

  get range(): number { return Math.max(0, this.total - this.viewport); }

  update(offset: number, viewport: number, total: number, append = false): void {
    const range = Math.max(0, total - viewport);
    offset = Math.max(0, Math.min(range, offset));
    const preserve = append && total >= this.total && viewport === this.viewport &&
      this.offset > 0 && this.offset < this.range;
    if ((total !== this.total || viewport !== this.viewport) && !preserve) {
      this.start = total > 0 ? offset / total : 0;
      this.size = total > 0 ? Math.min(1, viewport / total) : 1;
    } else {
      this.total = total;
      this.viewport = viewport;
      const next = this.project(offset);
      this.start = next.offset;
      this.size = next.size;
    }
    this.offset = offset;
    this.viewport = viewport;
    this.total = total;
  }

  reset(): void {
    this.start = this.total > 0 ? this.offset / this.total : 0;
    this.size = this.total > 0 ? Math.min(1, this.viewport / this.total) : 1;
  }

  private project(offset: number): Thumb {
    const delta = offset - this.offset;
    const ideal = this.total > 0 ? Math.min(1, this.viewport / this.total) : 1;
    let start = this.start, size = this.size;
    if (delta < 0 && this.offset > 0) {
      const t = Math.min(1, -delta / this.offset);
      start *= 1 - t;
      size += (ideal - size) * t;
    } else if (delta > 0 && this.range > this.offset) {
      const t = Math.min(1, delta / (this.range - this.offset));
      const end = start + size;
      size += (ideal - size) * t;
      start = end + (1 - end) * t - size;
    }
    return { offset: Math.max(0, Math.min(1 - size, start)), size };
  }

  thumb(track: number, offset = this.offset): Thumb {
    const next = this.project(offset);
    const size = Math.min(track, Math.max(24, next.size * track));
    return { offset: next.size < 1 ? (track - size) * next.offset / (1 - next.size) : 0, size };
  }

  scrollAt(pointer: number, track: number, fraction: number): number {
    let low = 0, high = this.range;
    for (let i = 0; i < 32; i++) {
      const middle = (low + high) / 2;
      const thumb = this.thumb(track, middle);
      if (thumb.offset + thumb.size * fraction < pointer) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  }
}
