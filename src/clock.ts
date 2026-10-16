/** Epoch milliseconds. Every module takes the clock as an argument: nothing here reads Date.now on its own. */
export type Clock = () => number;

/** A time claim with its derivation: the reading it was computed at. No reader infers elapsed time from anything else. */
export interface Derived<T> {
  value: T;
  /** The clock reading (epoch ms) the value was computed at. */
  at: number;
}
