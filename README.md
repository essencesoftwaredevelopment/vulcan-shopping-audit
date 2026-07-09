# Vulcan Shopping Ad Profit Audit

Per-prospect audit pages for Vulcan's outbound. When a prospect replies positively,
the pipeline triggers a generation agent (Vercel Workflow) that researches the domain,
builds the audit payload, and stores it in the **ESSENCE Outbound Data** Supabase
project (`xfamwraegljpmvsdimrp`). The prospect then gets a link like:

```
https://<deployment>/?domain=grip6.com
```

The page (the hand-built static funnel in `public/index.html`) fetches that domain's
payload and hydrates itself: live "before" ad, generated standout "after" ad, findings,
real competitor row, and calculator defaults. Unknown / unready domains render a plain
"Audit not found".

## Architecture

```
outbound pipeline (positive reply)
        │  POST /api/audits  { domain }   Bearer AUDITS_TRIGGER_SECRET
        ▼
Vercel Workflow  workflows/generate-audit.ts   (durable steps, ~10-20 runs/day)
  1. gatherResearch   ← hero_selections, shopify_snapshots, ad_observations,
  │                     signal_emissions, job_serper_shopping_cache
  │                   ← live {domain}/products.json + Serper shopping (gap-fill)
  2. composeCopy      ← Claude (improved title, 4 findings, search term)
  3. createAfterImage ← Gemini image restyle → webp → Storage audit-assets/{domain}/after.webp
  4. finalizeAudit    → upsert public.shopping_audits (status='ready')
        │
        ▼
GET /api/audit?domain=x  ──►  public/index.html hydrates (silent view tracking)
```

### Supabase objects (already migrated: `create_shopping_audits`)

- `public.shopping_audits` — one row per domain: `status` (pending → generating →
  ready → failed), `payload` jsonb (everything the page needs), `payload_version`,
  `error_message`, `source_refs` (ids of the pipeline rows used), `generated_at`,
  `first_viewed_at`, `view_count`. **RLS enabled with zero policies** — only the
  service role can touch it; the anon key sees nothing.
- `public.bump_audit_view(text)` — silent view counter, called by the read API.
- Storage bucket `audit-assets` (public) — generated after-images.
- Seeded row: `grip6.com` (the original demo content), so `/?domain=grip6.com`
  works immediately.

## Endpoints

Trigger generation (idempotent — reuses a `ready` audit fresher than 24 h and
won't duplicate an in-flight run unless `"force": true`):

```bash
curl -X POST https://<deployment>/api/audits \
  -H "Authorization: Bearer $AUDITS_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"domain": "grip6.com"}'
# → 202 {"status":"started","runId":"...","domain":"grip6.com","url":"/?domain=grip6.com"}
```

Read (used by the page): `GET /api/audit?domain=grip6.com` → `{ domain, payload,
generated_at }` or 404.

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | `https://xfamwraegljpmvsdimrp.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side only. Reads pipeline tables, writes `shopping_audits` + Storage |
| `AUDITS_TRIGGER_SECRET` | yes | Bearer secret for `POST /api/audits` |
| `ANTHROPIC_API_KEY` | recommended | Findings/title copy via Claude (`ANTHROPIC_MODEL`, default `claude-sonnet-5`). Without it: deterministic template copy |
| `GEMINI_API_KEY` | recommended | Standout image (`GEMINI_IMAGE_MODEL`, default `gemini-2.5-flash-image`). Without it: optimized original photo |
| `SERPER_API_KEY` | optional | Live competitor cards when the pipeline has none for the domain |
| `AUDIT_MOCK` | dev only | `1` → `GET /api/audit` serves bundled payloads for `grip6.com` and `mockbrand.com` without Supabase |

## Local development

```bash
npm install
AUDIT_MOCK=1 npm run dev
```

- `http://localhost:3000/` — grip6 demo (no fetch, page as designed)
- `http://localhost:3000/?domain=mockbrand.com` — full hydration path with
  deliberately different values (kettle product) so changes are visible
- `http://localhost:3000/?domain=anythingelse.com` — not-found state

## Deploy

```bash
vercel deploy   # or connect the repo in the Vercel dashboard
```

Set the env vars above in the Vercel project (Workflows need no extra config;
`withWorkflow` in `next.config.ts` registers the runtime routes). Workflow runs are
observable under **Vercel dashboard → Observability → Workflows**.

## Content/truth policy (locked decisions)

- Generated **minutes before the link is sent**; no re-verification afterwards.
- Before-ad + findings are grounded in observed data (live ad card, live store price,
  emitted signals). The **after-ad is aspirational by design**: price is real;
  "was" price is the real compare-at, else price × 1.3; reviews are real when known,
  else the fixed cosmetic 4.8 (1,478).
- AOV, product count, and sale price are derived per domain; ROAS/CTR/38% stat and
  spend/CPC/CVR calculator defaults stay template values with "typical" hedging.
- Vulcan-only: domain is the primary key; founders/testimonials/booking are baked
  into the page.

## Repo layout

- `public/index.html` — the deployable page: the design from
  `../vulcan-shopping-audit-source/index.html` plus the hydration layer (`AUDIT`
  object, `applyAudit()`, fetch boot, loading/not-found states). The `-source`
  folder stays the pristine design reference.
- `workflows/generate-audit.ts` — the generation agent (workflow + 6 steps).
- `app/api/audits/route.ts` — authenticated trigger; `app/api/audit/route.ts` — page read.
- `lib/` — supabase service client, domain normalization, payload types, demo payload.
