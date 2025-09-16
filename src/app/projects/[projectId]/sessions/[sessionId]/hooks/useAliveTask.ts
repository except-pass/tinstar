import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useMemo } from "react";
import { honoClient } from "../../../../../../lib/api/client";
import { aliveTasksAtom } from "../store/aliveTasksAtom";

export const useAliveTask = (sessionId: string) => {
  const [aliveTasks, setAliveTasks] = useAtom(aliveTasksAtom);

  useQuery({
    queryKey: ["aliveTasks"],
    queryFn: async () => {
      const response = await honoClient.api.tasks.alive.$get({});

      if (!response.ok) {
        throw new Error(response.statusText);
      }

      const data = await response.json();
      setAliveTasks(data.aliveTasks);
      return response.json();
    },
    refetchOnReconnect: true,
  });

  const taskInfo = useMemo(() => {
    const aliveTask = aliveTasks.find((task) => task.sessionId === sessionId);

    return {
      aliveTask: aliveTasks.find((task) => task.sessionId === sessionId),
      isRunningTask: aliveTask?.status === "running",
      isPausedTask: aliveTask?.status === "paused",
    } as const;
  }, [aliveTasks, sessionId]);

  return taskInfo;
};
