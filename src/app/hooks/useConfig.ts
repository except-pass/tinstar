import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { honoClient } from "../../lib/api/client";
import type { Config } from "../../server/config/config";

export const configQueryConfig = {
  queryKey: ["config"],
  queryFn: async () => {
    const response = await honoClient.api.config.$get();
    return await response.json();
  },
} as const;

export const useConfig = () => {
  const queryClient = useQueryClient();

  const { data } = useSuspenseQuery({
    ...configQueryConfig,
  });
  const updateConfigMutation = useMutation({
    mutationFn: async (config: Config) => {
      const response = await honoClient.api.config.$put({
        json: config,
      });
      return await response.json();
    },
    onMutate: async (newConfig: Config) => {
      // Optimistically update the cache immediately
      await queryClient.cancelQueries({ queryKey: configQueryConfig.queryKey });
      const previousConfig = queryClient.getQueryData(configQueryConfig.queryKey);
      queryClient.setQueryData(configQueryConfig.queryKey, { config: newConfig });
      return { previousConfig };
    },
    onError: (err, newConfig, context) => {
      // Rollback on error
      if (context?.previousConfig) {
        queryClient.setQueryData(configQueryConfig.queryKey, context.previousConfig);
      }
    },
    onSettled: () => {
      // Invalidate to ensure we're in sync with server
      queryClient.invalidateQueries({ queryKey: configQueryConfig.queryKey });
    },
  });

  return {
    config: data?.config,
    isUpdating: updateConfigMutation.isPending,
    updateConfig: useCallback(
      (config: Config) => {
        updateConfigMutation.mutate(config);
      },
      [updateConfigMutation],
    ),
  } as const;
};
