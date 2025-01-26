import type { DisposableType } from '@wopjs/disposable';
import { clamp, MAX_TRACKS, type Writable } from '../base';
import type { Commit, CommitShortStat, Ref, RefType } from '../repository';

import { noop } from '@wopjs/cast';
import { appendChild, svgElement } from '@wopjs/dom';
import { subscribe, val, type ReadonlyVal } from 'value-enhancer';
import { reactiveList, type ReactiveList } from 'value-enhancer/collections';
import { styleMod } from './css';
import { $, clearElement, onCustomEvent } from './dom';
import { Scrollable, type ItemRenderer } from './scrollable';
import { Widget } from './widget';

type Track = {
  readonly visible: 0 | 1 | 2;
  readonly depth: number;
  readonly incomming: readonly number[];
  readonly outgoing: readonly number[];
  readonly active: boolean;
};

type WritableTrack = {
  visible: 0 | 1 | 2;
  depth: number;
  incomming: number[];
  outgoing: number[];
  active: boolean;
};

const PlaceHolder = Symbol.for('PlaceHolder');
type PlaceHolder = typeof PlaceHolder;

type Item = {
  readonly index: number;
  readonly commit: Commit;
  readonly tracks: readonly (Track | null)[];
} | PlaceHolder;

type Template = {
  readonly $tracks: HTMLElement;
  readonly $message: HTMLElement;
  readonly $changes: HTMLElement;
  readonly $author: HTMLElement;
  readonly $date: HTMLElement;
  readonly $refs: HTMLElement;
};

export class Commits extends Widget implements ItemRenderer<Item, Template> {
  readonly $container: HTMLElement;

  readonly scrollable: Scrollable<Item, Template>;
  readonly items: ReactiveList<Item>;
  readonly head: Ref | undefined;

  readonly offset$ = val<number | undefined>(); // index = range.start + offset

  override async initialize(this: Writable<this>): Promise<void> {
    this.head = this.root.git.refs.find(e => e.type === 0 as RefType.Head);

    this.$container = appendChild(this.parent, $('.commits'));

    const items = this.items = this._register(reactiveList<Item>());
    this.scrollable = new Scrollable({
      container: this.$container,
      itemHeight: 48,
      items$: items.$,
      renderer: this,
    });
    this._register(onCustomEvent('scroll-to', e => this.scrollable.scrollTo(e.detail as number)));

    this._register(subscribe(this.scrollable.visibleRange$, range => {
      this.root.git.touch(range.end);
      if (this.offset$.value != null) {
        const target = range.start + this.offset$.value;
        this.root.git.index$.set(clamp(target, 0, items.length - 1));
        // this.scrollable.focus(target);
      }
    }));

    let firstTrackInvisible = true;
    let i = 0, currentTracks: (string | null)[] = [this.head?.commit || null]; // Outgoing lines, each stores its parent hash.
    this._register(subscribe(this.root.git.commits.$, commits => {
      if (items.length < commits.length) {
        items.replace(items.array.concat(Array(commits.length - items.length).fill(PlaceHolder)));
      }

      for (; commits[i]; i++) {
        const commit = commits[i]!;
        const tracks: (WritableTrack | null)[] = [];

        const nextTracks: (string | null)[] = [];
        let merged: WritableTrack | undefined; // Only one merge item could be created for each commit.
        let k = 0; // Access to commit.parents.
        for (let j = 0; j < currentTracks.length; j++) {
          const parent = currentTracks[j];
          if (parent) {
            if (parent === commit.hash) {
              if (!merged) {
                const out = nextTracks[j] = commit.parents[k++] || null;
                if (j === 0 && firstTrackInvisible) {
                  firstTrackInvisible = false;
                  merged = { visible: 1, depth: j, incomming: [j], outgoing: out ? [j] : [], active: true };
                } else {
                  merged = { visible: firstTrackInvisible ? 0 : 2, depth: j, incomming: [j], outgoing: out ? [j] : [], active: true };
                }
                tracks[j] = merged;
              } else {
                nextTracks[j] = null;
                merged.incomming.push(j);
              }
            } else {
              nextTracks[j] = parent;
              tracks[j] = { visible: j === 0 && firstTrackInvisible ? 0 : 2, depth: j, incomming: [j], outgoing: [j], active: false };
            }
          } else {
            nextTracks[j] = null;
          }
        }
        while (commit.parents[k]) {
          let exist = currentTracks.indexOf(commit.parents[k]);
          if (exist >= 0) {
            merged?.outgoing.push(exist);
            nextTracks[exist] = commit.parents[k++];
          } else {
            let index = nextTracks.indexOf(null);
            if (index < 0) index = nextTracks.length;
            nextTracks[index] = commit.parents[k++];
            if (merged) {
              merged.outgoing.push(index);
            } else {
              merged = tracks[index] = { visible: 2, depth: index, incomming: [], outgoing: [index], active: true };
            }
          }
        }
        currentTracks = nextTracks;

        items.set(i, { index: i, commit, tracks });
      }
    }));

    this._register(this.scrollable.onClick(index => this.root.git.index$.set(index)));
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
    this._register(this.root.git.commit$.subscribe(commit => {
      style.set({
        [`:where(.commit:has([data-key="${commit?.hash || '-'}"]))`]: {
          background: 'var(--selected)',
          color: 'var(--accent)',
        }
      });
    }));
  }

  override layout(): void {
  }

  renderTemplate(dom: HTMLDivElement): HTMLDivElement & Template {
    dom.className = 'commit';
    const $tracks = appendChild(dom, $('.tracks'));
    const $content = appendChild(dom, $('.commit-content'));
    const $messageWrapper = appendChild($content, $('.message-wrapper'));
    const $message = appendChild($messageWrapper, $('.message'));
    const $changes = appendChild($messageWrapper, $('.changes'));
    const $footer = appendChild($content, $('.footer'));
    const $author = appendChild($footer, $('.author'));
    const $date = appendChild($footer, $('.date'));
    const $refs = appendChild($footer, $('.refs'));
    return Object.assign(dom, { $tracks, $message, $changes, $author, $date, $refs });
  }

  renderItem({ $tracks, $message, $changes, $author, $date, $refs }: Template, item: Item): DisposableType<void> {
    if (item !== PlaceHolder) {
      const { tracks, commit } = item;
      _renderTracks($tracks, tracks);
      $message.dataset.key = commit.hash;
      const end = commit.message.indexOf('\n');
      $message.textContent = commit.message.slice(0, end >= 0 ? end : undefined);
      $message.title = commit.message;
      $changes.textContent = _renderChanges(commit.shortStat);
      $author.textContent = commit.authorName || null;
      $author.title = commit.authorEmail || '';
      $date.textContent = _renderDate(commit.authorDate);
      $date.title = `Commit:\t${commit.commitDate}\nAuthor:\t${commit.authorDate}`;
      _renderRefs($refs, commit.refNames);
    } else {
      clearElement($tracks);
      $message.textContent = '';
      $changes.textContent = '';
      $author.textContent = '';
      $date.textContent = '';
      clearElement($refs);
    }
    return noop;
  }
}

function _renderTracks($tracks: HTMLElement, tracks: readonly (Track | null)[]): void {
  clearElement($tracks);
  let maxDepth = tracks.length - 1;
  for (const track of tracks) {
    if (!track) continue;
    if (maxDepth < track.depth) maxDepth = track.depth;
    for (const incomming of track.incomming) {
      if (maxDepth < incomming) maxDepth = incomming;
    }
    for (const outgoing of track.outgoing) {
      if (maxDepth < outgoing) maxDepth = outgoing;
    }
  }
  $tracks.style.width = `${(maxDepth + 1) * 12}px`;
  for (const track of tracks) {
    const $track = appendChild($tracks, $('.track'));
    track && _renderTrack($track, track, maxDepth);
  }
}

function _renderTrack($track: HTMLElement, { visible, depth, incomming, outgoing, active }: Track, maxDepth: number): void {
  const maxWidth = (maxDepth + 1) * 12;
  const svg = appendChild($track, svgElement('svg'));
  svg.setAttribute('width', `${maxWidth}`);
  svg.setAttribute('height', '50');
  svg.setAttribute('viewBox', `${-depth * 12} 0 ${maxWidth} 50`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'var(--track)');
  svg.setAttribute('style', `margin-left: ${-depth * 12}px`);

  const mid = 6;
  for (const i of incomming) {
    const path = appendChild(svg, svgElement('path'));
    const start = (i - depth) * 12 + 6;
    // Bezier from (start, 0) to (mid, 25).
    path.setAttribute('d', `M${start} 0 C${start} 12, ${mid} 13, ${mid} 25`);
    path.setAttribute('stroke', `var(--track-${i % MAX_TRACKS})`);
    if (i === 0 && visible < 2) path.setAttribute('stroke-dasharray', '4');
  }
  for (const i of outgoing) {
    const path = appendChild(svg, svgElement('path'));
    const end = (i - depth) * 12 + 6;
    // Bezier from (mid, 25) to (end, 50).
    path.setAttribute('d', `M${mid} 25 C${mid} 37, ${end} 38, ${end} 50`);
    path.setAttribute('stroke', `var(--track-${i % MAX_TRACKS})`);
    if (!visible) path.setAttribute('stroke-dasharray', '4');
  }

  if (visible && active) {
    const circle = appendChild(svg, svgElement('circle'));
    circle.setAttribute('cx', `${mid}`);
    circle.setAttribute('cy', '25');
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', `var(--track-${depth % MAX_TRACKS})`);
    circle.setAttribute('stroke', 'none');
  }
}

function _renderRefs($refs: HTMLElement, refNames: readonly string[]): void {
  clearElement($refs);
  for (let refName of refNames) {
    if (refName === 'origin/HEAD') continue;
    let head = refName.startsWith('HEAD -> ');
    if (head) {
      refName = refName.slice(7);
    }
    let tag = refName.startsWith('tag: ');
    if (tag) {
      refName = refName.slice(5);
    }
    const $ref = appendChild($refs, $('.ref'));
    $ref.textContent = refName;
    if (head) {
      $ref.classList.add('head');
    }
    if (tag) {
      $ref.classList.add('tag');
    }
  }
}

function _renderChanges(stat: CommitShortStat | undefined): string | null {
  const n = stat?.files;
  return n && n > 1 ? String(n) : null;
}

function _renderDate(date: Date | undefined): string | null {
  if (!date) return null;

  const _2 = (n: number) => n < 10 ? `0${n}` : n;

  const day = `${date.getFullYear()}-${_2(date.getMonth() + 1)}-${_2(date.getDate())}`;
  const now = new Date();
  const dayNow = `${now.getFullYear()}-${_2(now.getMonth() + 1)}-${_2(now.getDate())}`;

  const time = `${_2(date.getHours())}:${_2(date.getMinutes())}`;
  return day === dayNow ? time : `${day} ${time}`;
}
