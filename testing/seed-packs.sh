#!/usr/bin/env bash
#
# Install the shipped packs for the seeded tenants, through the API.
#
# WHY THIS IS A SCRIPT AND NOT MORE SQL
#
# Pack install is not a row insert. `POST /v1/packs/:id/install` validates
# `requiredConfig`, seeds the pack's playbooks, templates and approval policies
# for the tenant, and records the config on `tenant_packs` — and it MERGES
# config rather than replacing it (D95). Seeding those tables directly would
# skip the code that is worth testing and would drift the moment a pack changes.
#
# Idempotent: install is an upsert, so re-running updates rather than
# duplicating. That is the documented contract (`docs/PACKS.md`, "Installing a
# pack"), and re-running this script is a fair test of it.
#
# Usage:
#   ./testing/seed-packs.sh                    # defaults to localhost:5007
#   BASE_URL=http://localhost:5007 ./testing/seed-packs.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5007}"

# The gateway's headers. Every path except /health, /metrics, /v1/webhooks,
# /mcp and /unsubscribe requires these — see `app.ts`, "FOUR ORDERING
# SUBTLETIES ARE LOAD-BEARING".
hdrs=(
  -H 'content-type: application/json'
  -H 'x-gateway-request: true'
  -H 'x-user-id: seed-operator'
  -H 'x-user-role: admin'
)

install_pack() {
  local tenant="$1" pack="$2" body="$3"
  printf '  %-16s %-16s ' "$tenant" "$pack"
  local out code
  out=$(curl -sS -X POST "$BASE_URL/v1/packs/$pack/install" \
        "${hdrs[@]}" -H "x-tenant-id: $tenant" \
        -d "$body" -w '\n%{http_code}')
  code=$(printf '%s' "$out" | tail -n1)
  if [[ "$code" == 2* ]]; then
    echo "OK ($code)"
  else
    echo "FAILED ($code)"
    printf '%s\n' "$out" | sed '$d' | sed 's/^/      /'
    return 1
  fi
}

echo "Installing packs via $BASE_URL"
echo

# `core` carries the ten generic writing prompts every AI endpoint resolves
# against — without it `POST /v1/content/generate` answers 404 for every mode,
# because the source's prompts were compiled in and these are not (D67).
# It declares no requiredConfig, so an empty body is a complete install.
install_pack t-alpha core '{}'
install_pack t-beta  core '{}'
install_pack t-gdpr  core '{}'

# `medspa` refuses an install missing any of its four `requiredConfig` keys,
# naming every one (P12). Before that the field was read by nothing, and the
# first sign of trouble was an emergency notification producing a SKIPPED run at
# 3am — the exact failure the mechanism exists to prevent.
#
# These four are the destinations the SOURCE hardcoded (`emergency-team@…` plus
# three Slack channel names), which is why a second tenant's staff alerts would
# have posted into the first tenant's Slack. Per-tenant values here prove they
# are per-tenant now.
MEDSPA_ALPHA='{
  "config": {
    "emergencyContacts": ["ops@alpha.example", "oncall@alpha.example"],
    "slackChannels": {
      "staffAlerts": "#alpha-staff",
      "emergencyAlerts": "#alpha-emergency",
      "systemAlerts": "#alpha-system"
    }
  }
}'
MEDSPA_BETA='{
  "config": {
    "emergencyContacts": ["ops@beta.example"],
    "slackChannels": {
      "staffAlerts": "#beta-staff",
      "emergencyAlerts": "#beta-emergency",
      "systemAlerts": "#beta-system"
    }
  }
}'
install_pack t-alpha medspa "$MEDSPA_ALPHA"
install_pack t-beta  medspa "$MEDSPA_BETA"

# `lead-generation` on alpha and beta. It is the ONLY pack shipping playbooks
# with a `campaign` trigger, so without it `POST /v1/campaigns` has no
# `playbookKey` to name and the whole campaigns surface is untestable.
#
# It also exists to prove the engine is industry-blind: the pack declares no
# context providers and no required config, and if it needed an engine change
# to work, the abstraction would be wrong.
install_pack t-alpha lead-generation '{}'
install_pack t-beta  lead-generation '{}'

# `t-gdpr` deliberately gets `core` ONLY — no medspa, no lead-generation. That
# asymmetry is what makes pack isolation falsifiable: `GET /v1/playbooks` for
# t-gdpr must be empty rather than showing another tenant's, and a context
# provider registered against a pack this tenant has not installed must answer
# 403 rather than 404 — "you asked for something real that you are not entitled
# to" (docs/PACKS.md, contextProviders).

echo
echo "Installed. Verify with:"
echo "  curl -s $BASE_URL/v1/playbooks -H 'x-gateway-request: true' \\"
echo "    -H 'x-tenant-id: t-alpha' -H 'x-user-id: dev' -H 'x-user-role: admin' | jq '.playbooks | length'"
echo
echo "Reminder: AI playbooks ship isActive:false on purpose — deploying a pack"
echo "must never be the moment a tenant starts sending model-written messages."
echo "Activate one with POST /v1/playbooks/<key>/activate."
