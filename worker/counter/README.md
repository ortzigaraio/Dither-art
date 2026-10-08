# horain-counter

An anonymous visit counter for the HORAIN site, built as a Cloudflare Worker with a D1 database.
It stores only two numbers (the all-time total and the per-day total) and keeps no IPs, user agents or cookies.

| Route | What it does |
|---|---|
| `POST /hit` | Adds one visit and returns `{ "total": n, "today": m }`. It only accepts requests from `ALLOWED_ORIGINS` and is rate-limited per IP when the `LIMITER` binding exists. |
| `GET /count` | Returns the same numbers without adding a visit. |

The client (`src/ui/visitCounter.js`) counts at most one visit per browser per day. It never counts a browser that
sends Global Privacy Control, and it hides the counter if the Worker can't be reached.

For deployment, see `DEPLOY.md` §5 at the repo root.

To run it locally:

```bash
npx wrangler d1 execute horain-counter --local --file=schema.sql
npx wrangler dev
```
