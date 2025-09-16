import { QueryClient } from "@tanstack/react-query";
import type { Metadata } from "next";
import { projectQueryConfig } from "../../hooks/useProject";
import { SessionPageContent } from "./components/SessionPageContent";
import { sessionQueryConfig } from "./hooks/useSessionQuery";

type PageParams = {
  projectId: string;
  sessionId: string;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { projectId, sessionId } = await params;

  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    ...sessionQueryConfig(projectId, sessionId),
  });

  await queryClient.prefetchQuery({
    ...projectQueryConfig(projectId),
  });

  return {
    title: `Session: ${sessionId.slice(0, 8)}...`,
    description: `View conversation session ${projectId}/${sessionId}`,
  };
}

interface SessionPageProps {
  params: Promise<PageParams>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { projectId, sessionId } = await params;

  return <SessionPageContent projectId={projectId} sessionId={sessionId} />;
}
