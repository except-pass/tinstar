"use client";

import { useServerEvents } from "@/hooks/useServerEvents";

interface ServerEventsProviderProps {
  children: React.ReactNode;
}

export function ServerEventsProvider({ children }: ServerEventsProviderProps) {
  useServerEvents();

  return <>{children}</>;
}
