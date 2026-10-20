import { describe, expect, it } from "vitest";
import { parseIsoDuration, parseOpId } from "./util";

describe("parseIsoDuration", () => {
  it("parses hours", () => {
    expect(parseIsoDuration("PT8H")).toBe(8);
    expect(parseIsoDuration("PT0H")).toBe(0);
  });
  it("parses hours+minutes", () => {
    expect(parseIsoDuration("PT2H30M")).toBe(2.5);
    expect(parseIsoDuration("PT45M")).toBe(0.75);
  });
  it("parses days and weeks (calendar convention)", () => {
    expect(parseIsoDuration("P1DT4H")).toBe(28);
    expect(parseIsoDuration("P1W")).toBe(168);
  });
  it("parses day-spanning durations as real OpenProject emits them (Increment 22)", () => {
    // Real prod WP 11592: remainingTime "P1DT5H" == 1 day (24h) + 5h == 29h.
    // Locks in that the D group is multiplied by 24 and added to the time part —
    // the parser was ALREADY correct; nobody had proven it before.
    expect(parseIsoDuration("P1DT5H")).toBe(29);
    expect(parseIsoDuration("P1D")).toBe(24);
    expect(parseIsoDuration("P2DT3H30M")).toBe(51.5);
    expect(parseIsoDuration("P3DT8H")).toBe(80);
  });
  it("returns null for null/empty/invalid", () => {
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration("")).toBeNull();
    expect(parseIsoDuration("P")).toBeNull();
    expect(parseIsoDuration("nonsense")).toBeNull();
  });
});

describe("parseOpId", () => {
  it("extracts trailing id from href", () => {
    expect(parseOpId("/api/v3/projects/3")).toBe(3);
    expect(parseOpId("/api/v3/work_packages/1001")).toBe(1001);
  });
  it("returns null for null/absent", () => {
    expect(parseOpId(null)).toBeNull();
    expect(parseOpId(undefined)).toBeNull();
  });
});
