#!/usr/bin/env node

await import("./server.js").catch((error) => {
  console.error(error);
  process.exit(1);
});