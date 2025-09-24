import { redirect } from "next/navigation";
import { honoClient } from "@/lib/api/client";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function SessionsPage() {
  // Decide destination first to avoid catching Next.js redirect exceptions
  let destination = "/projects";

  try {
    // Get all sessions using the dedicated endpoint
    const sessionsResponse = await honoClient.api.sessions.all.$get();
    const { sessions } = await sessionsResponse.json();

    if (sessions.length > 0) {
      // Sort by last modified (newest first) and take the first one
      const sortedSessions = sessions.sort((a, b) => {
        const aTime = a.session.meta.lastModifiedAt ? new Date(a.session.meta.lastModifiedAt).getTime() : 0;
        const bTime = b.session.meta.lastModifiedAt ? new Date(b.session.meta.lastModifiedAt).getTime() : 0;
        return bTime - aTime;
      });
      
      const firstSessionWithProject = sortedSessions[0];
      if (firstSessionWithProject) {
        destination = `/sessions/${encodeURIComponent(firstSessionWithProject.session.id)}`;
      } else {
        destination = "/projects";
      }
    } else {
      // No sessions found, redirect to projects page
      destination = "/projects";
    }
  } catch (error) {
    console.error("Error fetching projects:", error);
    destination = "/projects";
  }

  redirect(destination);
}