import { QueryClient } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import { ProjectList } from "./components/ProjectList";
import { projetsQueryConfig } from "./hooks/useProjects";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function ProjectsPage() {
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: projetsQueryConfig.queryKey,
    queryFn: projetsQueryConfig.queryFn,
  });

  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
          <HistoryIcon className="w-8 h-8" />
          Claude Code Viewer
        </h1>
        <p className="text-muted-foreground">
          Browse your Claude Code conversation history and project interactions
        </p>
      </header>

      <main>
        <section>
          <h2 className="text-xl font-semibold mb-4">Your Projects</h2>

          <ProjectList />
        </section>
      </main>
    </div>
  );
}
