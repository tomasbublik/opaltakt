import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionsHealthResponse } from "@osp/contracts";
import {
  makeAppConfig,
  makeBacklogItem,
  makeConnection,
  makeHealth,
  makeMe,
  makeOffSprintTimeResponse,
  makeSprint,
  makeSyncStatus,
  makeVaultStatus,
  makeClosureStats,
} from "./test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("./api-client", async (orig) => {
  const actual = await orig<typeof import("./api-client")>();
  return {
    ...actual,
    api: mockApi,
    subscribeConnectionsHealth: (_cb: (h: ConnectionsHealthResponse) => void) => () => {},
  };
});

import { ApiError } from "./api-client";
import { App } from "./App";

const unauth = () =>
  new ApiError(401, { error: { code: "UNAUTHENTICATED", message: "Not signed in" } });

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  mockApi.getMe = vi.fn().mockResolvedValue(makeMe());
  mockApi.logout = vi.fn().mockResolvedValue({ logout_url: "https://login.example/logout" });
  mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus());
  mockApi.getConnections = vi.fn().mockResolvedValue([makeConnection()]);
  mockApi.getConnectionsHealth = vi.fn().mockResolvedValue(makeHealth());
  mockApi.getSyncStatus = vi.fn().mockResolvedValue(makeSyncStatus());
  mockApi.getSprints = vi.fn().mockResolvedValue([makeSprint({ id: 1, status: "planning", name: "Sprint 1" })]);
  mockApi.getBacklog = vi.fn().mockResolvedValue([makeBacklogItem({ op_id: 1, subject: "Alpha" })]);
  mockApi.getImports = vi.fn().mockResolvedValue([]);
  mockApi.getProjects = vi.fn().mockResolvedValue([]);
  mockApi.getOutOfSelection = vi.fn().mockResolvedValue({ entries: [], total: 0, protected_count: 0 });
  mockApi.getConfig = vi.fn().mockResolvedValue(makeAppConfig());
  mockApi.getSprintItemsDetailed = vi.fn().mockResolvedValue([]);
  mockApi.getCapacity = vi.fn().mockResolvedValue({
    sprint_id: 1,
    lines: [],
    total_available_hours: 0,
    total_planned_hours: 0,
    overloaded: false,
    baseline_total_hours: null,
    scope_planned_hours: 0,
    scope_delivered_hours: 0,
  });
  mockApi.getClosureStats = vi.fn().mockResolvedValue(makeClosureStats({ per_developer: [] }));
  mockApi.getOffSprintTime = vi.fn().mockResolvedValue(makeOffSprintTimeResponse());
  mockApi.getSprintUpdates = vi.fn().mockResolvedValue([]);
  mockApi.getSprintPeople = vi.fn().mockResolvedValue([]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("App sign-in gate (Increment 39)", () => {
  it("shows the sign-in page on 401 with a Microsoft button pointing at /api/auth/login?returnTo=…", async () => {
    window.history.replaceState(null, "", "/board?sprint=3");
    mockApi.getMe = vi.fn().mockRejectedValue(unauth());
    const hrefSet = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get pathname() { return realLocation.pathname; },
        get search() { return realLocation.search; },
        get href() { return realLocation.href; },
        set href(v: string) { hrefSet(v); },
      },
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeInTheDocument());
      expect(screen.getByText("OpalTakt")).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Screens" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Sign in with Microsoft" }));
      expect(hrefSet).toHaveBeenCalledWith(`/api/auth/login?returnTo=${encodeURIComponent("/board?sprint=3")}`);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    }
  });

  it("shows a friendly message for ?auth_error=… and strips it from the URL", async () => {
    window.history.replaceState(null, "", "/?auth_error=access_denied&x=1");
    mockApi.getMe = vi.fn().mockRejectedValue(unauth());
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent(/cancelled or not permitted/i));
    expect(window.location.search).toBe("?x=1");
  });

  it("falls back to a generic message for an unknown auth_error code", async () => {
    window.history.replaceState(null, "", "/?auth_error=weird");
    mockApi.getMe = vi.fn().mockRejectedValue(unauth());
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent(/did not complete/i));
  });

  it("shows the No-access page (with the user's name and Sign out) when the account has no role", async () => {
    const user = userEvent.setup();
    mockApi.getMe = vi.fn().mockResolvedValue(
      makeMe({ mode: "entra", user: { name: "Jana Nováková", email: "j@x.test", roles: [] }, role: null }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("No access")).toBeInTheDocument());
    expect(screen.getByText(/Jana Nováková/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Screens" })).not.toBeInTheDocument();
    expect(mockApi.getVaultStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mockApi.logout).toHaveBeenCalled());
  });

  it("none mode: header shows 'Local user' + Planner and no Sign out; all tabs present", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("account-name")).toHaveTextContent("Local user"));
    expect(screen.getByTestId("role-badge")).toHaveTextContent("Planner");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Screens" });
    for (const t of ["Setup", "Import", "Data", "Sprint board"]) {
      expect(within(nav).getByRole("button", { name: t })).toBeInTheDocument();
    }
  });

  it("Planner (entra): shows name, Planner badge, Sign out, Sync buttons and all tabs", async () => {
    mockApi.getMe = vi.fn().mockResolvedValue(
      makeMe({ mode: "entra", user: { name: "Pavel Plán", email: null, roles: ["Planner"] }, role: "Planner" }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("account-name")).toHaveTextContent("Pavel Plán"));
    expect(screen.getByTestId("role-badge")).toHaveTextContent("Planner");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Full refresh" })).toBeInTheDocument();
    expect(mockApi.getVaultStatus).toHaveBeenCalled();
  });

  describe("Viewer", () => {
    beforeEach(() => {
      mockApi.getMe = vi.fn().mockResolvedValue(
        makeMe({ mode: "entra", user: { name: "Vera Viewer", email: null, roles: ["Viewer"] }, role: "Viewer" }),
      );
      // A locked vault must NOT block a Viewer.
      mockApi.getVaultStatus = vi.fn().mockResolvedValue(makeVaultStatus({ locked: true }));
    });

    it("goes straight into the app (no vault gate), shows the Viewer badge and Sign out", async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("role-badge")).toHaveTextContent("Viewer"));
      expect(screen.getByTestId("account-name")).toHaveTextContent("Vera Viewer");
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      expect(screen.queryByText("Unlock vault")).not.toBeInTheDocument();
      expect(mockApi.getVaultStatus).not.toHaveBeenCalled();
    });

    it("hides Setup, Import and Data tabs and keeps the read screens", async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Sprint board" })).toBeInTheDocument());
      const nav = screen.getByRole("navigation", { name: "Screens" });
      for (const t of ["Setup", "Import", "Data"]) {
        expect(within(nav).queryByRole("button", { name: t })).not.toBeInTheDocument();
      }
      for (const t of ["Backlog", "Burndown", "Velocity", "Closure", "People", "Reports", "Settings"]) {
        expect(within(nav).getByRole("button", { name: t })).toBeInTheDocument();
      }
    });

    it("hides Sync now / Full refresh and lands on a read-only sprint board", async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Sprint details/)).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Full refresh" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create sprint" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete sprint" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Add →/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Export status PDF/i })).toBeInTheDocument();
    });
  });

  describe("central error handling", () => {
    it("a 401 UNAUTHENTICATED from any later call sends the app back to the sign-in page", async () => {
      mockApi.getSprints = vi.fn().mockResolvedValue([]);
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("account-name")).toBeInTheDocument());
      const { setAuthHandlers: _unused } = await import("./api-client");
      void _unused;
      // Simulate what req() does on a 401 mid-session by hitting the real
      // reaction through a real fetch failure.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } }),
        }),
      );
      const actual = await vi.importActual<typeof import("./api-client")>("./api-client");
      await expect(actual.api.getSprints()).rejects.toBeInstanceOf(actual.ApiError);
      await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeInTheDocument());
      expect(screen.getByTestId("auth-error")).toHaveTextContent(/session has ended/i);
      vi.unstubAllGlobals();
    });

    it("a 403 FORBIDDEN_ROLE shows a calm inline notice and keeps the app", async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("account-name")).toBeInTheDocument());
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { code: "FORBIDDEN_ROLE", message: "This action requires the Planner role" } }),
        }),
      );
      const actual = await vi.importActual<typeof import("./api-client")>("./api-client");
      await expect(actual.api.getSprints()).rejects.toBeInstanceOf(actual.ApiError);
      await waitFor(() => expect(screen.getByTestId("forbidden-notice")).toHaveTextContent(/Planner role/));
      expect(screen.getByTestId("account-name")).toBeInTheDocument();
      vi.unstubAllGlobals();
    });
  });
});
