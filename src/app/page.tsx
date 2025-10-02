"use client";

import { Suspense } from "react";
import { SPAContent } from "./components/SPAContent";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce" />
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:0.1s]" />
                <div className="w-3 h-3 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
            <p className="text-lg text-muted-foreground font-medium">
              Loading...
            </p>
          </div>
        </div>
      }
    >
      <SPAContent />
    </Suspense>
  );
}
