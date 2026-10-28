import { snapshotId, type CommitShortStat, type Snapshot, type WorkingTree } from '../common/git';
import { appendChild } from '@wopjs/dom';
import { $, clearElement } from './dom';

export interface CommitContent {
  readonly $message: HTMLElement;
  readonly $changes: HTMLElement;
  readonly $author: HTMLElement;
  readonly $date: HTMLElement;
  readonly $refs: HTMLElement;
}

export function createCommitContent(dom: HTMLElement): CommitContent {
  const $content = appendChild(dom, $('.commit-content'));
  const $messageWrapper = appendChild($content, $('.message-wrapper'));
  const $message = appendChild($messageWrapper, $('.message'));
  const $changes = appendChild($messageWrapper, $('.changes'));
  const $footer = appendChild($content, $('.footer'));
  const $author = appendChild($footer, $('.author'));
  const $date = appendChild($footer, $('.date'));
  const $refs = appendChild($footer, $('.refs'));
  return { $message, $changes, $author, $date, $refs };
}

export function renderCommitContent({ $message, $changes, $author, $date, $refs }: CommitContent, snapshot: Snapshot | undefined, refs = true): void {
  if (snapshot) {
    $message.dataset.key = snapshotId(snapshot);
    if (snapshot.kind === 'working-tree') {
      $message.textContent = 'Working Directory';
      $message.title = 'Working Directory';
      $changes.textContent = '';
      $author.textContent = _renderWorkingTree(snapshot);
      $author.title = $author.textContent;
      $date.textContent = '';
      $date.title = '';
      clearElement($refs);
    } else {
      const end = snapshot.message.indexOf('\n');
      $message.textContent = snapshot.message.slice(0, end >= 0 ? end : undefined);
      $message.title = snapshot.message;
      $changes.textContent = _renderChanges(snapshot.shortStat);
      $author.textContent = snapshot.authorName || null;
      $author.title = snapshot.authorEmail || '';
      $date.textContent = _renderDate(snapshot.authorDate);
      $date.title = `Commit:\t${snapshot.commitDate}\nAuthor:\t${snapshot.authorDate}`;
      _renderRefs($refs, refs ? snapshot.refNames : []);
    }
  } else {
    delete $message.dataset.key;
    $message.textContent = '';
    $message.title = '';
    $author.title = '';
    $date.title = '';
    $changes.textContent = '';
    $author.textContent = '';
    $date.textContent = '';
    clearElement($refs);
  }
}

function _renderWorkingTree(snapshot: WorkingTree): string {
  const parts: string[] = [];
  if (snapshot.staged) parts.push(`${snapshot.staged} staged`);
  if (snapshot.unstaged) parts.push(`${snapshot.unstaged} unstaged`);
  if (snapshot.untracked) parts.push(`${snapshot.untracked} untracked`);
  return parts.join(', ') || 'No commits yet';
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
