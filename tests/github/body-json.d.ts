// The ported tests read JSON responses loosely, as they did with the DOM
// typings in hierarchidb, where `Body.json()` returns `Promise<any>`.
declare global {
  interface Body {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json<T = any>(): Promise<T>;
  }
}
export {};
