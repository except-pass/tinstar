#!/usr/bin/env bash

set -euxo pipefail

if [ -d "dist/.next" ]; then
  rm -rf dist/.next
fi

pnpm exec next build
cp -r public .next/standalone/
if [ -d ".next/static" ]; then
  cp -r .next/static .next/standalone/.next/
fi

cp -r .next/standalone ./dist/
