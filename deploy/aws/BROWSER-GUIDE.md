# Task: host BorrowHood on AWS using only the browser

You are helping the user deploy their web app **BorrowHood** to their AWS account. Everything happens in the AWS web console and **AWS CloudShell** (a terminal inside the AWS console). Nothing needs to be installed on the user's computer.

The project already contains a deploy script that creates all the AWS resources (EC2, S3, CloudFront, SNS, SQS, SES, CloudWatch). Your job is to open the right pages, run the commands below, and report progress.

## Rules

- **Stop and ask the user** before anything involving passwords, payment details, phone or identity verification, MFA codes, or clicking links in their email. Let the user type these themselves.
- Never copy passwords, secret keys or the admin password into chat, notes or any website other than the one that needs them.
- Only create what this guide describes. Do not create NAT gateways, load balancers, RDS databases or extra EC2 instances: they cost money.
- Do not delete anything unless the user asks.
- If a step fails, stop, show the user the error text, and use the Troubleshooting section.
- Keep the region at **Europe (Stockholm) `eu-north-1`** unless a step says otherwise.

## Values to collect from the user first

Ask for these before you start:

| Value | Example | Used for |
|---|---|---|
| Alert email | `rizve@example.com` | Alarm and budget emails |
| Admin email | `rizve@example.com` | BorrowHood's master admin login |
| Domain (optional, for Part 3) | `borrowhood.no` | The site's address |
| Where the domain is registered (optional) | Namecheap, Domeneshop… | Adding DNS records |

## Part 1: Prepare the AWS account

1. Go to <https://console.aws.amazon.com> and check that the user is signed in. If they have no account, open <https://aws.amazon.com/free> → **Create a free account**, and **let the user complete sign-up themselves** (email, password, card, phone verification). If asked, choose the **Free plan**.
2. Make sure the root account has MFA: account menu (top right) → **Security credentials** → **Multi-factor authentication**. If none is listed, ask the user to add one (they must scan the code with their phone).
3. In the region selector (top right, next to the account name), choose **Europe (Stockholm) eu-north-1**.
4. Check the credit: search for **Billing and Cost Management** → **Credits**. Tell the user the remaining amount and the expiry date.

## Part 2: Deploy the app

1. Open **CloudShell**: click the terminal icon `>_` in the top bar, or go to <https://eu-north-1.console.aws.amazon.com/cloudshell>. Wait until the prompt appears.
2. Download the project:
   ```bash
   git clone https://github.com/RizveOve/borrowhood.git
   cd borrowhood
   ls deploy/aws
   ```
   The `ls` output must include `deploy.sh` and `template.yaml`. If it doesn't, stop: the user has not merged the AWS setup into the `main` branch on GitHub yet.
3. Create the settings file. Replace the two email addresses with the user's values:
   ```bash
   cp deploy/aws/config.example.env deploy/aws/config.env
   sed -i 's/^ALERT_EMAIL=.*/ALERT_EMAIL=ALERT_EMAIL_HERE/; s/^ADMIN_EMAIL=.*/ADMIN_EMAIL=ADMIN_EMAIL_HERE/' deploy/aws/config.env
   cat deploy/aws/config.env
   ```
   Check that both emails now appear in the output. Leave the domain fields empty for now.
4. Run the deploy:
   ```bash
   deploy/aws/deploy.sh
   ```
   The first run takes **10–20 minutes** (CloudFront is slow to create). Don't close the tab. If CloudShell times out, reopen it and run `cd borrowhood && deploy/aws/deploy.sh` again; it continues safely.
5. When it finishes, it prints **"BorrowHood is live: https://….cloudfront.net"**. Give the user that link.
6. Tell the user to check the alert email inbox for **"AWS Notification - Subscription Confirmation"** and click **Confirm subscription** themselves.
7. Show the user how to get the admin password. Let them run this themselves, or run it and tell them it's on screen without repeating it in chat:
   ```bash
   aws ssm get-parameter --name /borrowhood/secrets/ADMIN_PASSWORD --with-decryption --query Parameter.Value --output text
   ```
8. Open the site link and confirm the BorrowHood page loads. The user logs in with the admin email and that password.

## Part 3 (optional): Use the user's own domain

### 3a. HTTPS certificate

1. Switch the region to **US East (N. Virginia) us-east-1**. CloudFront only accepts certificates from there.
2. Go to **Certificate Manager (ACM)** → **Request** → **Request a public certificate**.
3. Domain name: the user's domain, e.g. `borrowhood.no`. Validation: **DNS validation**. Click **Request**.
4. Open the certificate and copy the **CNAME name** and **CNAME value**.
5. Open the user's domain registrar website (the user must be logged in) → DNS settings → add a **CNAME** record with that name and value.
   - Many registrars add the domain to the name automatically. In that case, enter only the part before the domain.
6. Wait until the certificate status is **Issued** (5–30 minutes). Copy its **ARN**, which starts with `arn:aws:acm:us-east-1:`.
7. Switch the region back to **eu-north-1**.

### 3b. Point the site at the domain

1. In CloudShell, set the domain and certificate (replace both values):
   ```bash
   cd ~/borrowhood
   sed -i 's|^DOMAIN_NAME=.*|DOMAIN_NAME=borrowhood.no|; s|^CERTIFICATE_ARN=.*|CERTIFICATE_ARN=arn:aws:acm:us-east-1:...|' deploy/aws/config.env
   deploy/aws/deploy.sh
   ```
2. Get the CloudFront address:
   ```bash
   aws cloudformation describe-stacks --stack-name borrowhood --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text
   ```
3. At the registrar, point the domain at that address (it looks like `d123abc.cloudfront.net`):
   - **Root domain** (`borrowhood.no`): add an **ALIAS**, **ANAME** or **CNAME-flattening** record if the registrar offers one.
   - If it doesn't, tell the user. The fix is to use `www.borrowhood.no` as `DOMAIN_NAME` instead (with a certificate for `www.`), add a normal **CNAME** for `www`, and redirect the root to `www` in the registrar's settings.
4. After a few minutes, open `https://<domain>` and confirm it loads.

## Part 4 (optional): Real emails with SES

1. In CloudShell (replace the domain):
   ```bash
   cd ~/borrowhood
   sed -i 's|^MAIL_DOMAIN=.*|MAIL_DOMAIN=borrowhood.no|; s|^SES_FROM=.*|SES_FROM=no-reply@borrowhood.no|' deploy/aws/config.env
   deploy/aws/deploy.sh
   ```
2. The end of the output lists **three CNAME records** (DKIM). Add all three at the registrar.
3. Also add a **TXT** record with name `_dmarc` and value `v=DMARC1; p=none;`.
4. In the AWS console (eu-north-1) go to **Amazon SES** → **Identities**. Wait until the domain shows **Verified** (up to 72 hours, usually under 1 hour).
5. SES → **Account dashboard** → **Request production access**. Fill the form:
   - Mail type: **Transactional**
   - Website URL: the site address
   - Use case description, which you can suggest to the user: *"BorrowHood is a neighbourhood tool-lending app. It sends transactional emails only: loan requests, approvals, return reminders and overdue notices to registered users. Users sign up themselves; there is no marketing email. Bounces and complaints are monitored."*

   Let the user review and submit it. Until AWS approves it (usually within 24 hours), emails only reach verified addresses.

## Updating the site later

After the user pushes new code to GitHub `main`:

```bash
cd ~/borrowhood && git pull && deploy/aws/deploy.sh
```

CloudShell keeps the `borrowhood` folder and `config.env` between sessions. They are deleted after 120 days without using CloudShell; if that happens, redo Part 2, steps 2–3, and keep the same values.

## Troubleshooting

| Problem | What to do |
|---|---|
| `deploy.sh` says "not the same commit as origin/main" | Run `git pull`, then try again. |
| Stack failed: `ROLLBACK_COMPLETE` | Open **CloudFormation** → stack **borrowhood** → **Events** tab. Copy the first red **CREATE_FAILED** reason to the user. Then delete the stack (**Delete** button, after the user agrees) and run `deploy.sh` again. |
| Error mentions the account, free plan, or "not authorized to use this service" | Tell the user. They may need to upgrade from the Free plan to a paid plan (Billing → Account plan). Remaining credits are kept. |
| The site shows 502/504 right after the first deploy | The server is still installing. Wait 5 minutes and reload. |
| The site still fails | CloudWatch → **Log groups** → `/borrowhood/app` → open the newest stream and show the user the last error lines. |
| A shell on the server is needed | **EC2** → **Instances** → `borrowhood` → **Connect** → **Session Manager** → **Connect**. (SSH is disabled on purpose.) |

## Expected cost

About **$10 a month**, paid from the credits. The deploy also creates a **$10/month budget** that emails the user at 50% of it. If the user wants it cheaper, set `INSTANCE_TYPE=t4g.nano` in `config.env` and redeploy, for about $7 a month.
