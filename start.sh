#!/usr/bin/env bash
set -e

# Verify Node.js 18+
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18 or higher is required (found: $(node --version 2>/dev/null || echo 'not installed'))"
  echo "Install via nvm: nvm install 20 && nvm use 20"
  exit 1
fi

echo "▶ Node $(node --version)"
cd "$(dirname "$0")"
exec node node_modules/.bin/ts-node src/api.ts
