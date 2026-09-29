# Ticket Radar DC

Speed-camera and ticket-zone warnings for drivers in DC, Maryland and Virginia, as a web app. It includes a community report map and seven AI helpers.

```
www/                 The web app. This folder is what you upload to Netlify.
www/setup.html       The setup dashboard: walks through Netlify + Supabase and checks each step
supabase/migrations  Database: tables, security rules, status check, schedules
supabase/functions   The AI agents, account deletion, and the health check
scripts/             Helpers (bundle libraries, deploy agents, write config from Netlify env vars)
netlify.toml         Only used if Netlify deploys from GitHub
```

## Quick start

1. Go to https://app.netlify.com/drop and drag the **`www`** folder onto the page.
2. Open **`https://YOUR-SITE.netlify.app/setup.html`**.
3. Follow the six steps. Each one checks itself, and the page fills in your project details in every command and SQL snippet. Press **Check everything** after each step.

| Step | What it does | Checked automatically? |
|---|---|---|
| 1. Put the site on Netlify | https, Netlify settings file, offline support | Yes |
| 2. Connect your Supabase project | Validates your URL and key, and refuses secret or service_role keys | Yes |
| 3. Build the database | One copy-paste into the Supabase SQL editor | Yes |
| 4. Set up sign-in emails | Email template with the 6-digit code, Site URL, custom SMTP | No, you tick it yourself |
| 5. Connect the live app | Download `config.js`, or use Netlify environment variables | Yes |
| 6. Turn on the AI agents | Deploy commands, secrets, Vault SQL, schedules, first camera load | Yes, 9 checks |

At the bottom, **Live health** shows the official camera count, each county source's last run, each schedule's last result, and whether reports are stuck waiting for the moderator. You can come back to it anytime.

## Two ways to update the site on Netlify

- **Drag and drop:** open your site in Netlify → **Deploys** and drag the `www` folder onto that page. Don't use the Drop page again, because that creates a new site with a new address.
- **From GitHub:** push this folder to a repo and connect it in Netlify. Add these under Site configuration → Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TR_COMPANY`, `TR_CONTACT_EMAIL`. Each deploy writes `config.js` for you. Setup step 5 shows the exact values.

## What you need for step 6

- Node.js installed (https://nodejs.org). The commands use `npx supabase`, so nothing else needs installing.
- An Anthropic API key (https://console.anthropic.com).
- Optional: a Resend account for the Monday coach email and for custom sign-in email (https://resend.com).

The dashboard generates a private scheduler secret in your browser and puts the same value into both the terminal command and the Vault SQL. Run both from the dashboard so they match; the dashboard checks that they do.

## What each agent does

| Agent | Runs | Does |
|---|---|---|
| scan-ticket | When you scan | Reads a ticket photo, fills in the form, places it on the map, and matches the official camera. Plate and notice numbers are ignored, and the photo isn't stored. |
| voice-assist | Voice questions that aren't simple commands | Answers "is anything ahead on Wisconsin?" from nearby cameras, your tickets and live reports. Simple commands ("report police", "what's ahead", "speed limit", "undo") run on the phone with no AI call. |
| moderate-report | Every new or edited report | Removes names, plates and phone numbers; hides threats, harassment and spam; merges duplicate reports. |
| camera-sync | Daily at 5:15 am ET | Loads DC's official camera list, plus the county pages in `camera_sources` (Montgomery County and Gaithersburg to start). |
| commute-predict | Nightly | Finds trips you repeat and suggests commute schedules. It needs about 6 logged drives. |
| dispute-helper | When you ask | Checks the deadline, lists possible grounds and evidence, and drafts a statement. This is general information, not legal advice. |
| weekly-coach | Mondays at 7:45 am ET, or on demand | Writes a short review of your driving week, emailed if Resend is set up. |
| health | When you use the setup dashboard | Reports which agents are deployed and which secrets are set (yes/no only). |

Each person has daily AI limits (scan 20, voice 150, dispute 10, coach 3). You can change them in each function's `quota(...)` line.

## Using it as a web app

- **Keep the app open on screen while driving.** Browsers pause GPS when the phone locks or you switch apps. A phone mount with the app visible, or split-screen on Android, works best. The app asks the phone to keep the screen awake.
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
