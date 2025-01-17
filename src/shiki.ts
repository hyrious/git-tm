import type { Writable } from './base';

import path from 'node:path';
import { codeToHtml, bundledThemes, type BundledTheme } from 'shiki';

const DARK: BundledTheme = 'github-dark';
const LIGHT: BundledTheme = 'github-light';

// XXX: support pagination?
export async function highlight(code: string, filename: string): Promise<string> {
  const lang = path.parse(filename).ext.slice(1);
  return codeToHtml(code, {
    lang: custom(lang, filename),
    themes: { dark: DARK, light: LIGHT },
    defaultColor: false,
  });
}

function custom(lang: string, filename: string): string {
  if (lang === 'svg') return 'xml';
  if (filename.endsWith('.prettierrc')) return 'json';
  if (filename.endsWith('.mjs')) return 'js';
  return lang;
}

export interface ColorTable {
  readonly bluish: string;
  readonly purplish: string;
  readonly pinkish: string;
  readonly redish: string;
  readonly orangish: string;
  readonly yellowish: string;
  readonly greenish: string;
  readonly cyanish: string;
}

const BASELINE_COLORS: Record<keyof ColorTable, [r: number, g: number, b: number]> = {
  bluish: [0, 0, 255],
  purplish: [128, 0, 255],
  pinkish: [255, 0, 255],
  redish: [255, 0, 0],
  orangish: [255, 128, 0],
  yellowish: [255, 255, 0],
  greenish: [0, 255, 0],
  cyanish: [0, 255, 255],
};

export interface ThemeColorTable {
  readonly light: ColorTable,
  readonly dark: ColorTable;
}

export async function getColors(): Promise<ThemeColorTable> {
  const { default: light } = await bundledThemes[LIGHT]();
  const { default: dark } = await bundledThemes[DARK]();
  return { light: _extract(light.colors!), dark: _extract(dark.colors!) };
}

function _extract(colors: Record<string, string>): ColorTable {
  const hexColors = Object.values(colors)
    .filter(color => color.startsWith('#'))
    .map(color => color.toLowerCase().slice(0, 7));
  const result: Partial<Writable<ColorTable>> = {};
  for (const hex of hexColors) {
    result.bluish = _closestColor(hex, BASELINE_COLORS.bluish, result.bluish);
    result.purplish = _closestColor(hex, BASELINE_COLORS.purplish, result.purplish);
    result.pinkish = _closestColor(hex, BASELINE_COLORS.pinkish, result.pinkish);
    result.redish = _closestColor(hex, BASELINE_COLORS.redish, result.redish);
    result.orangish = _closestColor(hex, BASELINE_COLORS.orangish, result.orangish);
    result.yellowish = _closestColor(hex, BASELINE_COLORS.yellowish, result.yellowish);
    result.greenish = _closestColor(hex, BASELINE_COLORS.greenish, result.greenish);
    result.cyanish = _closestColor(hex, BASELINE_COLORS.cyanish, result.cyanish);
  }
  return result as ColorTable;
}

function _closestColor(hex: string, baseline: [r: number, g: number, b: number], current: string | undefined): string {
  if (!current) return hex;
  const currentDistance = _colorDistance(current, baseline);
  const newDistance = _colorDistance(hex, baseline);
  if (newDistance < currentDistance) return hex;
  return current;
}

function _colorDistance(hex: string, [r, g, b]: [r: number, g: number, b: number]): number {
  const [r1, g1, b1] = _hexToRgb(hex);
  return Math.hypot(r1 - r, g1 - g, b1 - b);
}

function _hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}
