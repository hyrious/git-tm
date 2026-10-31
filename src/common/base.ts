export const MAX_TRACKS = 6;
export const STEP = 50;

export type Writable<T> = { -readonly [P in keyof T]: T[P] };

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const textDecoder = new TextDecoder();

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes).replace(/\r\n?/g, '\n');
}
