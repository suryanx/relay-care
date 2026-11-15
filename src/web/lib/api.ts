export interface ApiErrorBody {
  error: { code: string; message: string; fields?: { path: string; message: string }[] };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody["error"],
  ) {
    super(body.message);
  }
}

/** JSON fetch against our API with same-origin cookies. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const body = (data as ApiErrorBody | null)?.error ?? { code: "HTTP_" + res.status, message: "Request failed." };
    throw new ApiError(res.status, body);
  }
  return data as T;
}
