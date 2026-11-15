import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Same-origin Better Auth client (cookies are HttpOnly; the browser never sees the token). */
export const authClient = createAuthClient({ plugins: [usernameClient()] });
