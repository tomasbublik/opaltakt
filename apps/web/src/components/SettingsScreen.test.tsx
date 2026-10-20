import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeAppConfig } from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { SettingsScreen } from "./SettingsScreen";

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
});

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3/§4) — Settings tab:
 * GET/PUT /api/config round-trip for freeze_grace_days (new) and
 * overshoot_threshold_pct (existing field, first edit surface).
 */
describe("SettingsScreen", () => {
  it("loads config and pre-fills both fields", async () => {
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig({ freeze_grace_days: 5, overshoot_threshold_pct: 30 }));

    render(<SettingsScreen />);

    await waitFor(() => expect(screen.getByLabelText(/Sprint freeze grace period/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Sprint freeze grace period/)).toHaveValue(5);
    expect(screen.getByLabelText(/Overshoot threshold/)).toHaveValue(30);
  });

  it("saves both fields via PUT /api/config and shows a success message", async () => {
    const user = userEvent.setup();
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig({ freeze_grace_days: 3, overshoot_threshold_pct: 25 }));
    mockApi.updateConfig = vi.fn().mockResolvedValue(makeAppConfig({ freeze_grace_days: 7, overshoot_threshold_pct: 40 }));

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByLabelText(/Sprint freeze grace period/)).toBeInTheDocument());

    const graceInput = screen.getByLabelText(/Sprint freeze grace period/);
    await user.clear(graceInput);
    await user.type(graceInput, "7");
    const overshootInput = screen.getByLabelText(/Overshoot threshold/);
    await user.clear(overshootInput);
    await user.type(overshootInput, "40");

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(mockApi.updateConfig).toHaveBeenCalledWith({ freeze_grace_days: 7, overshoot_threshold_pct: 40 }),
    );
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });

  it("rejects a freeze grace period outside 0-60 without calling the API", async () => {
    const user = userEvent.setup();
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
    mockApi.updateConfig = vi.fn();

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByLabelText(/Sprint freeze grace period/)).toBeInTheDocument());

    const graceInput = screen.getByLabelText(/Sprint freeze grace period/);
    await user.clear(graceInput);
    await user.type(graceInput, "61");

    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });

  it("shows an error message when the save fails", async () => {
    const user = userEvent.setup();
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
    mockApi.updateConfig = vi.fn().mockRejectedValue(new Error("boom"));

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("links to the People tab instead of duplicating role management here", async () => {
    const onGoToPeople = vi.fn();
    mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());

    render(<SettingsScreen onGoToPeople={onGoToPeople} />);
    await waitFor(() => expect(screen.getByText(/People & roles have their own tab/)).toBeInTheDocument());

    await userEvent.setup().click(screen.getByRole("button", { name: "go to People" }));
    expect(onGoToPeople).toHaveBeenCalled();
  });
});
