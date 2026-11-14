# Platform status monitor

Scheduled GitHub Actions checks for the 11 free platforms registered on
2026-11-14. Results are written to `status.json` (UTC `updated_at`, one entry
per platform). The management center reads this file so it always shows the
latest status. `status.json` holds **no credentials** — only statuses and
short details.

## Schedules

| Workflow | When | What it checks |
| --- | --- | --- |
| `.github/workflows/instabox.yml` | every 30 min (`*/30 * * * *`) | InstaBox machine only, via the InstaBox API. No browser, no Playwright, so the run is fast and cheap on Actions minutes. Merges into the existing `status.json`, preserving the other 10 platforms. |
| `.github/workflows/platforms.yml` | every 6 hours (`0 */6 * * *`) | All 11 platforms. API/HTTP/TCP checks where possible; Playwright logins only for Proton, TinkerHost and AeonFree. Writes the complete `status.json`. |

Both workflows also support manual runs (`workflow_dispatch`) and only
commit + push `status.json` when it changed.

## How each platform is checked (all read-only)

- **InstaBox** — `GET https://api.instabox.sh/v1/machines/m_agq5ufdgypuf6tjhgd22r3ib2u`
  with the `X-API-Key` header. `status` is `ready` whenever the machine
  exists (any state); `blocked` only if the API call fails after retries or
  the machine is gone. Never pauses, resumes, stops, creates or deletes.
- **GitHub** — public `GET https://api.github.com/users/liuyifei-muse`. 200 and
  matching login = ready.
- **LXI** — `GET https://liuyifei-muse.lxi.be`. 200 = ready; the detail says
  whether the hosting is live or still "In preparation".
- **AWS Sydney node** — TCP connect to `node.linzheng888.kdns.fr` ports
  35079 and 26458. No SSH (no key in Actions). Open = ready.
- **Proton / TinkerHost / AeonFree** — Playwright login (6-hour workflow
  only). Inbox/dashboard loading = ready. A failed login is recorded as
  `blocked` / "login check failed" and the run continues with the others.
- **Cloady / Kaggle / Simular / Google Colab** — not checked live; their
  state only changes when the user acts. Recorded as `blocked` (Cloady) or
  `pending` (the rest) with the reason in `detail`.

## Required secrets (GitHub Secrets — values are never in this repo)

| Secret | Used for |
| --- | --- |
| `INSTABOX_API_KEY` | InstaBox API key (`ibk_...`, machines:read scope) |
| `PROTON_PASSWORD` | Proton Mail login |
| `TINKERHOST_PASSWORD` | TinkerHost login |
| `AEONFREE_PASSWORD` | AeonFree login |

The workflows never echo secrets into logs, and no password or key is ever
written into `status.json`.

## Run it locally

```sh
npm install
INSTABOX_API_KEY=... node scripts/check.mjs instabox   # InstaBox only
INSTABOX_API_KEY=... PROTON_PASSWORD=... TINKERHOST_PASSWORD=... AEONFREE_PASSWORD=... node scripts/check.mjs all
```

`instabox` mode needs no Playwright. `all` mode needs Playwright + Chromium
(`npx playwright install --with-deps chromium`); if Playwright is missing,
the three login checks are recorded as "login check failed" instead of
crashing the run.

## Caveats

- The Playwright login selectors and success detection are best-effort and
  untested against the live login pages (no test credentials here). If a
  site changes its login form, that platform will show "login check failed"
  until the selectors in `scripts/check.mjs` are updated — the other
  platforms keep updating normally.
- The LXI "live vs In preparation" call is a content heuristic (it looks for
  preparation wording in the page). If LXI serves a JS-only shell, HTTP 200
  alone is treated as live.
