import type { ProfileDetail } from "../../shared/schemas";
import { useApi } from "./useApi";

export function useProfile(profileId: string | undefined) {
  return useApi<ProfileDetail>(profileId ? `/profiles/${profileId}` : null);
}
