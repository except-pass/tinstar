import { QueryClient } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import { SessionsList } from "./components/SessionsList";
import { projetsQueryConfig } from "../projects/hooks/useProjects";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function SessionsPage() {
  const queryClient = new QueryClient();

  // Prefetch projects data since we'll need it for the combined sessions
  await queryClient.prefetchQuery({
    queryKey: projetsQueryConfig.queryKey,
    queryFn: projetsQueryConfig.queryFn,
  });

  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
          <HistoryIcon className="w-8 h-8" />
          Tinstar
        </h1>
        <p className="text-muted-foreground">
          Browse your Claude Code conversation history across all projects
        </p>
      </header>

      <main>
        <SessionsList />
      </main>
    </div>
  );
}