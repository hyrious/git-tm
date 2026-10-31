import { Disposable } from '../common/disposable';
import { appendChild } from '@wopjs/dom';
import { $ } from './dom';
import { Scrollbars } from './scrollbars';

export function fontType(path: string): string | undefined {
  switch (path.split('.').pop()?.toLowerCase()) {
    case 'woff2': return 'font/woff2';
    case 'woff': return 'font/woff';
    case 'ttf': case 'otf': return 'font/sfnt';
    case 'ttc': case 'otc': return 'font/collection';
  }
}

const sampleText = 'Sphinx of black quartz, judge my vow! 0123456789';
const sampleCJK = '天地玄黄，宇宙洪荒。汉字字体预览示例：永东国酬爱郁灵鹰，AaBbCc 0123';
const sizes = [12, 16, 24, 32, 48, 64];
const cjkSizes = [16, 24, 32, 48];

let familyId = 0;
const uniqueFamily = () => `git-tm-font-${++familyId}`;

function hasGlyph(family: string, char: string): boolean {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.textBaseline = 'top';
  const render = (font: string) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = `64px ${JSON.stringify(font)}`;
    context.fillText(char, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data.join();
  };
  const actual = render(family);
  return actual !== render(uniqueFamily()) && actual !== render(uniqueFamily());
}

const supportsCJK = (family: string) => hasGlyph(family, '天');

export class FontPreview extends Disposable {
  private readonly element = $('.font-preview');
  private readonly viewport = $('.font-viewport');
  private readonly sample = $('.font-sample');

  constructor(parent: HTMLElement, contents: Uint8Array, mime: string, path: string, onError: () => void) {
    super();
    parent.append(this.element);
    this.element.append(this.viewport);
    this.viewport.tabIndex = 0;
    this.viewport.ariaLabel = 'Font preview';
    this.sample.dataset.key = path;
    this.viewport.append(this.sample);
    this._register(new Scrollbars(this.viewport, this.sample));

    this.addLine(sampleText, 16, '');
    for (const size of cjkSizes) this.addLine(sampleCJK, size, '');

    const url = URL.createObjectURL(new Blob([new Uint8Array(contents)], { type: mime }));
    this._register(() => URL.revokeObjectURL(url));
    const family = uniqueFamily();
    const face = new FontFace(family, `url(${url})`);
    document.fonts.add(face);
    this._register(() => document.fonts.delete(face));
    face.load().then(() => {
      this.sample.replaceChildren();
      for (const size of sizes) this.addLine(sampleText, size, family);
      if (supportsCJK(family)) {
        for (const size of cjkSizes) this.addLine(sampleCJK, size, family);
      }
    }, () => onError());
  }

  private addLine(text: string, size: number, family: string): void {
    const line = appendChild(this.sample, $('.font-sample-line'));
    line.style.fontSize = `${size}px`;
    if (family) line.style.fontFamily = family;
    line.textContent = text;
  }

  override dispose(): void {
    super.dispose();
    this.element.remove();
  }
}
