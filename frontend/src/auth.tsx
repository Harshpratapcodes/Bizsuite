import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUserDto } from "@bizsuite/contracts";
import { api, ApiError } from "./api";

/**
 * Session state from GET /api/auth/me. `null` user = show login screen.
 * RBAC is enforced server-side; the client only uses roleName to hide
 * screens the user could never use (defense in depth, not the defense).
 */
interface AuthState {
  user: AuthUserDto | null;
  loading: boolean;
  refresh: () => void;
}

const AuthCtx = createContext<AuthState>({ user: null, loading: true, refresh: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const res = await api.get<{ user: AuthUserDto }>("/api/auth/me");
        return res.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return (
    <AuthCtx.Provider value={{
      user: data ?? null,
      loading: isLoading,
      refresh: () => { void qc.invalidateQueries({ queryKey: ["me"] }); },
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}

export function isAdmin(user: AuthUserDto | null): boolean {
  return user?.roleName === "admin";
}

export function canEnterOpening(user: AuthUserDto | null): boolean {
  return user?.roleName === "admin" || user?.roleName === "accounts";
}

/** Mirrors the seeded role matrix: invoicing write+submit for admin, accounts,
 *  and counter staff ('sales', per eng review D4). Server enforces; this only
 *  hides screens a role could never use. */
export function canCreateInvoice(user: AuthUserDto | null): boolean {
  return user?.roleName === "admin" || user?.roleName === "accounts" || user?.roleName === "sales";
}

/** Sales module (quotations + sales orders) — seeded write+submit for
 *  admin, accounts, sales. */
export function canCreateQuote(user: AuthUserDto | null): boolean {
  return user?.roleName === "admin" || user?.roleName === "accounts" || user?.roleName === "sales";
}
export const canCreateSalesOrder = canCreateQuote;
