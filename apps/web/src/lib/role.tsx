import { createContext, useContext, type ReactNode } from "react";
import type { AppRole, AuthMode } from "@osp/contracts";

/**
 * Increment 39 (§6) — the signed-in user's effective role, provided once by
 * App and read anywhere with `useRole()` / `useCan("plan")`. The backend is
 * the enforcement (403 FORBIDDEN_ROLE); this only decides what the UI offers.
 *
 * Without a provider (standalone component tests, `none` mode defaults) the
 * context is a Planner, so existing behaviour is unchanged.
 */
export interface RoleInfo {
  role: AppRole;
  mode: AuthMode;
}

const DEFAULT: RoleInfo = { role: "Planner", mode: "none" };
const RoleContext = createContext<RoleInfo>(DEFAULT);

export function RoleProvider({ value, children }: { value: RoleInfo; children: ReactNode }) {
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleInfo {
  return useContext(RoleContext);
}

/** Capabilities: `plan` = anything that mutates (Planner only); `read` = everyone. */
export function useCan(capability: "plan" | "read"): boolean {
  const { role } = useRole();
  return capability === "read" || role === "Planner";
}
