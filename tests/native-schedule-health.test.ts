import { describe, expect, it } from "vitest";
import { nativeScheduleHealth } from "../src/runtime/native-schedule-health.js";

const now = new Date("2026-11-02T06:00:00Z");
const healthy = {
  now,
  power: "ac" as const,
  dispatcher: { status: "healthy", observed_at: now },
  overdueAppointments: [],
  activeOccurrences: [],
};
describe("native scheduler infrastructure health", () => {
  it("detects a sleeping host even when no occurrence was materialized", () => {
    const result = nativeScheduleHealth({
      ...healthy,
      dispatcher: { status: "healthy", observed_at: "2026-10-31T12:01:39Z" },
      overdueAppointments: [
        { id: "sunday", team_id: "qwen", next_due_at: "2026-11-01T16:30:00Z" },
      ],
    });
    expect(result.alerts.map((a) => a.code)).toEqual([
      "DISPATCHER_STALE",
      "APPOINTMENT_OVERDUE",
    ]);
    expect(result.healthy).toBe(false);
  });
  it("alarms on battery power before a depleted-battery shutdown", () => {
    expect(
      nativeScheduleHealth({ ...healthy, power: "battery" }).alerts,
    ).toEqual([{ code: "HOST_ON_BATTERY" }]);
    expect(nativeScheduleHealth({ ...healthy, power: "unknown" }).healthy).toBe(
      false,
    );
  });
  it("detects stalled native work with a healthy dispatcher, without changing its state", () => {
    const occurrence = {
      id: "sunday",
      team_id: "qwen",
      status: "started",
      scheduled_for: "2026-11-01T16:30:00Z",
      delivered_at: "2026-11-02T00:50:19Z",
      started_at: "2026-11-02T00:50:38Z",
    };
    const result = nativeScheduleHealth({
      ...healthy,
      activeOccurrences: [occurrence],
    });
    expect(result.alerts).toEqual([
      { code: "NATIVE_EXECUTION_STALLED", id: "sunday", teamId: "qwen" },
    ]);
    expect(occurrence.status).toBe("started");
  });
  it("allows dispatch latency and in-flight work, but always surfaces uncertain delivery", () => {
    const row = {
      id: "now",
      team_id: "owner",
      status: "queued",
      scheduled_for: now,
      delivered_at: null,
      started_at: null,
    };
    expect(
      nativeScheduleHealth({ ...healthy, activeOccurrences: [row] }).healthy,
    ).toBe(true);
    expect(
      nativeScheduleHealth({
        ...healthy,
        activeOccurrences: [{ ...row, status: "uncertain" }],
      }).alerts[0].code,
    ).toBe("DELIVERY_UNCERTAIN");
    expect(
      nativeScheduleHealth({
        ...healthy,
        activeOccurrences: [{ ...row, scheduled_for: "2026-11-02T05:58:00Z" }],
      }).healthy,
    ).toBe(false);
  });
});
