import { expect, it } from "vitest";
import {
  addCalendarWallWeeks,
  expandCalendarOccurrences,
} from "../src/mfl/calendar-occurrences.js";
it("expands seventeen following weeks into eighteen dates and preserves five AM Eastern through DST", () => {
  const result = expandCalendarOccurrences([
    {
      id: "bbid",
      type: "WAIVER_BBID",
      startsAt: "2026-09-10T09:00:00Z",
      timingStatus: "timestamp",
      repeatsFollowingWeeks: 17,
    },
  ]);
  expect(result).toHaveLength(18);
  expect(result[0]).toMatchObject({
    id: "bbid",
    schedulerEventId: "mfl-calendar:bbid",
    derived: false,
    startsAt: "2026-09-10T09:00:00Z",
  });
  expect(result.find((x) => x.id === "bbid:2026-10-29")?.startsAt).toBe(
    "2026-10-29T09:00:00.000Z",
  );
  expect(result.find((x) => x.id === "bbid:2026-11-05")?.startsAt).toBe(
    "2026-11-05T10:00:00.000Z",
  );
  expect(result.at(-1)?.startsAt).toBe("2027-01-07T10:00:00.000Z");
  expect(expandCalendarOccurrences(result)).toEqual(result);
});
it("handles the November first transition by walltime and leaves nonexistent spring times unresolved", () => {
  expect(addCalendarWallWeeks("2026-10-25T09:00:00Z", 1)).toBe(
    "2026-11-01T10:00:00.000Z",
  );
  expect(addCalendarWallWeeks("2026-03-01T07:30:00Z", 1)).toBeNull();
});
it("does not invent a date from a week number or an unsupported repeat count", () => {
  const result = expandCalendarOccurrences([
    {
      id: "trade",
      startsAt: null,
      rawStart: "11",
      timingStatus: "unresolved-host-value",
      repeatsFollowingWeeks: 17,
    },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0].startsAt).toBeNull();
  expect(
    expandCalendarOccurrences([
      {
        id: "bad",
        startsAt: "2026-09-10T09:00:00Z",
        timingStatus: "timestamp",
        repeatsFollowingWeeks: 10000,
      },
    ]),
  ).toHaveLength(1);
});
