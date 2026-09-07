import { describe, it, expect } from "vitest";
import { usdToMicros } from "../src/money.js";
describe("observed decimal billing", () => {
  it("preserves exact microdollar values and rounds only smaller units upward", () => {
    expect(usdToMicros(0.000123)).toBe(123);
    expect(usdToMicros("0.0001231")).toBe(124);
    expect(usdToMicros(1e-7)).toBe(1);
    expect(usdToMicros("600.00")).toBe(600000000);
    expect(usdToMicros(0)).toBe(0);
  });
  it("rejects negative, nonfinite and overflowing costs", () => {
    for (const cost of [-1, NaN, Infinity, "999999999999999999"])
      expect(() => usdToMicros(cost)).toThrow();
  });
});
