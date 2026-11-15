import type { ProfileDetail } from "../../shared/schemas";
import { useSession } from "./session";
import { useApi } from "./useApi";

/** Care-team profile data. Never requested for elder sessions (they are redirected to their own home). */
export function useProfile(profileId: string | undefined) {
  const { me } = useSession();
  return useApi<ProfileDetail>(profileId && me && !me.isElder ? `/profiles/${profileId}` : null);
}
