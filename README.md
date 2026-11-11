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
| Email | SNS → SQS → Amazon SES on AWS, console in dev | Queued and retried, never slows a page |
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

## Deploy to AWS (low cost)

One small EC2 instance runs the app, and everything around it uses AWS free tiers. The frontend and backend are separated: visitors only ever talk to CloudFront, which serves the frontend files from a private S3 bucket and forwards page requests to an EC2 instance that nobody else can reach.

```
                         ┌──► S3 frontend bucket (private, CloudFront only): CSS, JS, icons, stock photos
Visitor ──HTTPS──► CloudFront (free HTTPS, your domain via ACM)
                         └──► EC2 t4g.micro (port 80 open to CloudFront only, secret origin header)
                                nginx ─► Node/Express ─► SQLite on encrypted EBS
                                   │                       └─ Litestream ─► S3 data bucket (continuous backup)
                                   ├─► S3 data bucket (item photos, private)
                                   ├─► SNS topic ─► SQS queue (+ dead-letter queue) ─► mail worker ─► SES
                                   └─► SSM Parameter Store (settings, secrets)
CloudWatch: logs (14 days), disk/memory metrics, alarms ─► SNS ─► your email   ·   AWS Budgets ─► your email
```

| Service | Used for | Cost |
|---|---|---|
| EC2 t4g.micro (Graviton), standard CPU credits | The app | ~$6/month |
| Elastic IP (public IPv4) | Fixed origin address for CloudFront | ~$3.60/month |
| EBS gp3 8 GB, encrypted | System + SQLite database | ~$0.70/month |
| CloudFront | HTTPS, CDN for frontend files, the only way in | Free tier |
| S3 (2 buckets) + gateway endpoint | Frontend files, photos, database backups | Cents |
| SNS + SQS | Email queue with retries and a dead-letter queue | Free tier |
| SES | Emails | $0.10 per 1,000 |
| SSM | Parameter Store, Session Manager (no SSH), Run Command (deploys) | Free |
| CloudWatch | Logs, 4 alarms (auto-recover, auto-reboot, disk, failed emails) | Free tier |
| ACM, Route 53 (optional) | Certificate; DNS at $0.50/month | Free / $0.50 |

About **$10/month**, so the $100 sign-up credit lasts around 10 months. Use `t4g.nano` (0.5 GB memory) for about $7. There's deliberately no NAT gateway, load balancer, RDS or Secrets Manager: they would cost more than everything above together.

### Security

- Only CloudFront's IP ranges can reach port 80, and nginx also rejects requests without the secret `X-Origin-Verify` header that CloudFront adds. Port 22 is closed; use `aws ssm start-session`.
- Both buckets are private, encrypted and HTTPS-only. Only CloudFront can read the frontend bucket.
- The instance role can only touch its own S3 paths, SNS topic, SQS queue and parameters. No AWS keys are stored anywhere.
- Secrets (`SESSION_SECRET`, `ADMIN_PASSWORD`) are SecureString parameters, written to a root-only `.env`.
- The app runs as an unprivileged user in a systemd sandbox and can only write its data and log folders.
- CloudFront adds HSTS, and only accepts HTTPS from visitors (TLS 1.2+ on a custom domain).

### First deploy

1. Install the [AWS CLI v2](https://aws.amazon.com/cli/) and run `aws configure` (or `aws sso login`).
2. `cp deploy/aws/config.example.env deploy/aws/config.env` and fill in `ALERT_EMAIL` and `ADMIN_EMAIL`. Leave the domain fields empty for now.
3. Push your code, then run `deploy/aws/deploy.sh`. It takes about 10 minutes the first time and prints the site URL (`https://xxxx.cloudfront.net`) and how to read the admin password.
4. Confirm the "AWS Notification" email so alarms reach you.

Every later `deploy/aws/deploy.sh` uploads the frontend files, clears the CloudFront cache and updates the server through SSM. The server always runs the pushed commit of `BRANCH`, so push first.

### Your own domain

1. In **ACM, region us-east-1** (CloudFront requires it), request a certificate for your domain and add the CNAME record it shows. Wait until it says *Issued*.
2. Set `DOMAIN_NAME` and `CERTIFICATE_ARN` in `config.env`, plus `HOSTED_ZONE_ID` if the domain's DNS is in Route 53, and deploy again.
3. Without Route 53, point the domain at the `CloudFrontDomain` output yourself: a CNAME for `www.`, or an ALIAS/ANAME/flattened record for the root domain if your DNS provider supports it.

### Email (SES)

1. Set `MAIL_DOMAIN` (e.g. `borrowhood.no`) and `SES_FROM` (e.g. `no-reply@borrowhood.no`) and deploy. With Route 53 the DKIM records are added for you; otherwise the script prints three CNAME records to add.
2. Add a DMARC record: `_dmarc.<domain>` TXT `v=DMARC1; p=none;`
3. In the SES console, **request production access**. Until then SES only sends to addresses you have verified.

Emails are published to SNS, queued in SQS and sent by a worker inside the app, so a slow SES call never delays a page and failed emails are retried 5 times before landing in the dead-letter queue (which triggers an alarm).

### Running it

- Logs: CloudWatch log group `/borrowhood/app`, or on the server `tail -f /var/log/borrowhood/app.log`.
- Shell: `aws ssm start-session --target <InstanceId>`.
- Change the admin password: update the SSM parameter `/borrowhood/secrets/ADMIN_PASSWORD` and deploy.
- Backups: Litestream streams every database change to `s3://<DataBucket>/litestream/` (kept 7 days). A fresh instance restores it automatically on boot. The data bucket is kept even if the stack is deleted.
- Remove everything: `aws cloudformation delete-stack --stack-name borrowhood` (empty the frontend bucket first), then delete the data bucket and the `borrowhood-monthly` budget if you don't need them.

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
  notify.js        in-app notifications + email (SNS on AWS, else SES / console)
  mailer.js        sends queued emails from SQS through SES (AWS)
  jobs.js          return reminders and overdue alerts
  routes/          auth, neighbourhood, items, loans, account, admin
  seed.js          shelf items + stock photos
  i18n.js          English + Norwegian strings
views/             EJS templates (mobile-first, desktop layout from 900px)
seed/photos/       stock photos + credits.json
public/            style.css, app.js (photo resize, share, confirms)
deploy/aws/        CloudFormation template, deploy script, server setup script
netlify/functions/ Netlify entry points (pages + hourly reminders)
netlify.toml       Netlify build settings
scripts/          seed-demo.js, fetch-photos.js
```
