import { disposableStore, type IDisposable } from '@wopjs/disposable';
import { appendChild, listen } from '@wopjs/dom';
import { $ } from './dom';
import { Scrollbars } from './scrollbars';
import { MenuNavigation } from './menu-navigation';
import { bindKeys } from './keybindings';

export function imageType(path: string): string | undefined {
  switch (path.split('.').pop()?.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': case 'jfif': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    case 'svg': return 'image/svg+xml';
  }
}

const scales = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16];

export class ImagePreview implements IDisposable {
  private readonly store = disposableStore();
  private readonly element = $('.image-preview');
  private readonly viewport = $('.image-viewport');
  private readonly canvas = $('.image-canvas');
  private readonly image = $('img');
  private readonly zoom = $('button.image-zoom');
  private readonly menu = $('.image-zoom-menu');
  private readonly dimensions = $('span.image-dimensions');
  private readonly items: HTMLElement[] = [];

  private mode = 'fit';
  private scale = 1;

  constructor(parent: HTMLElement, status: HTMLElement, contents: Uint8Array, mime: string, path: string, onError: () => void) {
    parent.append(this.element);
    status.append(this.zoom, this.dimensions, this.menu);
    this.zoom.type = 'button';
    this.zoom.textContent = 'Fit';
    this.zoom.ariaLabel = 'Image zoom';
    this.zoom.setAttribute('aria-haspopup', 'menu');
    this.zoom.setAttribute('popovertarget', 'image-zoom-menu');
    this.menu.id = 'image-zoom-menu';
    this.menu.popover = '';
    this.menu.tabIndex = -1;
    this.menu.setAttribute('role', 'menu');
    this.menu.ariaLabel = 'Image zoom';
    const content = appendChild(this.menu, $('.menu-content'));
    for (const mode of ['fit', ...scales.map(String)]) {
      const item = appendChild(content, $('.menu-item'));
      item.textContent = mode === 'fit' ? 'Fit' : `${Number(mode) * 100}%`;
      item.dataset.mode = mode;
      item.tabIndex = -1;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(mode === this.mode));
      this.items.push(item);
      this.store.add(listen(item, 'click', () => this.select(item)));
    }
    this.store.add(new Scrollbars(content));
    this.store.add(new MenuNavigation(this.menu, this.items, item => item.textContent || '', () => { }));
    this.store.add(bindKeys(this.menu, {
      'Enter,Space': () => {
        const item = document.activeElement;
        if (item instanceof HTMLElement && this.items.includes(item)) this.select(item);
      },
      'Escape': () => { this.closeMenu(); this.zoom.focus(); },
    }, true));
    this.store.add(listen(this.zoom, 'click', e => {
      e.preventDefault();
      if (this.menu.matches(':popover-open')) this.closeMenu();
      else {
        this.menu.showPopover();
        this.items.find(item => item.dataset.mode === this.mode)?.focus();
      }
    }));
    const host = appendChild(this.element, $('.image-scroll'));
    host.append(this.viewport);
    this.viewport.tabIndex = 0;
    this.viewport.ariaLabel = 'Image preview';
    this.viewport.append(this.canvas);
    this.canvas.append(this.image);
    this.image.alt = path;
    this.image.draggable = false;
    this.image.hidden = true;
    this.store.add(listen(this.image, 'load', () => {
      this.image.hidden = false;
      this.dimensions.textContent = `${this.image.naturalWidth}×${this.image.naturalHeight}`;
      this.layout();
    }));
    this.store.add(listen(this.image, 'error', onError));
    this.store.add(listen(this.canvas, 'click', e => this.step(e.altKey ? -1 : 1)));
    const cursor = (e: MouseEvent | KeyboardEvent) => {
      this.canvas.style.cursor = e.altKey ? 'zoom-out' : 'zoom-in';
    };
    this.store.add(listen(this.canvas, 'pointermove', cursor));
    this.store.add(listen(this.canvas, 'pointerenter', cursor));
    this.store.add(listen(window, 'keydown', cursor));
    this.store.add(listen(window, 'keyup', cursor));
    this.store.add(listen(window, 'blur', () => this.canvas.style.cursor = 'zoom-in'));
    this.store.add(listen(this.viewport, 'wheel', e => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      e.preventDefault();
      this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false }));
    const resize = new ResizeObserver(() => this.layout());
    resize.observe(this.viewport);
    this.store.add(() => resize.disconnect());
    this.store.add(new Scrollbars(this.viewport, this.canvas));
    const url = URL.createObjectURL(new Blob([new Uint8Array(contents)], { type: mime }));
    this.store.add(() => URL.revokeObjectURL(url));
    this.image.src = url;
  }

  private step(direction: number): void {
    const scale = direction > 0
      ? scales.find(scale => scale > this.scale)
      : scales.findLast(scale => scale < this.scale);
    if (scale == null) return;
    this.mode = String(scale);
    this.layout();
  }

  private layout(): void {
    const { naturalWidth: width, naturalHeight: height } = this.image;
    if (!width || !height) return;
    const fit = Math.min(1, Math.max(1, this.viewport.clientWidth - 32) / width, Math.max(1, this.viewport.clientHeight - 32) / height);
    this.scale = this.mode === 'fit' ? fit : Number(this.mode);
    this.image.style.width = `${width * this.scale}px`;
    this.image.style.height = `${height * this.scale}px`;
    this.image.style.imageRendering = this.scale > 1 ? 'pixelated' : 'auto';
    this.zoom.textContent = this.mode === 'fit' ? 'Fit' : `${this.scale * 100}%`;
    for (const item of this.items) item.setAttribute('aria-checked', String(item.dataset.mode === this.mode));
  }

  private select(item: HTMLElement): void {
    this.mode = item.dataset.mode!;
    this.layout();
    this.closeMenu();
    this.zoom.focus();
  }

  closeMenu(): void {
    if (this.menu.matches(':popover-open')) this.menu.hidePopover();
  }

  dispose(): void {
    this.closeMenu();
    this.store.dispose();
    this.image.removeAttribute('src');
    this.element.remove();
    this.dimensions.remove();
    this.zoom.remove();
    this.menu.remove();
  }
}
