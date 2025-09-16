import { useSuspenseQuery } from "@tanstack/react-query";
import { honoClient } from "../../../lib/api/client";

export const projetsQueryConfig = {
  queryKey: ["projects"],
  queryFn: async () => {
    const response = await honoClient.api.projects.$get();
    const { projects } = await response.json();
    return projects;
  },
} as const;

export const useProjects = () => {
  return useSuspenseQuery({
    queryKey: projetsQueryConfig.queryKey,
    queryFn: projetsQueryConfig.queryFn,
  });
};
