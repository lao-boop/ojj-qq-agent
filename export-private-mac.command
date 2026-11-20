#!/bin/bash
set -e
cd "$(dirname "$0")"
printf 'Stop the old bot first. This exports private config and data locally, not to GitHub.\n'
node scripts/friend-handover.mjs export
printf '\nPress Enter to close.\n'
read -r
