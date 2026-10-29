// Scoring follows ../fuzzy-match (fts_fuzzy_match, public domain).
// Dynamic programming keeps repeated characters from causing exponential work.
export function fuzzyScore(pattern: string, text: string, positions?: number[]): number {
  if (positions) positions.length = 0;
  if (!pattern) return 100;
  if (pattern.length > text.length) return -Infinity;
  // Reject non-matches before allocating the scoring tables.
  let matched = 0;
  for (let i = 0; i < text.length && matched < pattern.length; i++) {
    if (pattern[matched].toUpperCase() === text[i].toUpperCase()) matched++;
  }
  if (matched < pattern.length) return -Infinity;
  let previous = new Float64Array(text.length).fill(-Infinity);
  const trace: Int32Array[] = [];
  for (let p = 0; p < pattern.length; p++) {
    const current = new Float64Array(text.length).fill(-Infinity);
    const parents = positions ? new Int32Array(text.length).fill(-1) : undefined;
    let best = -Infinity, bestIndex = -1;
    for (let i = 0; i < text.length; i++) {
      if (i > 0 && previous[i - 1] > best) {
        best = previous[i - 1];
        bestIndex = i - 1;
      }
      if (pattern[p].toUpperCase() !== text[i].toUpperCase()) continue;
      let bonus = 0;
      if (i > 0) {
        if (/[A-Z]/.test(text[i]) && /[a-z]/.test(text[i - 1])) bonus += 30;
        if (/[a-zA-Z0-9]/.test(text[i]) && !/[a-zA-Z0-9]/.test(text[i - 1])) bonus += 30;
      }
      current[i] = p === 0
        ? (i === 0 ? 15 : bonus + Math.max(-5 * i, -15))
        : bonus + Math.max(best, i > 0 ? previous[i - 1] + 15 : -Infinity);
      if (parents && p > 0) parents[i] = i > 0 && previous[i - 1] + 15 >= best ? i - 1 : bestIndex;
    }
    if (parents) trace.push(parents);
    previous = current;
  }
  let best = -Infinity, bestIndex = -1;
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] > best) { best = previous[i]; bestIndex = i; }
  }
  if (positions && bestIndex >= 0) {
    for (let p = pattern.length - 1; p >= 0; p--) {
      positions.push(bestIndex);
      bestIndex = trace[p][bestIndex];
    }
    positions.reverse();
  }
  return 100 - (text.length - pattern.length) + best;
}

export function searchPattern(input: string): RegExp {
  const regexp = /^\/([\s\S]*)\/(i?)$/.exec(input);
  if (regexp) return new RegExp(regexp[1], `gu${regexp[2]}`);
  const sensitive = input !== input.toLowerCase();
  return new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu');
}

// Follow VS Code's search preview: keep about 26 characters at a word boundary.
export function searchPrefix(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.length < 26) return trimmed;
  const boundary = /\b/g;
  let start = 0;
  while (boundary.test(trimmed)) {
    if (trimmed.length - boundary.lastIndex < 26) break;
    start = boundary.lastIndex;
    boundary.lastIndex++;
  }
  return start ? '…' + trimmed.slice(start).trimStart() : trimmed;
}

export interface TextMatch {
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

// Yield on unmatched lines too, so callers can interrupt sparse searches.
export function* textMatches(lines: Iterable<string>, pattern: RegExp): Generator<TextMatch | undefined> {
  let offset = 0, line = 0;
  for (const text of lines) {
    line++;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const from = match.index, to = from + match[0].length;
      const start = Math.max(0, from - 60), end = Math.min(text.length, Math.max(to, from + 160));
      yield {
        from: offset + from, to: offset + to, line, column: from + 1,
        text: text.slice(start, Math.min(end, start + 300)), start: from - start, end: Math.min(to - start, 300),
        prefix: searchPrefix(text.slice(0, from))
      };
      if (!match[0].length) {
        const code = text.codePointAt(pattern.lastIndex);
        pattern.lastIndex += code != null && code > 0xFFFF ? 2 : 1;
      }
    }
    offset += text.length + 1;
    yield undefined;
  }
}

export function* textLines(text: string): Generator<string> {
  // CodeMirror normalizes all line endings to a single document position.
  const newline = /\r\n?|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = newline.exec(text))) {
    yield text.slice(start, match.index);
    start = newline.lastIndex;
  }
  yield text.slice(start);
}
