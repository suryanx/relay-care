import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { errorMessage } from "./errors";

/** Fetches `path` (null = skip) and exposes a reload function. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) return;
    let active = true;
    api<T>(path).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError(null);
      },
      (err: unknown) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, [path, version]);

  return { data, error, reload };
}
