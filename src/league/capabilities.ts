import { statNames } from "../data/index.js";
/** Version identifies implemented behavior, never verified vendor field coverage. */
export const leagueCapabilityVersion = "2026-09-07.v2";
export const leagueCapabilities = {
  version: leagueCapabilityVersion,
  field: { teams: 12, aiOwners: 10, humanOwners: 2 },
  draft: {
    orders: ["snake", "linear"],
    rosterSize: { min: 1, max: 16 },
    pickSeconds: { min: 1, max: 600 },
    commissionerPauseResume: true,
    queueExhaustion: "pause-with-receipt",
    rankFallback: false,
  },
  roster: {
    positions: ["QB", "RB", "WR", "TE", "K", "DST"],
    customEligibleSlots: true,
    playerKickoffLocks: true,
    byeRecords: true,
    injuredReserve: false,
  },
  acquisitions: {
    faab: true,
    tiebreak: "fixed-reverse-draft-order",
    freeAgents: ["waiversOnly", "scheduledFirstCome"],
    droppedPlayerHoldHours: { min: 0, max: 168 },
    tradeDeadline: "optional-fixed-UTC-time",
    atomicTrades: true,
  },
  scoring: {
    formula: "integer-millipoints-per-unit-and-optional-defense-tiers",
    supportedStatNames: statNames,
    sourceCoverage: "unverified-until-authenticated-fixture",
    corrections: "latest-verified-revision-replaces-prior",
  },
  governance: {
    votesRequired: 8,
    electorate: 12,
    immutableProposals: true,
    independentWindow: true,
    commissionerFinalRatification: true,
  },
  scheduling: {
    weeklyMatchupConfiguration: true,
    regularSeasonCircleSchedule: true,
    regularSeasonWeeks: { min: 1, max: 17 },
    algorithm: "circle-repeat-v1",
    postseasonBracket: false,
  },
  unsupported: [
    "injured-reserve-slots",
    "keeper-rules",
    "salary-contracts",
    "auction-draft",
    "automatic-playoff-bracket",
  ],
} as const;
