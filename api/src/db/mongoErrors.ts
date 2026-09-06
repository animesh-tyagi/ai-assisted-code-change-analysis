/** True for a MongoDB duplicate-key error (E11000) on any unique index. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}
