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
the search box can't produce a query error.

**Posting.** Anyone can post without registering. Each ad gets a secret
management link — the only way to edit it, delete it, renew it, or read
messages about it. The link is emailed when SMTP is configured and always
shown on screen after posting, so it is never lost to a mail failure.

**Photos.** Uploads are decoded and re-encoded with sharp before touching
disk. That is what makes them safe: anything that isn't a real image fails to
decode, and EXIF metadata (including GPS coordinates) never survives the
round trip. A thumbnail is generated for listing cards.

**Contacting sellers.** Buyers use a form on the listing. The message is
stored in the seller's inbox and relayed by email with the buyer set as
reply-to. The seller's address is never rendered publicly, and a relay failure
never loses the message. A hidden honeypot field silently drops bot
submissions.

**Moderation.** Anyone can report an ad. Enough unresolved reports auto-hide
it pending review. Moderators get a queue filtered by state, and can remove,
restore, dismiss reports, or delete permanently. Removal reasons are recorded
and shown in the panel.

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

72 tests covering validation and formatting, the posting and editing flows,
search, manage-token authentication, contact messaging and relay failure,
reporting and auto-hide, the moderation panel, image handling, expiry, and
rate limiting.

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

# 2. Open a second SSH session and check you can still log in, before
#    closing the first one.

# 3. Point DNS at the box, then install the site.
sudo ./deploy/install.sh --domain ads.example.com --email you@example.com
```

`setup-vps.sh` will not disable password logins unless an authorised key is
already in place, and never enables the firewall before allowing SSH through
it — it reads the port sshd is actually listening on rather than trusting the
config file. Both risky steps are opt-in.

`install.sh` puts the code in `/opt/ricelist` and the database and uploads in
`/var/lib/ricelist`, outside the checkout, so re-running it upgrades the site
without touching your data, session secret or admin password.

For routine updates after that, `deploy/redeploy.sh` is quicker and knows how
to undo itself:

```bash
sudo ./deploy/redeploy.sh                 # latest of the current branch
sudo ./deploy/redeploy.sh --ref v1.2.0    # a tag, branch or commit
```

It backs up the database first (through SQLite's backup API, so a WAL-mode
database is captured consistently), checks out the new revision, reinstalls,
restarts, and polls `/health`. If the site does not come back it restores the
previous commit and restarts again, so a bad release self-corrects and you get
a working site plus the failing commit and a pointer to the log. It never
rolls the database back on its own — that could discard writes made after the
backup — so a release that damages data is restored by hand from the backup it
names. All three scripts take `--help`.

To deploy by hand instead: set `NODE_ENV=production`, a strong
`SESSION_SECRET`, and `SITE_URL`. Run behind a TLS-terminating reverse proxy
and set `TRUST_PROXY=1` so rate limiting sees real client addresses. Two things
are easy to get wrong:

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
  startup if it finds the two settings in the dangerous combination.

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
  `X-Content-Type-Options: nosniff`.
- Admin sessions are regenerated on login so a pre-login cookie cannot be
  promoted. Passwords are stored as scrypt hashes.
- Posting, messaging, editing, reporting and login are rate limited per
  address. The edit limit runs before the upload parser, since the manage
  token that authorises an edit arrives in the body multer is still reading.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
