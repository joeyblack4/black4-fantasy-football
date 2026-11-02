/** Read-only infrastructure alarms. Age never authorizes replay or completion. */
export function nativeScheduleHealth(input: {
  now: Date;
  power: "ac" | "battery" | "unknown" | "not-applicable";
  dispatcher: { status: string; observed_at: string | Date } | null;
  overdueAppointments: {
    id: string;
    team_id: string;
    next_due_at: string | Date;
  }[];
  activeOccurrences: {
    id: string;
    team_id: string;
    status: string;
    scheduled_for: string | Date;
    delivered_at: string | Date | null;
    started_at: string | Date | null;
  }[];
}) {
  const alerts: { code: string; id?: string; teamId?: string }[] = [];
  const age = (at: string | Date) =>
    input.now.getTime() - new Date(at).getTime();
  if (input.power === "battery" || input.power === "unknown")
    alerts.push({
      code:
        input.power === "battery" ? "HOST_ON_BATTERY" : "HOST_POWER_UNKNOWN",
    });
  if (!input.dispatcher || input.dispatcher.status !== "healthy")
    alerts.push({ code: "DISPATCHER_UNHEALTHY" });
  else if (
    !Number.isFinite(age(input.dispatcher.observed_at)) ||
    age(input.dispatcher.observed_at) > 120_000
  )
    alerts.push({ code: "DISPATCHER_STALE" });
  for (const row of input.overdueAppointments) {
    if (age(row.next_due_at) > 60_000)
      alerts.push({
        code: "APPOINTMENT_OVERDUE",
        id: row.id,
        teamId: row.team_id,
      });
  }
  for (const row of input.activeOccurrences) {
    if (row.status === "uncertain")
      alerts.push({
        code: "DELIVERY_UNCERTAIN",
        id: row.id,
        teamId: row.team_id,
      });
    else if (!row.delivered_at && age(row.scheduled_for) > 60_000)
      alerts.push({
        code: "OCCURRENCE_UNDELIVERED",
        id: row.id,
        teamId: row.team_id,
      });
    else if (
      row.delivered_at &&
      age(row.started_at ?? row.delivered_at) > 900_000
    )
      alerts.push({
        code: "NATIVE_EXECUTION_STALLED",
        id: row.id,
        teamId: row.team_id,
      });
  }
  return { healthy: alerts.length === 0, alerts };
}
