import { describe, expect, it } from "vitest";
import { effectiveEstimate } from "./estimate";

/**
 * Increment 16 (SPEC_16 §5) — estimate-of-record resolution:
 *   1) override wins (top precedence)
 *   2) remaining, when non-zero AND != estimated
 *   3) otherwise estimated
 */
describe("effectiveEstimate (SPEC_16 §5)", () => {
  describe("override precedence (case 1)", () => {
    it("override wins regardless of remaining/estimated", () => {
      expect(effectiveEstimate(24, 18, 5)).toBe(5);
      expect(effectiveEstimate(8, null, 5)).toBe(5);
      expect(effectiveEstimate(null, null, 5)).toBe(5);
      expect(effectiveEstimate(8, 8, 5)).toBe(5);
    });
    it("an override of 0 still wins (not treated as absent)", () => {
      expect(effectiveEstimate(8, 4, 0)).toBe(0);
      expect(effectiveEstimate(8, null, 0)).toBe(0);
    });
  });

  describe("remaining preference (case 2)", () => {
    it("remaining != 0 and != estimated → remaining (the SPEC 11765 example)", () => {
      expect(effectiveEstimate(24, 18, null)).toBe(18);
      expect(effectiveEstimate(10, 3, null)).toBe(3);
    });
    it("remaining applies even when it is LARGER than estimated", () => {
      expect(effectiveEstimate(10, 15, null)).toBe(15);
    });
    it("estimated == null but a non-zero remaining is present → remaining", () => {
      // Documented choice: the comparison does not require estimated to be non-null.
      expect(effectiveEstimate(null, 18, null)).toBe(18);
    });
  });

  describe("fall-through to estimated (case 3)", () => {
    it("remaining == estimated → estimated (untouched ticket, no behaviour change)", () => {
      expect(effectiveEstimate(10, 10, null)).toBe(10);
    });
    it("remaining == 0 → estimated (fully-done ticket keeps its Work, not 0)", () => {
      expect(effectiveEstimate(10, 0, null)).toBe(10);
      expect(effectiveEstimate(24, 0, null)).toBe(24);
    });
    it("remaining == null → estimated", () => {
      expect(effectiveEstimate(8, null, null)).toBe(8);
    });
    it("estimated == null, remaining == 0 → null", () => {
      expect(effectiveEstimate(null, 0, null)).toBeNull();
    });
    it("all null → null", () => {
      expect(effectiveEstimate(null, null, null)).toBeNull();
    });
  });
});
