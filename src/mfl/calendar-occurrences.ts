/** MFL's `happens` counts FOLLOWING weeks. Preserve New York wall time, not a fixed UTC offset. */
export type CalendarSourceEvent = {
  id: string;
  startsAt: string | null;
  endsAt?: string | null;
  repeatsFollowingWeeks?: number | null;
  timingStatus?: string;
  [key: string]: unknown;
};
const zone = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function parts(time: number) {
  const p = Object.fromEntries(
    formatter
      .formatToParts(new Date(time))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}
function stamp(p: ReturnType<typeof parts>) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
/** Ambiguous fall-back times select their first occurrence; nonexistent spring times stay unresolved. */
export function addCalendarWallWeeks(
  iso: string,
  weeks: number,
): string | null {
  if (
    !Number.isInteger(weeks) ||
    weeks < 0 ||
    weeks > 52 ||
    !Number.isFinite(Date.parse(iso))
  )
    return null;
  if (weeks === 0) return new Date(iso).toISOString();
  const original = parts(Date.parse(iso));
  const wall = new Date(stamp(original));
  wall.setUTCDate(wall.getUTCDate() + 7 * weeks);
  const expected = wall.getTime();
  let guess = expected;
  for (let n = 0; n < 4; n++) guess += expected - stamp(parts(guess));
  const candidates = [guess - 3600000, guess, guess + 3600000]
    .filter((value) => stamp(parts(value)) === expected)
    .sort((a, b) => a - b);
  return candidates.length ? new Date(candidates[0]!).toISOString() : null;
}
export function expandCalendarOccurrences<T extends CalendarSourceEvent>(
  events: T[],
) {
  return events.flatMap((event) => {
    // Already expanded read data is accepted by the collector without expanding it twice.
    if (typeof event.schedulerEventId === "string") return [event];
    const count = event.repeatsFollowingWeeks ?? 0;
    const supported = Number.isInteger(count) && count >= 0 && count <= 52;
    const base = {
      ...event,
      schedulerEventId: `mfl-calendar:${event.id}`,
      recurrenceBaseId: event.id,
      recurrenceIndex: 0,
      timezone: zone,
      derived: false,
      recurrenceStatus: supported
        ? "expanded-following-weeks"
        : "unsupported-repeat-count",
    };
    if (!supported || !event.startsAt || event.timingStatus !== "timestamp")
      return [base];
    const occurrences: Array<T | typeof base> = [base];
    for (let index = 1; index <= count; index++) {
      const date = new Date(stamp(parts(Date.parse(event.startsAt))));
      date.setUTCDate(date.getUTCDate() + 7 * index);
      const localDate = date.toISOString().slice(0, 10);
      const startsAt = addCalendarWallWeeks(event.startsAt, index);
      const endsAt = event.endsAt
        ? addCalendarWallWeeks(event.endsAt, index)
        : event.endsAt;
      const id = `${event.id}:${localDate}`;
      occurrences.push({
        ...base,
        id,
        schedulerEventId: `mfl-calendar:${id}`,
        startsAt,
        endsAt: endsAt ?? null,
        recurrenceIndex: index,
        derived: true,
        timingStatus: startsAt
          ? "timestamp"
          : "unresolved-recurring-local-time",
      });
    }
    return occurrences;
  });
}
