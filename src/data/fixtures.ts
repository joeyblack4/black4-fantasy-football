import {
  type StatSnapshot,
  type Stats,
  statNames,
  type FeedAdapter,
} from "./index.js";
/** Entirely invented test data; no player identity or sports result is real. */
export const syntheticCompleteStats: Stats = Object.fromEntries(
  statNames.map((key) => [key, 0]),
);
export const syntheticReceiver: StatSnapshot = {
  feedId: "synthetic-fixture-v1",
  gameId: "SYNTHETIC-GAME-1",
  playerId: "SYNTHETIC-WR-1",
  revision: 1,
  sourceAt: "2026-09-01T00:00:00.000Z",
  gameStatus: "live",
  synthetic: true,
  stats: {
    ...syntheticCompleteStats,
    receivingYards: 85,
    receptions: 6,
    receivingTouchdowns: 1,
  },
};
export class SyntheticFeed implements FeedAdapter {
  readonly id = "synthetic-fixture-v1";
  readonly synthetic = true;
  async fetchSnapshots(): Promise<StatSnapshot[]> {
    return [structuredClone(syntheticReceiver)];
  }
}
