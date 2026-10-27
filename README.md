# BorrowHood

Neighbours lend and borrow tools instead of buying them.
AWS re/Start Portfolio Project.

**Problem:** people buy a drill, ladder or tent for one job while the same item sits unused next door. Asking in a group chat is awkward and the request gets lost.
**Customer:** residents of apartment buildings, housing cooperatives (borettslag) and student housing.
**Solution:** each building gets a shared catalogue, with loan requests, approvals and automatic return reminders.

## Features (MVP)

- Sign up with any valid email, log in, and join a neighbourhood with a join code, or create one. Invites can be shared as a link: `/join/CODE`.
- List an item with a photo, category, pick-up location and description.
- Browse every item across all neighbourhoods. Search, filter by category, neighbourhood (yours, the BorrowHood shelf or any other) and "available now", and sort by nearest first, newest, most borrowed or A–Z.
- Request an item for a date range. The owner approves or declines it, and the app blocks double bookings.
- Get a reminder the day before the return date and an overdue alert to both sides, in the app and by email.
- The owner marks the item as returned.
- **Messages between neighbours:** ask an owner a question from the item page ("Ask … a question"), or message the other person from a loan. Conversations are private to the two people (shelf items are answered by the admin), with an unread badge on the Messages tab. Open chats update live (new messages appear within a few seconds, without reloading).
- **Dugnad** (`/dugnad`, the tab next to About): neighbours organise community work days. See [Dugnad](#dugnad) below.
- **About & contact page** (`/about`): who we are, a short FAQ and a contact form for questions, problems and reports. It's linked from the main menu, item pages have a "Report this item" link, and each message notifies the admin and lands in the dashboard to reply to and resolve.
- **English / Norwegian (bokmål):** the EN/NO toggle in the header switches the whole app. Logged-in users keep their choice, and their notifications and emails are written in it. Visitors get Norwegian automatically if their browser asks for it. Strings live in `src/i18n.js`.
- **Master admin:** a dashboard with stats, overdue loans, every neighbourhood, user, item and loan. The admin can delete users, items and neighbourhoods, rotate join codes and run the reminder job on demand.
- **Organisation items (the BorrowHood shelf):** items owned by BorrowHood itself, visible to every neighbourhood, with requests approved by the admin. Six are seeded on first start.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js 22+, Express 5 | Small, well-known, one process |
| Views | EJS (server-rendered) + one CSS file | No build step, fast on phones |
| Database | SQLite (built-in `node:sqlite`) | No DB server to run, file on EBS |
| Photos | Amazon S3 (private bucket), local disk in dev | Served through the app, so the bucket is never public |
| Email | Amazon SES, console in dev | Reminders and request emails |
| Reminders | Hourly in-process job | Day-before reminder and overdue alert |

## Run locally

```bash
cp .env.example .env      # optional
npm install
npm run seed:demo         # optional demo data
npm run dev               # http://localhost:3000
```

- **Admin:** `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`, which default to `admin@borrowhood.no` / `change-me-please`. If no password is set, a random one is printed to the console on first start.
- **Demo users** (password `password123` for all; full table in [CREDENTIALS.md](CREDENTIALS.md)):
  - Solsiden Borettslag, join code `DEMO42`: `kari@example.com`, `ola@example.com`, `amira@example.com`
  - Moholt Studentby, join code `MOHO24`: `jonas@example.com`, `lin@example.com`

## Item photos

Seed and demo items use real photos from [Wikimedia Commons](https://commons.wikimedia.org), stored in `seed/photos/`. They are public domain or Creative Commons licensed, and the author and license of each are recorded in `seed/photos/credits.json` and shown under the photo on the item page. To change the photo set, edit the list in `scripts/fetch-photos.js` and run `node scripts/fetch-photos.js`.

## Deploy to Netlify (free)

The repo is ready for Netlify. Static files (CSS, JS, icons, stock photos) are served from Netlify's CDN, and every page request runs the Express app inside a Netlify Function. There's no separate database service to set up: the SQLite database file and all uploaded photos are stored in **Netlify Blobs**, Netlify's built-in storage, which is free.

1. On [app.netlify.com](https://app.netlify.com), choose **Add new site → Import an existing project → GitHub** and pick `RizveOve/borrowhood`. Netlify reads the build settings from `netlify.toml`, so leave them as they are.
2. **Before the first deploy**, open **Site configuration → Environment variables** and add:
   | Variable | Value |
   |---|---|
   | `ADMIN_EMAIL` | the master admin's login email |
   | `ADMIN_PASSWORD` | a strong password for the admin |
   | `SEED_DEMO` | `0` if you **don't** want the demo neighbourhoods and users (on by default) |

   The admin account is created the first time the site is visited. `ADMIN_PASSWORD` is always the admin's current password: to change it later, update the variable and redeploy (**Deploys → Trigger deploy**). If you never set it, a random password is printed once under **Logs → Functions → app**.
3. Click **Deploy**. The site is live at `https://<your-site-name>.netlify.app`. Every push to `main` redeploys automatically, and the saved data stays.

What runs where on Netlify:

| Part | How |
|---|---|
| Pages | `netlify/functions/app.mjs` forwards each request to the Express app (`src/netlify.js`) |
| Database | SQLite file saved to Netlify Blobs after each change. Every request first checks for a newer copy, and simultaneous saves are retried, so nothing is lost. |
| Photos | Netlify Blobs (store `photos`) |
| Reminders | `netlify/functions/reminders.mjs`, a scheduled function that runs every hour |
| Cookie secret | Generated once and kept in Blobs, unless you set `SESSION_SECRET` |
| Email | Not sent on Netlify. Reminders appear as in-app notifications, and email text goes to the function logs. |

Limits to know: this setup is meant for a demo or a small community, not heavy traffic. Photos must be under 4 MB, but phones resize them automatically. To test the Netlify setup locally, run `npx netlify-cli dev`.

## AWS architecture

```
 Phone browser ──HTTP(S)──► EC2 (Amazon Linux 2023, t3.micro)
                              nginx :80 ─► Node app :3000 ─► SQLite on EBS
                                               │
                                IAM role ──────┼──► S3  (item photos, private)
                                               └──► SES (reminder emails)
                              CloudWatch Logs / Alarms (optional)
```

### Deploy steps

1. **S3:** create a private bucket, for example `borrowhood-photos-<team>`, with Block Public Access on.
2. **SES:** verify a sender address. In the SES sandbox you must also verify each recipient address, so verify your team's emails for the demo.
3. **IAM role for EC2:** grant `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/items/*`, plus `ses:SendEmail`.
4. **Security group:** allow inbound 80 (and 443 if you add HTTPS) from anywhere, and 22 from your IP only.
5. **EC2:** launch Amazon Linux 2023, attach the role, and paste [deploy/user-data.sh](deploy/user-data.sh) as user data after editing `S3_BUCKET` and `SES_FROM`.
6. Open `http://<public-ip>`. To get the admin password, run `sudo grep ADMIN_PASSWORD /opt/borrowhood/.env`.

Logs: `sudo journalctl -u borrowhood -f`. Health check: `GET /health`.

### Possible next steps

- HTTPS with an ALB and ACM certificate, or CloudFront. Then set `COOKIE_SECURE=1`.
- Daily EBS snapshots with Data Lifecycle Manager, or move to RDS when running more than one instance.
- Run the reminder job from EventBridge Scheduler and Lambda instead of in-process.
- Email verification at sign-up, and rate limiting on login.

## Dugnad

A dugnad is a Norwegian community work day. The feature lives in the existing app and reuses its users, neighbourhoods, items, loans, notifications and reminder job.

**Pages**

| Route | What it is |
|---|---|
| `/dugnad` | Introduction with photos, search and filters (upcoming, my neighbourhood, I organise, I take part in, open for registration, completed) |
| `/dugnad/create`, `/dugnad/:id/edit/1-6` | Six-step wizard: basics, date and place, participation (rules and invitations), tasks, equipment, review. A draft is saved at every step; publish when ready |
| `/dugnad/:id` | Event page: details, registration, tasks and volunteering, equipment, equipment requests and offers, announcements, participants, share and report |
| `/dugnad/my-events` | Events I organise, drafts, events ready to wrap up, events I take part in, completed and attended, each with the next action |
| `/dugnad/:id/manage` | Organiser tools: participants and attendance, assigning volunteers, equipment planner, community requests and offers, announcements, finish |
| `/dugnad/:id/equipment/:rid/find` | Search the item library for a requirement and ask to borrow |
| `/dugnad/:id/complete` | Confirmation, summary and notes when closing an event |

**How it fits with the rest**

- Equipment is never duplicated. A requirement links to an existing item, and "Request to borrow" creates an ordinary pending loan (`src/loan-requests.js`, the same code as the item page). The owner approves or declines in Loans. The planner reads each link's status from the loan itself, so approval, rejection, cancellation, active and returned are always in step. Listing in the library never counts as secured; "I'll bring my own" is the only link without a loan.
- Completing or cancelling a dugnad does not touch loans. Removing a requirement removes only the Dugnad side, and asks first when loan requests exist.
- Equipment checklists (cleanup, gardening, painting, snow clearing, gathering) are stored centrally. Applying one copies its items into the event, so editing a template never changes an existing event.
- Organisers can ask neighbours for equipment. A neighbour offers one of their own listed items, the organiser asks to borrow it through the loan system, and the request counts as fulfilled only by approved loans (three rakes needed, one approved: partially fulfilled).
- Registration rules: sign-up required or not, approval, participant limit with a waiting list, and whether people can cancel. The organiser takes the first place. When approval is on, task volunteering also waits for the organiser.
- Visibility: drafts are private; a "private" event is only for invited neighbours and participants; everything else is visible in the organiser's neighbourhood (admin events everywhere). The full address, map link and participant list are only shown to people who signed up. Every action is checked on the server.
- Notifications use the existing bell and email (`src/notify.js`). People hear about sign-ups, approvals, tasks, equipment offers, changed details, announcements, cancellation and completion. The hourly job (`src/jobs.js`, also the Netlify schedule) sends a reminder the day before, one up to four hours before, and a deadline reminder to invited people who have not signed up; each is sent once per person and event. With no `SES_FROM` set, emails are only printed to the console, as for the rest of the app; no new environment variables are needed.
- Times are plain dates and times in the app's time zone (`APP_TZ`, default Europe/Oslo), like loan dates.

**Data**: `dugnad_events`, `dugnad_participants`, `dugnad_invites`, `dugnad_tasks`, `dugnad_task_assignments`, `dugnad_equipment_requirements`, `dugnad_equipment_links`, `dugnad_equipment_requests`, `dugnad_equipment_offers`, `dugnad_checklist_templates` (+ `_items`), `dugnad_announcements`, `dugnad_reminders`. The schema is created on start. Events and sign-ups from the first, simpler version are migrated automatically.

**Not included**: comments or discussion on events, scheduled announcements and announcement attachments, per-user notification preferences, a waiting-list position display, and public (logged-out) browsing of events. Destructive actions use the browser's confirm dialog, like the rest of the app.

## Tests

`npm test` runs the automated tests (Node's built-in test runner, no extra dependencies). They start the real app on a temporary database and cover events, registration, tasks, equipment and loans, notifications and reminders, privacy and permissions, translations, and the migration from the first version.

## Project structure

```
src/
  app.js           Express app: middleware, routes, first-run setup
  server.js        starts the app as a normal server (local / EC2)
  netlify.js       runs the app inside Netlify Functions, data in Netlify Blobs
  paths.js         locates the project root (also inside bundled functions)
  db.js            schema, admin + shelf seed
  auth.js          session user, guards, flash messages
  items.js         item visibility / permission helpers
  storage.js       S3 or local photo storage
  notify.js        in-app notifications + SES email
  jobs.js          return reminders and overdue alerts, and Dugnad reminders
  loan-requests.js creating a loan request (item page and Dugnad planner)
  dugnad.js        Dugnad rules: access, registration, tasks, equipment status, reminders
  dugnad-templates.js  equipment checklists seeded into the database
  i18n-dugnad.js   Dugnad strings (English + Norwegian)
  routes/          auth, neighbourhood, items, loans, account, admin, dugnad, dugnad-work
  seed.js          shelf items + stock photos
  i18n.js          English + Norwegian strings
views/             EJS templates (mobile-first, desktop layout from 900px)
seed/photos/       stock photos + credits.json
public/            style.css, app.js (photo resize, share, confirms)
deploy/            EC2 user data + systemd unit
netlify/functions/ Netlify entry points (pages + hourly reminders)
netlify.toml       Netlify build settings
scripts/          seed-demo.js, fetch-photos.js
test/              automated tests (npm test)
```
