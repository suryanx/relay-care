import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { MeResponse } from "../../shared/schemas";
import { ApiError, api } from "./api";

interface SessionState {
  me: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<MeResponse | null>;
}

async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>("/me");
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) console.error(err);
    return null;
  }
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const data = await fetchMe();
    setMe(data);
    setLoading(false);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    fetchMe().then((data) => {
      if (!active) return;
      setMe(data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  return <SessionContext.Provider value={{ me, loading, refresh }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
