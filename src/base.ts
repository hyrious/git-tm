
export const MAX_TRACKS = 6;
export const STEP = 50;

export type Writable<T> = { -readonly [P in keyof T]: T[P] };

export const DeleteItem = Symbol('delete');
export type DeleteItem = typeof DeleteItem;

export function inertFilterMap<T, U = T>(
  array: readonly T[],
  callback: (value: T, index: number, array: readonly T[]) => U | DeleteItem,
  thisArg?: any,
): U[] {
  let result: U[] | undefined;

  const len = array.length;
  for (let i = 0; i < len; i++) {
    const newItem = callback.call(thisArg, array[i], i, array);
    if (newItem === DeleteItem || !Object.is(newItem, array[i])) {
      result ??= array.slice(0, i) as unknown as U[];
    }
    if (newItem !== DeleteItem) {
      result?.push(newItem);
    }
  }

  return result || (array as unknown as U[]);
}
