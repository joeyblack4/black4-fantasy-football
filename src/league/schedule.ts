/** Deterministic circle schedule, one appearance/team/round and each pair once. */
export function roundRobin(teamIds: readonly string[]) {
  if (
    teamIds.length < 2 ||
    teamIds.length > 100 ||
    teamIds.length % 2 ||
    new Set(teamIds).size !== teamIds.length ||
    teamIds.some((id) => !id)
  )
    throw new Error("An even number of unique teams is required");
  const rotation = [...teamIds];
  const rounds: { homeTeamId: string; awayTeamId: string }[][] = [];
  for (let round = 0; round < teamIds.length - 1; round++) {
    const games = [];
    for (let i = 0; i < teamIds.length / 2; i++) {
      const a = rotation[i]!,
        b = rotation[rotation.length - 1 - i]!;
      games.push(
        round % 2
          ? { homeTeamId: b, awayTeamId: a }
          : { homeTeamId: a, awayTeamId: b },
      );
    }
    rounds.push(games);
    rotation.splice(1, 0, rotation.pop()!);
  }
  return rounds;
}

/** Extend the circle deterministically; extra cycles reverse home/away. No random or model choice is hidden here. */
export function regularSeasonSchedule(teamIds: readonly string[], weeks = 14) {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 17)
    throw new Error("Regular season must contain one to seventeen weeks");
  const rounds = roundRobin(teamIds);
  return Array.from({ length: weeks }, (_, i) => ({
    week: i + 1,
    matchups: rounds[i % rounds.length]!.map((m) =>
      Math.floor(i / rounds.length) % 2
        ? { homeTeamId: m.awayTeamId, awayTeamId: m.homeTeamId }
        : { ...m },
    ),
  }));
}
