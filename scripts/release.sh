#!/usr/bin/env bash

set -euxo pipefail

pnpm build

pnpm release-it
