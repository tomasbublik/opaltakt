import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeAddConnectionResponse,
  makeConnection,
  makeConnectionHealth,
} from "../test/fixtures";

const { mockApi } = vi.hoisted(() => ({ mockApi: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("../api-client", async (orig) => {
  const actual = await orig<typeof import("../api-client")>();
  return { ...actual, api: mockApi };
});

import { ApiError } from "../api-client";
import { SetupScreen } from "./SetupScreen";

function noopProps() {
  return {
    onChanged: vi.fn(),
    onAdded: vi.fn(),
    onVaultLocked: vi.fn(),
    onVaultReset: vi.fn(),
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockApi)) delete mockApi[k];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupScreen — add server", () => {
  it("adds a server, clears the token input immediately and reports the OP user", async () => {
    const user = userEvent.setup();
    mockApi.addConnection = vi.fn().mockResolvedValue(makeAddConnectionResponse());
    const props = noopProps();

    render(<SetupScreen connections={[]} {...props} />);
    expect(screen.getByText(/No servers yet/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("OpenProject URL"), "https://op.example.com");
    await user.type(screen.getByLabelText("API token"), "secret-token");
    await user.type(screen.getByLabelText("Label (optional)"), "Prod");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(screen.getByText(/Connected as/)).toBeInTheDocument());
    expect(mockApi.addConnection).toHaveBeenCalledWith({
      base_url: "https://op.example.com",
      token: "secret-token",
      label: "Prod",
    });
    // The token never survives the request in the UI.
    expect(screen.getByLabelText("API token")).toHaveValue("");
    expect(props.onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("shows 'Server already added.' on a 409 conflict", async () => {
    const user = userEvent.setup();
    mockApi.addConnection = vi.fn().mockRejectedValue(
      new ApiError(409, { error: { code: "CONNECTION_EXISTS", message: "connection exists" } }),
    );
    const props = noopProps();

    render(<SetupScreen connections={[]} {...props} />);
    await user.type(screen.getByLabelText("OpenProject URL"), "https://op.example.com");
    await user.type(screen.getByLabelText("API token"), "tok");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server already added."));
    expect(props.onAdded).not.toHaveBeenCalled();
  });

  it("warns when the server was stored but validation failed (no user in response)", async () => {
    const user = userEvent.setup();
    mockApi.addConnection = vi.fn().mockResolvedValue(
      makeAddConnectionResponse({
        user: undefined,
        health: makeConnectionHealth({ last_status: "fail", last_error: "unreachable" }),
      }),
    );
    const props = noopProps();

    render(<SetupScreen connections={[]} {...props} />);
    await user.type(screen.getByLabelText("OpenProject URL"), "https://down.example.com");
    await user.type(screen.getByLabelText("API token"), "tok");
    await user.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Server stored, but validation failed/),
    );
    // Still added (with red health) and the token is gone from the input.
    expect(props.onAdded).toHaveBeenCalled();
    expect(screen.getByLabelText("API token")).toHaveValue("");
  });
});

describe("SetupScreen — stored servers", () => {
  it("lists servers with health dots, current marker and switches the current server", async () => {
    const user = userEvent.setup();
    mockApi.updateConnection = vi.fn().mockResolvedValue(makeConnection({ id: 2 }));
    const props = noopProps();
    const conns = [
      makeConnection({ id: 1, base_url: "https://op.example.com", label: "Prod" }),
      makeConnection({
        id: 2,
        base_url: "https://staging.example.com",
        is_current: false,
        health: makeConnectionHealth({ last_status: "fail", last_error: "boom" }),
      }),
    ];

    render(<SetupScreen connections={conns} {...props} />);
    expect(screen.getByText("https://op.example.com")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getByLabelText("server status: ok")).toBeInTheDocument();
    expect(screen.getByLabelText("server status: fail")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use this server" }));
    await waitFor(() => expect(mockApi.updateConnection).toHaveBeenCalledWith(2, { current: true }));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("re-enters a missing token (has_token=false) via PATCH and clears the input", async () => {
    const user = userEvent.setup();
    mockApi.updateConnection = vi.fn().mockResolvedValue(makeConnection({ has_token: true }));
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection({ has_token: false })]} {...props} />);
    expect(screen.getByText(/Token missing \(vault was reset\)/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Re-enter API token"), "fresh-token");
    await user.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(mockApi.updateConnection).toHaveBeenCalledWith(1, { token: "fresh-token" }),
    );
    expect(screen.getByLabelText("Re-enter API token")).toHaveValue("");
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("edits the label", async () => {
    const user = userEvent.setup();
    mockApi.updateConnection = vi.fn().mockResolvedValue(makeConnection({ label: "New name" }));
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    await user.click(screen.getByRole("button", { name: "Edit label" }));
    await user.type(screen.getByLabelText("Label"), "New name");
    await user.click(screen.getByRole("button", { name: "Save label" }));

    await waitFor(() =>
      expect(mockApi.updateConnection).toHaveBeenCalledWith(1, { label: "New name" }),
    );
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("deletes a server after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockApi.deleteConnection = vi.fn().mockResolvedValue({ deleted: true });
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mockApi.deleteConnection).toHaveBeenCalledWith(1));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("does not delete when the confirmation is declined", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mockApi.deleteConnection = vi.fn();
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(mockApi.deleteConnection).not.toHaveBeenCalled();
  });
});

describe("SetupScreen — vault controls", () => {
  it("locks the vault", async () => {
    const user = userEvent.setup();
    mockApi.lockVault = vi.fn().mockResolvedValue(undefined);
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    await user.click(screen.getByRole("button", { name: "Lock now" }));

    await waitFor(() => expect(mockApi.lockVault).toHaveBeenCalled());
    expect(props.onVaultLocked).toHaveBeenCalled();
  });

  it("changes the passphrase and clears all passphrase fields", async () => {
    const user = userEvent.setup();
    mockApi.changeVaultPassphrase = vi.fn().mockResolvedValue(undefined);
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    await user.type(screen.getByLabelText("Current passphrase"), "old-secret");
    await user.type(screen.getByLabelText("New passphrase (min 8 characters)"), "new-secret");
    await user.type(screen.getByLabelText("Confirm new passphrase"), "new-secret");
    await user.click(screen.getByRole("button", { name: "Change passphrase" }));

    await waitFor(() =>
      expect(mockApi.changeVaultPassphrase).toHaveBeenCalledWith({
        old_passphrase: "old-secret",
        new_passphrase: "new-secret",
      }),
    );
    expect(screen.getByText(/Passphrase changed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Current passphrase")).toHaveValue("");
    expect(screen.getByLabelText("New passphrase (min 8 characters)")).toHaveValue("");
  });

  it("resets the vault only after the typed confirmation", async () => {
    const user = userEvent.setup();
    mockApi.resetVault = vi.fn().mockResolvedValue({ cleared_tokens: 2 });
    const props = noopProps();

    render(<SetupScreen connections={[makeConnection()]} {...props} />);
    const resetButton = screen.getByRole("button", { name: "Reset vault" });
    expect(resetButton).toBeDisabled();

    await user.type(screen.getByLabelText("Type RESET to confirm"), "RESET");
    expect(resetButton).not.toBeDisabled();
    await user.click(resetButton);

    await waitFor(() => expect(mockApi.resetVault).toHaveBeenCalledWith({ confirm: true }));
    expect(props.onVaultReset).toHaveBeenCalled();
    expect(screen.getByText(/2 stored token\(s\) deleted/)).toBeInTheDocument();
  });
});
