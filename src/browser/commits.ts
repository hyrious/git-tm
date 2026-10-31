import type { DisposableType } from '@wopjs/disposable';

import { SnapshotKind, snapshotId, type Snapshot } from '../common/git';
import { Graph, type GraphTrack } from '../common/graph';
import { noop } from '@wopjs/cast';
import { appendChild, svgElement } from '@wopjs/dom';
import { batch, reactiveArray, writable, type ReactiveArray } from '@embra/reactivity';
import { clamp, MAX_TRACKS, type Writable } from '../common/base';
import { styleMod } from './css';
import { $, clearElement, onCustomEvent } from './dom';
import { Scrollable, type ItemRenderer } from './scrollable';
import { Widget } from './widget';
import { createCommitContent, renderCommitContent, renderCommitStat, type CommitContent } from './commit-content';
import { bindKeys } from './keybindings';

const ITEM_HEIGHT = 48;

const PlaceHolder = Symbol.for('PlaceHolder');
type PlaceHolder = typeof PlaceHolder;

type Item = {
  readonly index: number;
  readonly snapshot: Snapshot;
  readonly tracks: readonly (GraphTrack | null)[];
} | PlaceHolder;

interface Template extends CommitContent {
  readonly $tracks: HTMLElement;
}

export class Commits extends Widget implements ItemRenderer<Item, Template> {
  readonly $header: HTMLElement;
  readonly $container: HTMLElement;

  readonly scrollable: Scrollable<Item, Template>;
  readonly items: ReactiveArray<Item>;
  readonly offset$ = this._register(writable<number | undefined>(undefined)); // index = range.start + offset

  override async initialize(this: Writable<this>): Promise<void> {
    this.$container = appendChild(this.parent, $('.commits'));
    this.$container.ariaLabel = 'Commits';

    const items = this.items = this._register(reactiveArray<Item>());
    this.scrollable = this._register(new Scrollable({
      container: this.$container,
      itemHeight: ITEM_HEIGHT,
      items$: items.$,
      renderer: this,
    }));
    this._register(bindKeys(this.$container, { 'Enter': () => this.accept() }));
    this._register(onCustomEvent('scroll-to', e => this.scrollable.scrollTo(e.detail as number)));

    this._register(this.scrollable.visibleRange$.subscribe(range => {
      this.root.git.touch(range.end).catch(console.error);
      if (this.offset$.value != null) {
        const target = range.start + this.offset$.value;
        this.root.git.index$.set(clamp(target, 0, items.length - 1));
      }
    }));

    const graph = new Graph();
    let i = 0;
    this._register(this.root.git.history.$.subscribe(history => batch(() => {
      if (items.length < history.length) {
        items.replace(items.concat(Array(history.length - items.length).fill(PlaceHolder)));
      }
      for (; history[i]; i++) {
        const snapshot = history[i]!;
        items.set(i, { index: i, snapshot, tracks: graph.append(snapshot) });
      }
    })));

    this._register(this.scrollable.onDidChangeFocus(index => {
      this.offset$.set(undefined);
      window.dispatchEvent(new CustomEvent('pinned', { detail: false }));
      this.root.git.index$.set(index);
    }));
    this._register(this.root.git.index$.subscribe(index => this.scrollable.setFocus(index)));
    this._register(this.scrollable.onDblClick(index => {
      const offset = index - this.scrollable.visibleRange$.value.start;
      if (this.offset$.value === offset) {
        this.offset$.set(undefined);
        window.dispatchEvent(new CustomEvent('pinned', { detail: false }));
      } else {
        this.offset$.set(offset);
        window.dispatchEvent(new CustomEvent('pinned', { detail: true }));
      }
    }));

    const style = this._register(styleMod.derive('selected-commit'));
    this._register(this.root.git.snapshot$.subscribe(snapshot => {
      style.set({
        [`:where(.commit:has([data-key="${snapshot ? snapshotId(snapshot) : '-'}"]))`]: {
          background: 'var(--selected)',
          color: 'var(--accent)',
        }
      });
    }));
  }

  accept(index?: number): void {
    if (index != null) {
      this.offset$.set(undefined);
      window.dispatchEvent(new CustomEvent('pinned', { detail: false }));
      this.root.git.index$.set(index);
      this.scrollable.reveal(index);
    }
    this.root.files.focus();
  }

  focus(): void {
    this.scrollable.focus(this.root.git.index$.value);
  }

  override layout(): void {
  }

  renderTemplate(dom: HTMLDivElement): HTMLDivElement & Template {
    dom.className = 'commit';
    const $tracks = appendChild(dom, $('.tracks'));
    return Object.assign(dom, { $tracks }, createCommitContent(dom));
  }

  renderItem(template: Template, item: Item): DisposableType<void> {
    if (item !== PlaceHolder) {
      _renderTracks(template.$tracks, item.tracks);
      renderCommitContent(template, item.snapshot);
      if (item.snapshot.kind === SnapshotKind.Commit) {
        return this.root.git.shortStat(item.snapshot, stat => renderCommitStat(template.$changes, stat));
      }
    } else {
      clearElement(template.$tracks);
      renderCommitContent(template, undefined);
    }
    return noop;
  }
}

function _renderTracks($tracks: HTMLElement, tracks: readonly (GraphTrack | null)[]): void {
  clearElement($tracks);
  let columns = tracks.length;
  for (const track of tracks) {
    if (!track) continue;
    for (const edge of track.outgoing) columns = Math.max(columns, edge.column + 1);
  }
  const width = columns * 12;
  $tracks.style.width = `${width}px`;
  const $svg = appendChild($tracks, svgElement('svg'));
  $svg.setAttribute('width', String(width));
  $svg.setAttribute('height', String(ITEM_HEIGHT));
  $svg.setAttribute('viewBox', `0 0 ${width} ${ITEM_HEIGHT}`);
  $svg.setAttribute('fill', 'none');

  const middle = ITEM_HEIGHT / 2, quarter = ITEM_HEIGHT / 4;
  for (const track of tracks) {
    if (!track) continue;
    const x = track.depth * 12 + 6;
    for (const edge of track.incoming) {
      const start = edge.column * 12 + 6;
      const $path = appendChild($svg, svgElement('path'));
      $path.setAttribute('d', `M${start} 0 C${start} ${quarter}, ${x} ${quarter}, ${x} ${middle}`);
      $path.setAttribute('stroke', `var(--track-${edge.column % MAX_TRACKS})`);
      if (edge.dashed) $path.setAttribute('stroke-dasharray', '4');
    }
    for (const edge of track.outgoing) {
      const end = edge.column * 12 + 6;
      const $path = appendChild($svg, svgElement('path'));
      $path.setAttribute('d', `M${x} ${middle} C${x} ${middle + quarter}, ${end} ${middle + quarter}, ${end} ${ITEM_HEIGHT}`);
      $path.setAttribute('stroke', `var(--track-${edge.column % MAX_TRACKS})`);
      if (edge.dashed) $path.setAttribute('stroke-dasharray', '4');
    }
  }
  for (const track of tracks) {
    if (!track?.active) continue;
    const $circle = appendChild($svg, svgElement('circle'));
    $circle.setAttribute('cx', String(track.depth * 12 + 6));
    $circle.setAttribute('cy', String(ITEM_HEIGHT / 2));
    $circle.setAttribute('r', '4');
    $circle.setAttribute('fill', `var(--track-${track.depth % MAX_TRACKS})`);
  }
}
