import { QueryClient } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { honoClient } from "@/lib/api/client";
import { projectQueryConfig } from "../../projects/[projectId]/hooks/useProject";
import { sessionQueryConfig } from "../../projects/[projectId]/sessions/[sessionId]/hooks/useSessionQuery";
import { GlobalSessionPageContent } from "./components/GlobalSessionPageContent";

type PageParams = {
  sessionId: string;
};

async function findProjectForSession(sessionId: string): Promise<string | null> {
  try {
    const projectsResponse = await honoClient.api.projects.$get();
    const { projects } = await projectsResponse.json();

    for (const project of projects) {
      try {
        const sessionsResponse = await honoClient.api.projects[":projectId"].$get({
          param: { projectId: project.id }
        });
        const { sessions } = await sessionsResponse.json();
        
        if (sessions.find((session: any) => session.id === sessionId)) {
          console.log('Found matching project:', project.id, 'for session:', sessionId);
          return project.id;
        }
      } catch (error) {
        console.error(`Error checking project ${project.id} for session ${sessionId}:`, error);
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error finding project for session:", error);
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { sessionId } = await params;
  
  const projectId = await findProjectForSession(sessionId);
  
  if (!projectId) {
    return {
      title: "Session Not Found",
      description: "The requested session could not be found",
    };
  }

  const queryClient = new QueryClient();

  try {
    await queryClient.prefetchQuery({
      ...sessionQueryConfig(projectId, sessionId),
    });

    await queryClient.prefetchQuery({
      ...projectQueryConfig(projectId),
    });
  } catch (error) {
    console.error("Error prefetching session data:", error);
  }

  return {
    title: `Session: ${sessionId.slice(0, 8)}...`,
    description: `View conversation session ${sessionId} - Tinstar Global Sessions`,
  };
}

interface SessionPageProps {
  params: Promise<PageParams>;
}

export default async function GlobalSessionPage({ params }: SessionPageProps) {
  const { sessionId } = await params;
  
  const projectId = await findProjectForSession(sessionId);
  
  if (!projectId) {
    notFound();
  }

  return <GlobalSessionPageContent projectId={projectId} sessionId={sessionId} />;
}