import { describe, expect, it } from "vitest";
import { formatDate, formatHours, formatPct, formatSignedHours, isDimmedStatus, relativeTime } from "./format";

describe("formatHours", () => {
  it("formats integers and decimals, em dash for nullish", () => {
    expect(formatHours(8)).toBe("8h");
    expect(formatHours(6.5)).toBe("6.5h");
    expect(formatHours(null)).toBe("—");
    expect(formatHours(undefined)).toBe("—");
    expect(formatHours(Number.NaN)).toBe("—");
  });

  it("rounds an un-rounded server value to 1 decimal place (SPEC_11 §7)", () => {
    expect(formatHours(54.333333333333336)).toBe("54.3h");
  });
});

describe("isDimmedStatus", () => {
  it("flags Developed/Tested/Resolved case-insensitively, not New/In progress", () => {
    expect(isDimmedStatus("Developed")).toBe(true);
    expect(isDimmedStatus("tested")).toBe(true);
    expect(isDimmedStatus("RESOLVED")).toBe(true);
    expect(isDimmedStatus("New")).toBe(false);
    expect(isDimmedStatus("In progress")).toBe(false);
    expect(isDimmedStatus("Confirmed")).toBe(false);
    expect(isDimmedStatus(null)).toBe(false);
    expect(isDimmedStatus(undefined)).toBe(false);
  });
});

describe("formatPct", () => {
  it("rounds and handles nullish", () => {
    expect(formatPct(66.6)).toBe("67%");
    expect(formatPct(null)).toBe("—");
  });
});

// Increment 16 (SPEC_16 §2): the capacity bar's signed "±scope change" number.
describe("formatSignedHours", () => {
  it("shows an explicit sign — '+' for positive, proper minus for negative, none for zero", () => {
    expect(formatSignedHours(19)).toBe("+19h");
    expect(formatSignedHours(-6)).toBe("−6h");
    expect(formatSignedHours(0)).toBe("0h");
  });

  it("rounds like formatHours and handles nullish", () => {
    expect(formatSignedHours(6.66)).toBe("+6.7h");
    expect(formatSignedHours(null)).toBe("—");
    expect(formatSignedHours(undefined)).toBe("—");
  });
});

// Increment 16 (SPEC_16 §4): British date format DD/MM/YYYY.
describe("formatDate", () => {
  it("formats an ISO date or datetime as DD/MM/YYYY", () => {
    expect(formatDate("2026-08-01")).toBe("01/08/2026");
    expect(formatDate("2026-08-14")).toBe("14/08/2026");
    expect(formatDate("2026-07-07T03:41:00Z")).toBe("07/07/2026");
  });

  it("never round-trips through the local Date/timezone", () => {
    // A midnight-UTC datetime that a naive `new Date(...).toLocaleDateString()`
    // could shift a day backward in a negative-UTC-offset timezone.
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("01/01/2026");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  it("labels minutes/hours/days and never", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-07-01T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-07-01T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-07-01T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-06-28T12:00:00Z", now)).toBe("3 d ago");
  });
});
