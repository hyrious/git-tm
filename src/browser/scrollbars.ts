import { appendChild, listen } from '@wopjs/dom';
import { Disposable } from '../common/disposable';
import { $ } from './dom';
import { ScrollbarState } from './scrollbar-state';

interface Axis {
  readonly vertical: boolean;
  readonly track: HTMLElement;
  readonly thumb: HTMLElement;
  readonly state: ScrollbarState;
  length: number;
}

interface Drag {
  readonly axis: Axis;
  readonly id: number;
  readonly fraction: number;
}

// The positioned parent owns the overlay; the viewport keeps native scrolling.
export class Scrollbars extends Disposable {
  private readonly $host: HTMLElement;
  private readonly $layer: HTMLElement;
  private readonly axes: Axis[] = [];
  private drag: Drag | undefined;
  private frame = 0;

  constructor(private readonly viewport: HTMLElement, content?: HTMLElement) {
    super();
    this.$host = viewport.parentElement!;
    this.$layer = appendChild(this.$host, $('.scrollbars'));
    this.$layer.setAttribute('aria-hidden', 'true');
    this.$host.classList.add('scrollbar-host');
    viewport.classList.add('scrollbar-viewport');
    for (const vertical of [false, true]) {
      const $track = appendChild(this.$layer, $(vertical ? '.scrollbar-y' : '.scrollbar-x'));
      const $thumb = appendChild($track, $('.scrollbar-thumb'));
      const axis: Axis = { vertical, track: $track, thumb: $thumb, state: new ScrollbarState(), length: 0 };
      this.axes.push(axis);
      this._register(listen($track, 'pointerdown', e => this.startDrag(axis, e)));
      this._register(listen($track, 'pointermove', e => this.moveDrag(e)));
      this._register(listen($track, 'pointerup', e => this.finishDrag(e)));
      this._register(listen($track, 'pointercancel', e => this.finishDrag(e)));
      this._register(listen($track, 'lostpointercapture', e => this.finishDrag(e)));
      this._register(listen($track, 'click', e => e.stopPropagation()));
    }
    this._register(listen(viewport, 'scroll', () => this.schedule(), { passive: true }));
    this._register(listen(this.$layer, 'wheel', e => {
      if (e.ctrlKey) return;
      const line = parseFloat(getComputedStyle(viewport).lineHeight) || 16;
      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= line;
        dy *= line;
      } else if (e.deltaMode === 2) {
        dx *= viewport.clientWidth;
        dy *= viewport.clientHeight;
      }
      const top = viewport.scrollTop, left = viewport.scrollLeft;
      viewport.scrollBy({ left: e.shiftKey && !dx ? dy : dx, top: e.shiftKey && !dx ? 0 : dy, behavior: 'instant' });
      if (viewport.scrollTop !== top || viewport.scrollLeft !== left) e.preventDefault();
    }, { passive: false }));
    const resize = new ResizeObserver(() => this.schedule());
    resize.observe(viewport);
    resize.observe(this.$host);
    if (content) resize.observe(content);
    const mutation = new MutationObserver(() => this.schedule());
    mutation.observe(viewport, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    this._register(() => { resize.disconnect(); mutation.disconnect(); });
    this.schedule();
  }

  private schedule(): void {
    this.frame ||= requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  update(append = false): void {
    const viewport = this.viewport;
    const rect = viewport.getBoundingClientRect(), $host = this.$host.getBoundingClientRect();
    const scaleX = this.$host.offsetWidth > 0 ? $host.width / this.$host.offsetWidth : 1;
    const scaleY = this.$host.offsetHeight > 0 ? $host.height / this.$host.offsetHeight : 1;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const totalWidth = viewport.scrollWidth, totalHeight = viewport.scrollHeight;
    const horizontal = totalWidth > width, vertical = totalHeight > height;
    this.$layer.style.left = `${(rect.left - $host.left) / (scaleX || 1) - this.$host.clientLeft + viewport.clientLeft}px`;
    this.$layer.style.top = `${(rect.top - $host.top) / (scaleY || 1) - this.$host.clientTop + viewport.clientTop}px`;
    this.$layer.style.width = `${width}px`;
    this.$layer.style.height = `${height}px`;
    for (const axis of this.axes) {
      const size = axis.vertical ? height : width;
      const total = axis.vertical ? totalHeight : totalWidth;
      const offset = axis.vertical ? viewport.scrollTop : viewport.scrollLeft;
      axis.state.update(offset, size, total, append && axis.vertical);
      axis.length = Math.max(0, size - 4 - ((axis.vertical ? horizontal : vertical) ? 10 : 0));
      axis.track.hidden = size <= 0 || total <= size || axis.length <= 0;
      axis.track.style[axis.vertical ? 'height' : 'width'] = `${axis.length}px`;
      const thumb = axis.state.thumb(axis.length);
      axis.thumb.style[axis.vertical ? 'height' : 'width'] = `${thumb.size}px`;
      axis.thumb.style.transform = `${axis.vertical ? 'translateY' : 'translateX'}(${thumb.offset}px)`;
      if (axis.track.hidden && this.drag?.axis === axis) this.finishDrag();
    }
  }

  reset(): void {
    this.finishDrag();
    for (const axis of this.axes) axis.state.reset();
    this.update();
  }

  private pointer(axis: Axis, e: PointerEvent): number {
    const rect = axis.track.getBoundingClientRect();
    const size = axis.vertical ? rect.height : rect.width;
    return size > 0 ? ((axis.vertical ? e.clientY - rect.top : e.clientX - rect.left) / size) * axis.length : 0;
  }

  private startDrag(axis: Axis, e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    this.update();
    if (axis.track.hidden) return;
    const thumb = axis.state.thumb(axis.length);
    if (thumb.size >= axis.length) return;
    e.preventDefault();
    e.stopPropagation();
    const fraction = e.target === axis.thumb ? Math.max(0, Math.min(1, (this.pointer(axis, e) - thumb.offset) / thumb.size)) : 0.5;
    this.drag = { axis, id: e.pointerId, fraction };
    axis.track.setPointerCapture(e.pointerId);
    axis.track.classList.add('dragging');
    if (e.target !== axis.thumb) this.moveDrag(e);
  }

  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.id) return;
    this.update();
    if (this.drag !== drag) return;
    const offset = drag.axis.state.scrollAt(this.pointer(drag.axis, e), drag.axis.length, drag.fraction);
    this.viewport.scrollTo(drag.axis.vertical ? { top: offset, behavior: 'instant' } : { left: offset, behavior: 'instant' });
    this.update();
  }

  private finishDrag(e?: PointerEvent): void {
    const drag = this.drag;
    if (!drag || (e && e.pointerId !== drag.id)) return;
    this.drag = undefined;
    drag.axis.track.classList.remove('dragging');
    if (drag.axis.track.hasPointerCapture(drag.id)) drag.axis.track.releasePointerCapture(drag.id);
  }

  override dispose(): void {
    this.finishDrag();
    cancelAnimationFrame(this.frame);
    super.dispose();
    this.$layer.remove();
    this.viewport.classList.remove('scrollbar-viewport');
    this.$host.classList.remove('scrollbar-host');
  }
}
