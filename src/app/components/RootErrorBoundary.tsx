"use client";

import type { FC, PropsWithChildren } from "react";
import { ErrorBoundary } from "react-error-boundary";

export const RootErrorBoundary: FC<PropsWithChildren> = ({ children }) => {
  return (
    <ErrorBoundary
      FallbackComponent={({ error }) => (
        <div>
          <h1>Error</h1>
          <p>{error.message}</p>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
};
