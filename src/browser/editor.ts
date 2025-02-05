import type { Writable } from '../base';

import { seq } from '@wopjs/async-seq';
import { appendChild } from '@wopjs/dom';
import { combine, compute, derive, subscribe, val, type ReadonlyVal } from 'value-enhancer';
import { $, clearElement, onCustomEvent } from './dom';
import { Widget } from './widget';

export class Editor extends Widget {
  readonly path$: ReadonlyVal<string | undefined>;
  readonly contents$ = val<Uint8Array | undefined>();
  readonly isBinary$: ReadonlyVal<boolean>;
  readonly text$: ReadonlyVal<string | undefined>;

  readonly $header: HTMLElement;
  readonly $pre: HTMLPreElement; // TODO: use real editor

  override initialize(this: Writable<this>): void {
    const path$ = this.path$ = val();
    const decoder = new TextDecoder();
    this.isBinary$ = this._register(derive(this.contents$, b => !!b && b.subarray(0, 8000).indexOf(0) >= 0));
    this.text$ = this._register(compute(get => get(this.isBinary$) ? void 0 : decoder.decode(get(this.contents$))));

    const queue = this._register(seq({ window: 1, dropHead: true }));
    this._register(onCustomEvent<string>('editor.open', e => path$.set(e.detail)));
    this._register(subscribe(combine([this.root.git.commit$, path$]), ([_, path]) => {
      queue.schedule(async () => {
        if (path) await this.root.git.blob(path).then(this.contents$.set);
      });
    }));

    this.$header = appendChild(this.parent, $('.editors-header'));
    this.$pre = appendChild(this.parent, $('pre.pre'));
    this.$pre.textContent = 'Select a file to view its contents.';
    this.$pre.contentEditable = 'true';
    this.$pre.ariaReadOnly = 'true';
    this.$pre.onbeforeinput = e => e.preventDefault();
    this.$pre.classList.add('binary');

    this._register(subscribe(combine([this.path$, this.isBinary$, this.text$]), ([path, bin, text]) => {
      this.$header.textContent = path ?? null;
      if (path) {
        if (bin) {
          this.$pre.textContent = 'File is binary.';
          this.$pre.classList.add('binary');
        } else if (text != null) {
          this.$pre.textContent = text;
          this.$pre.classList.remove('binary');
        }
      }
    }));
  }

  override layout(): void {
  }
}
