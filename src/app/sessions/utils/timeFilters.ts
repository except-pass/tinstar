import type { SessionTimeFilter } from "@/app/projects/[projectId]/sessions/[sessionId]/store/sessionTimeFilterAtom";

export function getTimeFilterCutoff(filter: SessionTimeFilter): Date | null {
  if (filter === "all") return null;
  
  const now = Date.now();
  const cutoffs = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1m": 30 * 24 * 60 * 60 * 1000,
  };
  
  return new Date(now - cutoffs[filter]);
}

export function isSessionWithinTimeFilter(
  lastModifiedAt: string | null,
  filter: SessionTimeFilter,
  isHydrated: boolean = true
): boolean {
  // Before hydration, avoid Date.now()-based filtering to prevent SSR mismatches
  if (!isHydrated) return true;
  
  if (filter === "all") return true;
  if (!lastModifiedAt) return false;
  
  const cutoff = getTimeFilterCutoff(filter);
  if (!cutoff) return true;
  
  const sessionTime = new Date(lastModifiedAt);
  return sessionTime > cutoff;
}