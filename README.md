# VideoStore

An adult video site with free and premium (subscription) videos, partner ad slots, categories and tags, an upload studio, and an admin panel. Every upload is virus-scanned and stripped of hidden metadata before anyone can see it.

## Running it with Docker

```bash
cp .env.example .env        # then edit: set SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose up -d --build
```

Open http://your-server:3000 and log in with the admin email and password from `.env`. Change the password under **My account** afterwards.

On the first start the ClamAV container downloads about 300 MB of virus definitions, which takes a few minutes. Uploads made during that time wait safely in quarantine and are processed once the scanner is up. The admin dashboard shows whether the scanner is online.

For a public launch, put the app behind HTTPS (Caddy, nginx or Cloudflare Tunnel) and set `TRUST_PROXY=1`.

## What happens to an upload

```
browser ──upload──▶ quarantine folder (never served)
                        │
                        ▼
              1. virus scan ───────▶ ClamAV container (streamed over an internal network;
                        │                                it has no access to the files)
                        │  infected? → file deleted, marked "Blocked: virus found"
                        ▼
              2. ffprobe: is it really a video?     not a video? → deleted, "Failed"
                        ▼
              3. ffmpeg rewrite, removing ALL metadata:
                 title/comment tags, GPS location, camera/phone model,
                 creation dates, encoder tags, chapters, cover art,
                 subtitle and data tracks
                 (H.264 is copied as-is; other formats are converted to H.264/AAC MP4)
                        ▼
              4. thumbnail: an uploaded thumbnail is scanned and re-encoded (EXIF removed),
                 or one is taken from the video automatically
                        ▼
              5. published → "Awaiting review" (admin approves), or live immediately
                 if auto-approve is on or an admin uploaded it
```

If the scanner is unreachable, nothing is published. The upload stays in quarantine and is retried with backoff. Partner ad images go through the same scan and metadata strip.

## Features

- **Browsing:** home page with Newest, Most viewed, Top rated and Longest sorts, and All/Free/Premium filters. Also category pages, a tag cloud, tag pages, search (titles, descriptions and tags), creator pages, related videos, likes/dislikes and view counts.
- **Free vs premium:** each video is Free or Premium, set by the uploader or an admin. Premium video files are only streamed to subscribers; the files are never public, so the paywall can't be bypassed with a direct link.
- **Subscriptions:** plans are editable in Admin → Settings. Premium members see no ads (a setting you can turn off).
- **Partner ads:** five slots (header, sidebar, in the video grid, below the player, footer). You can use image banners with a click-through link, or paste an ad network's embed code; embed code runs in a sandboxed frame so it can't read your users' logins. Each ad has a weight for rotation, start and end dates, and impression and click counts. There's a per-partner report showing impressions, clicks and click-through rate.
- **Upload studio:** drag-and-drop with a progress bar, tag chips with popular-tag suggestions, a Free/Premium picker, an optional custom thumbnail, and live processing status.
- **Admin:** a moderation queue (approve, reject, feature, switch free/premium), user reports with one-click takedown, categories, ads, users (change roles, grant or revoke premium, ban) and site settings.
- **Adult-site basics:** an 18+ age gate, the RTA label (so parental filters can block the site), an 18+ consent and records statement required on every upload, a report button on every video, and template Terms, Privacy, 2257 and DMCA pages. **Have a lawyer replace these templates.**

## Payments

`PAYMENT_MODE=demo` is the only mode right now: choosing a plan activates premium instantly without charging, so you can test everything.

Mainstream processors (Stripe, PayPal, Square) don't allow adult content. Apply to an adult-friendly processor such as **CCBill**, **Segpay**, **Verotel** or **Epoch**. All payment code lives in `src/routes/billing.js`, with notes on where the processor's checkout and webhook go.

## Roles

| Role | Can |
|---|---|
| member | watch free videos, subscribe, like, report |
| creator | also upload and manage their own videos (My studio) |
| admin | everything, and always has premium access |

New sign-ups are members. Promote creators in Admin → Users, or turn on "Let anyone sign up as a creator" in Settings.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `SESSION_SECRET` | — | **required** in production |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | admin@example.com / changeme123 | first admin account, created once |
| `MAX_UPLOAD_MB` | 4000 | keep at or below the limits in `docker/clamd.conf` |
| `TRUST_PROXY` | 0 | set to 1 behind an HTTPS reverse proxy |
| `PAYMENT_MODE` | demo | |

Data lives in two Docker volumes: `app-data` (SQLite database) and `app-uploads` (videos, thumbnails, ad images). Back them up.

## Development

```bash
npm install
npm run dev          # needs ffmpeg + ffprobe on PATH, and clamd on 127.0.0.1:3310
npm test             # end-to-end test with a fake scanner (needs ffmpeg/ffprobe)
```

Requires Node 22.13+ (it uses the built-in `node:sqlite`).
