import { describe, expect, it } from "vitest";
import {
  buildStatusCatalog,
  normalizeStatusName,
  statusCatalogFromById,
} from "./statusCatalog";
import type { OpStatus } from "./types";

function status(id: number, name: string, isClosed = false): OpStatus {
  return { _type: "Status", id, name, isClosed };
}

const STATUSES: OpStatus[] = [
  status(1, "New"),
  status(2, "In progress"),
  status(3, "Developed"),
  status(12, "Closed", true),
];

describe("buildStatusCatalog / normalizeStatusName (SPEC_21)", () => {
  const catalog = buildStatusCatalog(STATUSES);

  it("resolves a case-insensitive match to the catalog's canonical spelling", () => {
    expect(normalizeStatusName("in progress", catalog)).toEqual({
      name: "In progress",
      recognized: true,
    });
    expect(normalizeStatusName("IN PROGRESS", catalog)).toEqual({
      name: "In progress",
      recognized: true,
    });
    expect(normalizeStatusName("NEW", catalog).name).toBe("New");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeStatusName("  developed  ", catalog)).toEqual({
      name: "Developed",
      recognized: true,
    });
  });

  it("passes an unrecognized status through UNCHANGED with recognized:false", () => {
    expect(normalizeStatusName("quantum-limbo", catalog)).toEqual({
      name: "quantum-limbo",
      recognized: false,
    });
    // Casing of the unknown value is preserved exactly — never blanked/dropped.
    expect(normalizeStatusName("WeIrD", catalog)).toEqual({
      name: "WeIrD",
      recognized: false,
    });
  });

  it("returns an empty/whitespace-only string unchanged, recognized:false", () => {
    expect(normalizeStatusName("", catalog)).toEqual({ name: "", recognized: false });
    expect(normalizeStatusName("   ", catalog)).toEqual({ name: "   ", recognized: false });
  });

  it("first-wins on a duplicate normalized name", () => {
    // Two entries collide on "in progress" — the FIRST inserted wins.
    const dup = buildStatusCatalog([
      status(7, "In progress"),
      status(99, "IN PROGRESS"),
    ]);
    expect(normalizeStatusName("in progress", dup).name).toBe("In progress");
  });

  it("statusCatalogFromById builds an equivalent catalog from a Map<id, OpStatus>", () => {
    const byId = new Map<number, OpStatus>(STATUSES.map((s) => [s.id, s]));
    const fromById = statusCatalogFromById(byId);
    expect(normalizeStatusName("developed", fromById)).toEqual({
      name: "Developed",
      recognized: true,
    });
    expect(fromById.byNormalizedName.get("closed")?.name).toBe("Closed");
  });
});
