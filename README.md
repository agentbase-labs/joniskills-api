# joniskills-api

Backend for [joniskills.xyz](https://joniskills.xyz) — a community marketplace for Joni skills.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET`  | `/health` | Health check (DB connectivity) |
| `GET`  | `/skills` | List all approved skills. Optional `?category=<cat>` |
| `GET`  | `/skills/:slug` | Single skill metadata |
| `POST` | `/skills` | Upload a new skill (multipart) |
| `GET`  | `/skills/:slug/download` | Stream the zip archive |
| `POST` | `/skills/:slug/increment-download` | +1 to download counter |

## Upload format (`POST /skills`)

Multipart form:

- `file` — zip archive (≤ 5 MB). Must contain a `SKILL.md` at the root of the skill folder.
- `metadata` — JSON string with:
  ```json
  {
    "name": "My Skill",
    "slug": "my-skill",
    "emoji": "🔧",
    "category": "utility",
    "description": "Short description (≤ 500 chars)",
    "author": "Someone",
    "requires_env": ["SOME_API_KEY"]
  }
  ```
  (You can also pass individual fields instead of `metadata`.)

### Categories

`video`, `image`, `audio`, `productivity`, `web`, `crypto`, `utility`, `other`

### Slug rules

`^[a-z0-9][a-z0-9-]{1,40}$` — lowercase letters, digits, hyphens.

### Rate limit

`POST /skills` is rate-limited to **10 uploads per IP per hour** (configurable via `UPLOAD_RATE_LIMIT_PER_IP_PER_HOUR`).

## Tech

Fastify, PostgreSQL (Render Starter), `adm-zip` for archive validation. Zips are stored as `bytea` in the `skill_files` table (no S3).

## Env vars

- `DATABASE_URL` — injected by Render
- `PORT` — injected by Render
- `UPLOAD_RATE_LIMIT_PER_IP_PER_HOUR` (optional, default `10`)
