import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import { ProjectPageContent } from "./components/ProjectPage";
import { projectQueryConfig } from "./hooks/useProject";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;

  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    ...projectQueryConfig(projectId),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ProjectPageContent projectId={projectId} />
    </HydrationBoundary>
  );
}
