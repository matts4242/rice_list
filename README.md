# Rice List

A free classified ads site you can host yourself. No accounts, no fees, no
tracking — post an ad, get a private link to manage it, and let buyers contact
you without your email address ever appearing on the page.

Built with Node, Express, EJS and SQLite. There is no build step and no
external service to sign up for: `npm install && npm start` gives you a
working site.

## Quick start

```bash
npm install
npm run seed     # optional: sample categories and listings
npm start
```

Then open <http://localhost:3000>.

To enable the moderation panel, generate a password hash and put it in `.env`:

```bash
cp .env.example .env
node src/scripts/hash-password.js 'your admin password'   # prints ADMIN_PASSWORD_HASH=...
```

Sign in at `/admin/login`.

## What it does

**Browsing and search.** Listings are paginated, filterable by category, and
searchable through a SQLite FTS5 index kept in sync by triggers. Search input
is tokenised before it reaches FTS, so quotes, hyphens and stray operators in
the search box can't produce a query error, and accented or dotted letters
(café, İstanbul) match however they were typed. A search uses at most eight
distinct terms, which keeps any one query cheap.

**Posting.** Anyone can post without registering. Each ad gets a secret
management link — the only way to edit it, delete it, renew it, or read
messages about it. The link is emailed when SMTP is configured and always
shown on screen after posting, so it is never lost to a mail failure.

**Photos.** Uploads are decoded and re-encoded with sharp before touching
disk. That is what makes them safe: anything that isn't a real image fails to
decode, and EXIF metadata (including GPS coordinates) never survives the
round trip. A thumbnail is generated for listing cards. Images are checked
for their pixel count before they are decoded, so a small file that would
decode to gigabytes is refused, and transparent areas become white.

**Contacting sellers.** Buyers use a form on the listing. The message is
stored in the seller's inbox and relayed by email with the buyer set as
reply-to. The seller's address is never rendered publicly, and a relay failure
never loses the message: a relay that is down or stalls is given up on after
20 seconds, and the message stays in the inbox marked as not emailed. A hidden
honeypot field silently drops bot submissions.

**Moderation.** Anyone can report an ad. Once enough different people have
reported it, it is hidden pending review; repeat reports from the same address
count once. Moderators get a queue filtered by state, and can remove, restore,
dismiss reports, or delete permanently. Removal reasons are recorded and shown
in the panel. A removed ad stays removed: its owner cannot bring it back by
renewing it. Restoring an ad that lapsed gives it a fresh period.

**Expiry.** Listings expire after a configurable period and can be renewed
from the management link. The cutoff is applied as listings are read, so an ad
goes quiet the moment it lapses; a background sweep only tidies the stored
status afterwards.

## Configuration

Everything is optional except a session secret in production. See
`.env.example` for the full list with defaults — the settings you are most
likely to touch are `ADMIN_PASSWORD_HASH`, `LISTING_EXPIRY_DAYS`,
`AUTO_HIDE_FLAG_COUNT`, and the `SMTP_*` block.

Without SMTP the site works fine; messages are stored and shown in the
seller's inbox rather than emailed.

## Tests

```bash
npm test
```

113 tests covering validation and formatting, the posting and editing flows,
search, manage-token authentication, contact messaging and relay failure,
reporting and auto-hide, the moderation panel, image handling, expiry, rate
limiting, session creation, schema migration and startup warnings. One is
skipped on machines without IPv6.

## Layout

```
src/
  app.js            Express wiring: security headers, sessions, CSRF, routes
  server.js         Entry point
  config.js         Environment configuration with defaults
  db.js             SQLite connection, schema bootstrap, expiry sweep
  schema.sql        Tables, indexes, and the FTS5 sync triggers
  lib/              Models and helpers (listings, messages, flags, mail, …)
  middleware/       Uploads, CSRF, rate limiting, admin auth
  routes/           listings.js, messages.js, admin.js
  views/            EJS templates
  scripts/          seed.js, hash-password.js
public/             Stylesheet and the one small progressive-enhancement script
tests/              Integration and unit tests
deploy/             setup-vps.sh, install.sh, redeploy.sh
data/               SQLite database and uploads (git-ignored, created at boot)
```

## Deploying

Three scripts. `deploy/setup-vps.sh` configures the machine — updates, swap, an
admin account, SSH hardening, a firewall, fail2ban and automatic security
updates. `deploy/install.sh` then installs the application: Node, a
locked-down service account, systemd, nginx and a Let's Encrypt certificate.
`deploy/redeploy.sh` handles every update after that.

```bash
git clone https://github.com/matts4242/rice_list.git
cd rice_list

# 1. Prepare the machine. --dry-run first prints every change without
#    making any of them, which is worth reading before you commit to it.
sudo ./deploy/setup-vps.sh --dry-run --hostname ricelist \
     --admin-user you --ssh-key-file ~/.ssh/id_ed25519.pub --harden-ssh
sudo ./deploy/setup-vps.sh --hostname ricelist \
     --admin-user you --ssh-key-file ~/.ssh/id_ed25519.pub --harden-ssh

# 2. Open a second SSH session as the admin user (ssh you@your-server) and
#    check you can log in, before closing the first one. With --admin-user,
#    --harden-ssh turns root login off.

# 3. Point DNS at the box, then install the site.
sudo ./deploy/install.sh --domain ads.example.com --email you@example.com
```

`setup-vps.sh` will not disable password logins unless sshd will accept an
authorised key that is really in place: one `ssh-keygen` can parse, in a file
sshd's `AuthorizedKeysFile` reads, for an account that may log in. Afterwards
it checks with `sshd -T` that password login is really off, and if a provider
drop-in (cloud-init's, say) still turns it on, it stops and names the file.
The firewall is on by default (`--no-firewall` skips it) and is never enabled
before SSH is allowed through on every port sshd can be reached on: the
configured ports, the sockets sshd has open, and `ssh.socket` on
socket-activated Ubuntu 24.04. If it finds none, it refuses to enable it.
SSH hardening is opt-in. The script is safe to run straight after first boot:
it waits for the provider's own first `apt` run to release its locks, and it
keeps 1 GB of disk free when sizing swap.

`install.sh` puts the code in `/opt/ricelist` and the database and uploads in
`/var/lib/ricelist`, outside the checkout, so re-running it upgrades the site
without touching your data, session secret or admin password. A re-run edits
`.env` in place: it updates only the settings it manages, keeps everything you
added (`SMTP_*`, `MAIL_FROM`, tuned limits), reads values the way the app does
(the last line for a key wins), and saves the old file to
`/var/backups/ricelist/env-<timestamp>`. An existing Let's Encrypt certificate
is reused without contacting Let's Encrypt, so HTTPS stays up during updates.
`--firewall` allows SSH on every port it really listens on, as `setup-vps.sh`
does.

Behind a load balancer or CDN that terminates TLS, use `--no-tls` and name the
proxy's address ranges, so nginx can recover each visitor's real address:

```bash
sudo ./deploy/install.sh --no-tls --domain ads.example.com --trusted-proxy 10.0.0.0/8
```

Repeat `--trusted-proxy` for each range (for Cloudflare, its published IPv4
and IPv6 ranges). `--no-tls` refuses to run without one, and refuses
`0.0.0.0/0` and `::/0`, which would let anyone forge an address. Links in
emails and on screen use `https://` either way: `https://DOMAIN`, or
`--site-url`, kept on re-runs.

For routine updates after that, `deploy/redeploy.sh` is quicker and knows how
to undo itself:

```bash
sudo ./deploy/redeploy.sh                 # latest of the branch this install follows
sudo ./deploy/redeploy.sh --ref v1.2.0    # a tag, branch or commit
```

The branch an install follows is the one `install.sh` checked out (recorded
in the checkout's git config as `ricelist.branch`); deploying a branch with
`--ref` makes it the one followed from then on, while a tag or commit leaves
the next plain run going back to the branch. On an install updated by an older
version of this script, the first plain run asks for `--ref <branch>` once.

It backs up the database first (through SQLite's backup API, so a WAL-mode
database is captured consistently), and stops before changing anything if the
database is not where `.env` says. It then checks out the new revision,
reinstalls, restarts, and checks the result: `/health` and the front page must
both answer 200, and a few seconds later the service must still be running
without systemd having restarted it. If the install or the check fails, it
puts back the previous commit together with the `node_modules` it was running
with (kept aside during the run, so no registry access is needed) and restarts
that, so a bad release self-corrects and you get a working site plus the
failing commit and a pointer to the log. A run interrupted part-way puts the
previous version back as it exits, and one killed outright is put back by the
next run. It never
rolls the database back on its own — that could discard writes made after the
backup — so a release that damages data is restored by hand from the backup it
names. All three scripts take `--help`.

To deploy by hand instead: set `NODE_ENV=production`, a strong
`SESSION_SECRET`, and `SITE_URL`. Run behind a TLS-terminating reverse proxy
and set `TRUST_PROXY=1` so rate limiting sees real client addresses; the app
warns in its log if requests arrive with `X-Forwarded-For` while it is off.
That setting assumes one proxy hop: behind a load balancer as well, have nginx
recover the client address (`set_real_ip_from`, `real_ip_header
X-Forwarded-For`) rather than raising `TRUST_PROXY`. A few things are easy to
get wrong:

- **Serve it over HTTPS.** In production the session cookie is marked `Secure`,
  so a browser will not store it over plain HTTP. The site still renders, but
  every form fails — nobody can post, message, report or sign in to moderation.
- **Raise the proxy's upload limit.** nginx allows 1 MB by default and will
  reject photo uploads with a 413 before the app sees them. The app accepts
  `MAX_IMAGES_PER_LISTING` files of `MAX_IMAGE_BYTES` each, 48 MB with the
  defaults.
- **Set `HOST=127.0.0.1` whenever `TRUST_PROXY=1`.** Together they mean the
  app trusts `X-Forwarded-For`, so anything that can reach the port without
  going through the proxy picks its own client address — and walks through
  every rate limit. Binding to loopback closes that path. The server warns at
  startup when `TRUST_PROXY` is on and the address it bound is not loopback.

Back up the data directory — it holds both the database and the uploaded
images.

## Notes on security

- All state-changing requests carry a per-session CSRF token. Multipart
  uploads are verified after parsing, inside the single upload entry point,
  so an upload route cannot skip the check. Only the known upload routes may
  defer that check: a request to any other route is verified immediately,
  whatever content type it claims.
- Content Security Policy is restrictive: no inline scripts or styles, no
  third-party origins.
- Uploads are re-encoded rather than trusted, and served with
  `X-Content-Type-Options: nosniff`. Image dimensions, the number of form
  fields and their sizes are all capped before anything expensive happens.
- Reports record a keyed hash of the reporter's address (an IPv6 address by
  its /56 prefix), so one person cannot hide an ad alone. The address itself is
  never stored, and the hash cannot be turned back into one without the
  site's `SESSION_SECRET`.
- Admin sessions are regenerated on login so a pre-login cookie cannot be
  promoted. Passwords are stored as scrypt hashes.
- Posting, messaging, editing, reporting and login are rate limited per
  address. IPv6 clients are grouped by their /56 prefix, since a single host
  usually holds a whole /64 or more. The admin password check runs off the
  main thread, so a burst of login attempts cannot stall the site. The edit limit runs before the upload parser, since the manage
  token that authorises an edit arrives in the body multer is still reading.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
