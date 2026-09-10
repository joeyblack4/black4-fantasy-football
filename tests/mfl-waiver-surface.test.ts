import { expect, it } from "vitest";
import { envelope, safeErrorMessage } from "../src/mfl/codec.js";
import { MflOwnerReadSchema } from "../src/mfl/contracts.js";

it("preserves useful XML and JSON rejections while redacting credentials and markup", () => {
  for (const raw of [
    JSON.stringify({
      error: { $t: "Invalid waiver round. APIKEY=secret-value" },
    }),
    "<error>Invalid waiver round. APIKEY=secret-value</error>",
  ]) {
    expect(envelope(raw)).toMatchObject({
      accepted: false,
      errorCode: "MFL_WAIVER_ROUND_INVALID",
      errorMessage: "Invalid waiver round. [credential removed]",
    });
  }
  expect(
    safeErrorMessage(
      "Roster full. <script>leak()</script><b>Try later</b> https://host/?token=secret MFL_USER_ID=secret other@example.com",
    ),
  ).toBe(
    "Roster full. Try later [link removed] [credential removed] [email removed]",
  );
  expect(
    envelope("<error>You cannot perform waivers at this time</error>"),
  ).toMatchObject({
    errorCode: "MFL_ACQUISITION_UNAVAILABLE",
    errorMessage: "You cannot perform waivers at this time",
  });
});
it("rejects ambiguous week/time searches and reversed intervals", () => {
  expect(() =>
    MflOwnerReadSchema.parse({ type: "transactions", week: 1, days: 2 }),
  ).toThrow();
  expect(() =>
    MflOwnerReadSchema.parse({
      type: "transactions",
      since: "2026-09-11T00:00:00Z",
      until: "2026-09-10T00:00:00Z",
    }),
  ).toThrow();
  expect(
    MflOwnerReadSchema.parse({ type: "transactions", days: 2 }),
  ).toMatchObject({ days: 2, limit: 100 });
});
