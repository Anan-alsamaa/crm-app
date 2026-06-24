#!/usr/bin/env bash
# ============================================================================
# Yiji CRM — incident response (one command)
# ----------------------------------------------------------------------------
# The single entrypoint. Auto-collects the system's diagnostic context, then
# hands it to Claude to diagnose + fix. An optional human description is woven
# in, but it is NOT required — the preferred path is fully automatic.
#
#   scripts/incident/respond.sh                              # fully automatic
#   scripts/incident/respond.sh "agents get 403 on login"   # + human hint
#
# Wire it to fire automatically (see docs/INCIDENT-RESPONSE.md):
#   * * * * *  scripts/incident/detect.sh || scripts/incident/respond.sh
# ============================================================================
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export INCIDENT_NOTE="${1:-}"

echo "▶ collecting system context…"
REPORT="$(scripts/incident/collect.sh)"
echo "  context: $REPORT"

echo "▶ routing to Claude for diagnosis + fix…"
scripts/incident/remediate.sh "$REPORT"
