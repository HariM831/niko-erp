# Deploying niko to a DigitalOcean Droplet

One Droplet running two copies of the app — production and staging — behind
nginx, against a managed Postgres cluster holding one database each.

Why a Droplet rather than App Platform: roughly $25/mo against $65/mo at the
same specs, and the app runs the IoT poller *inside* the web process
(`startIotPolling()` in `server/index.ts`). Scale App Platform past one
instance and that scheduler runs twice, polling the sheds' controllers in
duplicate, unless it is split into its own worker first.

## What you need

| | |
|---|---|
| Droplet | 2 vCPU / 4 GB Ubuntu 24.04, ~$24/mo |
| Postgres | DO Managed, smallest tier, ~$15/mo |
| Domain | `niko.example.com` and `staging.niko.example.com` → the Droplet's IP |

Managed Postgres is the recommendation, and the reason is narrow: **7-day
point-in-time recovery**. Restoring to any second covers the failure that
actually happens to an ERP — a bad bulk edit nobody notices until Thursday.
Self-hosting on the Droplet is free and fine for the load (203 MB, one user),
but then backups are yours to build, test and remember.

Both databases live in the **one** cluster. There is no per-database charge,
and they are fully isolated from each other.

## 1. The database

In the DO panel, create the cluster, then add two databases: `niko` and
`niko_staging`. Restrict *Trusted Sources* to the Droplet.

Copy the connection string. Note the **connection limit on the smallest tier
is 22** — with two app instances at the driver's default pool of 10 each you
would be at 20 before a migration or a `psql` session gets a look in. Set
`PGPOOL_MAX=5` in both env files.

## 2. The Droplet

```bash
adduser --system --group --home /srv/niko niko
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
apt install -y nginx postgresql-client git
```

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
```

Only 22, 80 and 443 are open. The app's own ports (3000, 3001) are bound to
localhost and never exposed — nginx reaches them from inside the box.

## 3. Checkouts

Two, deliberately. Sharing one directory means a `git pull` for either
redeploys both, and they would share an uploads directory.

```bash
git clone https://github.com/HariM831/niko-erp.git /srv/niko
git clone https://github.com/HariM831/niko-erp.git /srv/niko-staging
chown -R niko:niko /srv/niko /srv/niko-staging
```

## 4. Configuration

Config lives in `/etc/niko/`, **not** in a `.env` inside the checkout. A
deploy pulls the repo and must never be able to overwrite the config — and a
service whose env file is missing should fail to start rather than quietly
fall back to whatever `.env` is lying next to the code.

```bash
mkdir -p /etc/niko
cp deploy/prod.env.example    /etc/niko/prod.env
cp deploy/staging.env.example /etc/niko/staging.env
chmod 600 /etc/niko/*.env && chown niko:niko /etc/niko/*.env
```

Fill both in. The one rule that matters: **leave `BH_TOKEN` and
`GEMINI_API_KEY` out of `staging.env`.** Both integrations are gated on their
key being present — the IoT poller logs one line and stops — so omitting them
is what stops staging polling bhfarm.net alongside production and spending
Gemini quota on test runs.

Generate the session secret with `openssl rand -hex 32`. Use a *different*
one for staging, so a staging cookie is not valid against production.

## 5. Services

```bash
cp deploy/niko.service deploy/niko-staging.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now niko niko-staging
```

## 6. nginx and TLS

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/niko
ln -s /etc/nginx/sites-available/niko /etc/nginx/sites-enabled/niko
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d niko.example.com -d staging.niko.example.com
```

Edit the staging server block to `allow` only your own IP before pointing
anyone at it. Staging holds a copy of the real books — scrubbed of bank
details, but still every vendor, invoice and wage.

## 7. First deploy

```bash
sudo -u niko bash -c 'cd /srv/niko && ./scripts/deploy.sh'
sudo -u niko bash -c 'cd /srv/niko-staging && SERVICE=niko-staging APP_DIR=/srv/niko-staging ./scripts/deploy.sh'
```

The production database already carries its schema, so `db:migrate` is a
no-op there. Staging starts empty — fill it in the next step.

## Day to day

**Deploy:** `cd /srv/niko && ./scripts/deploy.sh`

Pulls, installs, builds, migrates, restarts, and then waits for the port to
actually answer — systemd calls a start successful the moment the process
spawns, which proves nothing. It refuses to run if the server's working tree
is dirty, rather than discarding a hand-edit someone made in an emergency.

**Refresh staging:** `./scripts/refresh-staging.sh`

Rebuilds `niko_staging` from production with every bank account, IFSC and
password hash stripped, and verifies the scrub before bringing staging back
up. Fake account numbers on staging are the point, not a limitation: a
payment file built from them fails harmlessly at the bank.

**Logs:** `journalctl -u niko -f`

**Roll back:** deploys are plain git checkouts, so
`git reset --hard <sha> && npm ci && npm run build && sudo systemctl restart niko`.
A migration does not roll back with the code — check what the release added
before reversing one.

## Things that will bite

**Uploads are on the Droplet's disk**, under each checkout's `uploads/`, not
in the database. They are not in the Postgres backup. Back them up separately
(`rsync` to DO Spaces on a cron) or they are gone with the box.

**Migrations run before the new code starts.** The old process tolerates a
column it does not know about; the new one cannot tolerate a column that is
not there yet.

**The IoT token expires.** `BH_TOKEN` is good for about 180 days and the
poller warns in the logs for the last 30. Nothing else announces it, and an
expired token looks exactly like a farm with no sensors.
