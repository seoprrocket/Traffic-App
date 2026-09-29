# Invictus Traffic Radar

Speed-camera and ticket-zone warnings for drivers in DC and Maryland, as a web app. It includes a community report map and seven AI helpers.

```
www/                 The web app (what Netlify publishes)
netlify/functions    Live traffic, "time to leave" notifications, Share drive (run on Netlify)
www/setup.html       The setup dashboard: walks through Netlify + Supabase and checks each step
supabase/migrations  Database: tables, security rules, status check, schedules
supabase/functions   The AI agents, account deletion, and the health check
scripts/             Helpers (bundle libraries, deploy agents, write config from Netlify env vars)
netlify.toml         Only used if Netlify deploys from GitHub
```

## What's in the app

| Feature | Needs |
|---|---|
| Camera and ticket-zone warnings, official DC and Maryland cameras | Nothing extra |
| Live speedometer with your own speed alerts (over the limit by X, or above X mph) | Nothing extra |
| Road warnings: speed bumps, sharp curves, speed-limit drops, toll booths (OpenStreetMap) | Nothing extra |
| Hazard reports: police, accidents, emergency vehicles, potholes, debris, flooding, ice | Your own reports: nothing. Other drivers' reports: Supabase |
| Plan a Drive: leave-by time, drive time by departure, Google Maps directions, calendar | Typical times: nothing. Live traffic: Google key on Netlify |
| "Time to leave" and parking-meter notifications with the app closed | Netlify Functions + notification keys |
| Live ETA and Share drive link | Netlify Functions |
| Parking: find garages and lots, save your spot with photo and meter timer, walk back | Nothing extra |
| Accounts, sync, community map, AI scanner/coach/dispute help | Supabase |

## Quick start

1. Connect your GitHub repo to Netlify (Add new site → Import an existing project). Drag-and-drop also works, but it skips the Netlify Functions, so live traffic, notifications and Share drive won't run.
2. Open **`https://YOUR-SITE.netlify.app/setup.html`**.
3. Follow the seven steps. Each one checks itself, and the page fills in your project details in every command and SQL snippet. Press **Check everything** after each step.

| Step | What it does | Checked automatically? |
|---|---|---|
| 1. Put the site on Netlify | https, Netlify settings file, offline support | Yes |
| 2. Live traffic & notifications | Makes notification keys for you; walks through the Google Routes API key | Yes |
| 3. Connect Supabase | Validates your URL and key, and refuses secret or service_role keys | Yes |
| 4. Build the database | One copy-paste into the Supabase SQL editor | Yes |
| 5. Set up sign-in emails | Email template with the 6-digit code, Site URL, custom SMTP | No, you tick it yourself |
| 6. Connect the live app | Download `config.js`, or use Netlify environment variables | Yes |
| 7. Turn on the AI agents | Deploy commands, secrets, Vault SQL, schedules, first camera load | Yes, 9 checks |

At the bottom, **Live health** shows the official camera count, each county source's last run, each schedule's last result, and whether reports are stuck waiting for the moderator. You can come back to it anytime.

## Two ways to update the site on Netlify

- **Drag and drop:** open your site in Netlify → **Deploys** and drag the `www` folder onto that page. Don't use the Drop page again, because that creates a new site with a new address.
- **From GitHub:** push this folder to a repo and connect it in Netlify. Add these under Site configuration → Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TR_COMPANY`, `TR_CONTACT_EMAIL`. Each deploy writes `config.js` for you. Setup step 5 shows the exact values.

## What you need for step 6

- Node.js installed (https://nodejs.org). The commands use `npx supabase`, so nothing else needs installing.
- An Anthropic API key (https://console.anthropic.com).
- Optional: a Resend account for the Monday coach email and for custom sign-in email (https://resend.com).

The dashboard generates a private scheduler secret in your browser and puts the same value into both the terminal command and the Vault SQL. Run both from the dashboard so they match; the dashboard checks that they do.

## Turn on the AI features the easy way (GitHub, no terminal)

1. In your GitHub repo, open **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `SUPABASE_ACCESS_TOKEN`: from supabase.com/dashboard/account/tokens
   - `SUPABASE_PROJECT_REF`: the 20-letter code in your project URL
   - `ANTHROPIC_API_KEY`: from console.anthropic.com
   - optional: `CONTACT_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM`
2. Open **Actions → Set up Supabase and AI → Run workflow**.

In about 3 minutes it builds or updates the database, saves the keys in Supabase (with a matching scheduler secret), deploys every agent, installs the schedules and loads the cameras. It runs again automatically whenever files in `supabase/` change. The terminal steps above are only needed if you'd rather do it by hand.

## What each agent does

| Agent | Runs | Does |
|---|---|---|
| scan-ticket | When you scan | Reads a ticket photo, fills in the form, places it on the map, and matches the official camera. Plate and notice numbers are ignored, and the photo isn't stored. |
| voice-assist | Voice questions that aren't simple commands | Answers "is anything ahead on Wisconsin?" from nearby cameras, your tickets and live reports. Simple commands ("report police", "what's ahead", "speed limit", "undo") run on the phone with no AI call. |
| moderate-report | Every new or edited report | Removes names, plates and phone numbers; hides threats, harassment and spam; merges duplicate reports. |
| camera-sync | Daily at 5:15 am ET | Loads the official lists from DC, Montgomery County and Prince George's County, plus the county and town pages in `camera_sources` (Baltimore City, Anne Arundel, Howard, Calvert and Gaithersburg to start). |
| commute-predict | Nightly | Finds trips you repeat and suggests commute schedules. It needs about 6 logged drives. |
| dispute-helper | When you ask | Checks the deadline, lists possible grounds and evidence, and drafts a statement. This is general information, not legal advice. |
| weekly-coach | Mondays at 7:45 am ET, or on demand | Writes a short review of your driving week, emailed if Resend is set up. |
| health | When you use the setup dashboard | Reports which agents are deployed and which secrets are set (yes/no only). |

Each person has daily AI limits (scan 20, voice 150, dispute 10, coach 3). You can change them in each function's `quota(...)` line.

## Maryland coverage

| Area | How cameras get into the app | Needs the backend? |
|---|---|---|
| Washington, DC | DC's official camera list, with direction of travel and speed limits | No |
| Montgomery County | County open data: every camera site with its direction of travel | No |
| Prince George's County | County open data: school speed zones (the warning point is the middle of each zone) | No |
| Baltimore City, Anne Arundel, Howard, Calvert, Gaithersburg | The camera-sync agent reads each program's web page daily | Yes, with AI agents on |
| Highway work zones (SafeZones on I-95, I-495, I-270 and others) | Not published; these cameras move. Pin them or report them when you see one. | — |

Add another county or town with one line in the SQL editor:
`insert into camera_sources (jurisdiction, url) values ('Rockville, MD', 'https://…');`

If you built the database before Maryland was added, the setup dashboard (step 3) shows a **Copy Maryland update** button. Run that SQL, then redeploy camera-sync with `npx supabase functions deploy camera-sync --no-verify-jwt`.

## Netlify settings (Site configuration → Environment variables)

| Variable | For | Notes |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Phone notifications | Setup step 2 makes the keys in your browser |
| `GOOGLE_MAPS_API_KEY` | Live traffic in Plan a Drive | Google Cloud → enable Routes API → API key restricted to Routes API. Billing must be on; Google includes free monthly usage |
| `GOOGLE_DAILY_LIMIT` | Cost cap | Default 400 Google calls a day, then typical times |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TR_COMPANY`, `TR_CONTACT_EMAIL` | App settings | Written into config.js at build |

After changing variables, run **Deploys → Trigger deploy**. Saved trips, reminders and share links are stored in Netlify Blobs; nothing else to set up.

## Using it as a web app

- **Keep the app open on screen while driving.** Browsers pause GPS when the phone locks or you switch apps, and that includes switching to Google Maps for directions. On Android, split-screen with Google Maps keeps both running. On iPhone, pick one: Google Maps for directions, or Invictus Traffic Radar for warnings. "Time to leave" and meter notifications arrive either way.
- **iPhone notifications** only work after you add the app to your Home Screen and open it from there.
- **Add it to your home screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen). It opens full-screen, and the last version loads even with a weak signal.
- Voice commands work best in Chrome on Android. On iPhone, Safari support varies by iOS version.

## Before you invite other people

- Fill in your business name and contact email in setup step 5. They appear in the Privacy Policy and Terms (More → Account). Have a lawyer review both.
- Set up custom SMTP in Supabase (setup step 4). The built-in sender only emails your own team.
- When setup is done, you can remove `setup.html` from the `www` folder. To also turn off the status check, run `revoke execute on function public.setup_status() from anon;` in the SQL editor.

## What was tested, and what wasn't

Tested here:
- The database schema on PostgreSQL 17: security rules, anonymized views, votes, report expiry, spam limits, and the status check.
- The app and the setup dashboard in headless Chrome against a local copy of the schema. This covered sign-in sync, scanning (with a stand-in agent), reports, votes, routes, a simulated drive with direction-aware alerts, every page at phone width, the dashboard's key validation (it refuses service_role and secret keys), its checks, and "Use on this device."

Not tested yet, because they need your accounts:
- Real calls to Claude.
- Supabase's hosted sign-in emails.
- Netlify itself.

Official camera lists lag behind reality. The app is a reminder, and the posted signs always win.
