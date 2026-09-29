#!/usr/bin/env bash
# Deploys all Invictus Traffic Radar agents to your Supabase project.
# Run from the ticket-radar folder after `npx supabase login` and `npx supabase link --project-ref YOUR-REF`.
# (The setup page at /setup.html shows these commands with your project filled in.)
set -euo pipefail
SB="${SUPABASE:-npx supabase}"

# Called by signed-in people from the app (Supabase checks their login)
$SB functions deploy scan-ticket voice-assist dispute-helper delete-account

# Called by the scheduler / database / setup page, or check the login themselves
$SB functions deploy camera-sync moderate-report commute-predict weekly-coach health --no-verify-jwt

echo "Done. Open /setup.html on your site and press Check everything."
