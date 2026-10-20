import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makePersonSummary } from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { PeopleScreen } from "./PeopleScreen";

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
});

describe("PeopleScreen", () => {
  // SPEC_14 §2: "unset" is never guessed — it must read as a visibly
  // highlighted state, and the counter must sum ticket_count across every
  // unset-role person, not just count people.
  it("highlights unset-role people and shows the affected-tickets counter", async () => {
    mockApi.getPeople = vi.fn().mockResolvedValue([
      makePersonSummary({ id: 1, name: "Alice", role: "developer", ticket_count: 3 }),
      makePersonSummary({ id: 2, name: "Jindrich Benda", role: "unset", ticket_count: 2 }),
      makePersonSummary({ id: 3, name: "David Cesal", role: "unset", ticket_count: 5 }),
    ]);

    render(<PeopleScreen refreshKey={0} />);

    await waitFor(() => expect(screen.getByTestId("people-table")).toBeInTheDocument());
    const counter = screen.getByTestId("unset-role-counter");
    expect(counter).toHaveTextContent("2 people without a role affect 7 tickets.");

    const jindrichRow = screen.getByTestId("person-row-2");
    expect(jindrichRow.className).toContain("row-unset-role");
    expect(screen.getByLabelText("Role for Jindrich Benda")).toHaveClass("role-unset");
  });

  it("does not show the counter once every person has a role", async () => {
    mockApi.getPeople = vi.fn().mockResolvedValue([makePersonSummary({ id: 1, name: "Alice", role: "developer" })]);
    render(<PeopleScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("people-table")).toBeInTheDocument());
    expect(screen.queryByTestId("unset-role-counter")).not.toBeInTheDocument();
  });

  it("changes a person's role via PUT /api/people/:id/role", async () => {
    const user = userEvent.setup();
    mockApi.getPeople = vi
      .fn()
      .mockResolvedValueOnce([makePersonSummary({ id: 1, name: "Dan", role: "unset", ticket_count: 4 })])
      .mockResolvedValueOnce([makePersonSummary({ id: 1, name: "Dan", role: "tester", ticket_count: 4 })]);
    mockApi.setPersonRole = vi.fn().mockResolvedValue(makePersonSummary({ id: 1, name: "Dan", role: "tester" }));

    render(<PeopleScreen refreshKey={0} />);
    await waitFor(() => expect(screen.getByLabelText("Role for Dan")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Role for Dan"), "tester");

    await waitFor(() => expect(mockApi.setPersonRole).toHaveBeenCalledWith(1, { role: "tester" }));
    await waitFor(() => expect(screen.queryByTestId("unset-role-counter")).not.toBeInTheDocument());
  });
});
