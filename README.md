# Site Inspector

Give it a URL and it crawls every same-domain link up to the depth you choose, takes a full-page screenshot of each page at mobile, tablet and desktop sizes, and lays the sitemap out on a canvas you can pan, zoom and rearrange.

## Stack

TanStack Start (Router, Query, server functions) · TypeScript · Zod · Drizzle ORM + Postgres (node-postgres) · screenshots on local disk or any S3-compatible bucket (AWS SDK v3) · Playwright (Chromium) · sharp · shadcn/ui + Tailwind CSS v4 (square corners only) · React Flow (@xyflow/react) + d3-hierarchy.

## Getting started

```bash
pnpm install
pnpm playwright:install   # downloads Chromium and its system libraries
docker compose up -d      # Postgres on :5432 (and MinIO on :9000, if you want to try bucket storage)
pnpm dev                  # admin UI on http://localhost:3000
pnpm runner               # in another terminal: captures the pages
```

The admin only queues crawls; a separate **runner** process does the crawling. Run as many runners as you like against the same database and screenshot store and they share the work page by page.

Any Postgres 13+ works; without `DATABASE_URL` the app connects to `postgres://postgres:postgres@localhost:5432/site_inspector`, which is what `docker-compose.yml` starts. Migrations in `drizzle/` are applied automatically on start (one process at a time). Screenshots are written to `data/screenshots/` unless you configure a bucket (below).

## Configuration

Set these in the environment of the admin server **and** every runner, or copy `.env.example` to `.env`, which `pnpm dev`, `pnpm start`, `pnpm runner` and the `db:` scripts read:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/site_inspector` | Postgres connection string. Add `?sslmode=require` for hosted databases |
| `DATABASE_POOL_SIZE` | `10` | Connections each process may open |
| `SCREENSHOT_STORAGE` | `local` | `local` (files on disk) or `s3` (an S3-compatible bucket) |
| `DATA_DIR` | `data` | Base directory for local files |
| `SCREENSHOT_DIR` | `$DATA_DIR/screenshots` | Where `local` storage writes screenshots |
| `S3_BUCKET` | | Bucket for `s3` storage (required) |
| `S3_PREFIX` | | Folder inside the bucket, e.g. `site-inspector` |
| `S3_REGION` | `$AWS_REGION` or `us-east-1` | Region; `auto` for Cloudflare R2 |
| `S3_ENDPOINT` | AWS | Endpoint for other services, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://storage.googleapis.com`, `http://localhost:9000` |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and other services without per-bucket hostnames |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | | Keys for the bucket. Unset, the AWS SDK's usual credential chain applies (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, instance and task roles…) |

With `s3` storage the bucket stays private: the admin server reads each image and serves it under `/screenshots/…` as before, with a year-long immutable cache header. Google Cloud Storage works through its S3-compatible XML API with [HMAC keys](https://cloud.google.com/storage/docs/authentication/hmackeys). Since runners then share nothing but Postgres and the bucket, they can run on any machine; with `local` storage they must share the screenshot directory (the same host or a shared volume).

### Upgrading from SQLite

Earlier versions kept everything in `data/site-inspector.db`. To bring those crawls over, point `DATABASE_URL` at Postgres and run:

```bash
pnpm db:import-sqlite                        # reads data/site-inspector.db
pnpm db:import-sqlite path/to/other.db       # or another file
```

It copies crawls, pages, links, screenshots and settings, skipping crawls already in Postgres, so it can be run again. Local screenshots stay where they are; with `SCREENSHOT_STORAGE=s3` it also uploads `data/screenshots/` (or `--screenshots <dir>`) to the bucket. It uses Node's built-in `node:sqlite`, so it needs Node 22.13 or later.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` / `pnpm start` | Production build, then run `.output/server/index.mjs` |
| `pnpm runner` | Start a crawl runner. It captures as many pages at once as **Settings → Slots per runner** says (default 3); `RUNNER_CONCURRENCY` pins a fixed number for that runner instead. `RUNNER_ID` names it (default `host-pid-random`). Ctrl+C finishes in-flight pages first; press it again to quit immediately |
| `pnpm test` | Vitest: URL/robots units, the job queue (including several processes racing for pages), screenshot storage, and a two-runner crawl of a local fixture site. Needs a Postgres server: each test file creates (and drops) its own database on `TEST_DATABASE_URL` (default: `DATABASE_URL`, else the local one from `docker-compose.yml`). Set `TEST_S3_BUCKET` (plus `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`) to also run the storage tests against a bucket, e.g. the compose MinIO |
| `pnpm typecheck` | Regenerates the route tree and runs `tsc` |
| `pnpm lint:corners` | Fails if any `rounded-*` class other than `rounded-none` shows up in `src/` |
| `pnpm db:generate` | Generate a migration after editing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations without starting the app (it also does this on start) |
| `pnpm db:import-sqlite` | Copy crawls from a pre-Postgres SQLite database (see above) |

## How it works

- **Crawler** (`src/server/crawler/`): breadth-first, one depth level at a time. Links are normalized (fragments, tracking params, trailing slashes and default ports removed) and kept only if they're on the same host (`www.` and the bare domain count as the same site). Asset links (PDFs, images, …) and `robots.txt`-disallowed paths are skipped. Each page is loaded once per selected viewport, scrolled to trigger lazy loading, and captured full-page (capped at 16,000px tall) along with a WebP thumbnail.
- **Queue** (`src/server/crawler/jobs.ts`): lives in Postgres, so the admin and runners share nothing but the database (and the screenshot store). Every queue write takes the same transaction-level advisory lock, so writes from all processes run one at a time and a page is never claimed twice. Every page row is a job: a runner claims one, captures it, then writes back its screenshots, the pages it links to (added as new jobs) and its link edges. A page is only handed out once every shallower page of its crawl is finished, so parents are always shallowest links. At most 6 pages per crawl are in flight across all runners (configurable); older crawls go first and idle runners spill over to the next one. Each claim also holds the crawl's next page back by the **fetch delay** (default 1s, or the site's robots.txt `Crawl-delay` when that's longer, capped at 60s), so a site sees page loads spaced out however many runners are working on it; the viewports of one page still load back to back.
- **Runners** (`src/runner/`): any number of processes, on any host that reaches the database and the screenshot store. Claims carry a 60s lease that runners renew every 15s. If a runner dies, its pages go back to the queue when the lease runs out, and are marked failed after 3 attempts. Cancelling or deleting a crawl takes effect between viewports, and late results are discarded. The admin shows how many runners are online and warns when a crawl is waiting without one.
- **Settings** (`/settings`, the gear on the home page): fetch delay, whether to honor `Crawl-delay`, max pages in flight per crawl, slots per runner and the page load timeout. They're stored in Postgres and runners pick them up live: the queue settings on every claim, the slot count on their next heartbeat (within 15s).
- **Canvas** (`src/components/sitemap/`): a Figma-style board. Every page is a numbered frame showing its full-page screenshot (pages taller than the frame fade out at the bottom), grouped into sections by the page that first linked to it. Frames wrap into a grid inside each section and sections wrap into rows, so the board takes roughly the shape of the screen instead of one long row. Frame names and section titles stay the same size on screen at any zoom. The resizable **Pages** panel shows every page as a tree under the page that first linked to it; each row's ←N badge lists every page that links there. Resting the pointer on a row zooms the board to that frame and opens the resizable preview panel on the right with its full-size screenshots. Search filters the tree to the matches (and the pages leading to them), dims everything else on the board and zooms to the matches; **Desktop / Tablet / Mobile** switches which captures the board shows. Click a frame to select it, double-click (or its ⤢ button) to open it in the preview panel. **Show links** draws the selected page's outgoing (solid) and incoming (dashed) links, or every link when nothing is selected. Dragged positions are saved to the database; **Re-layout** clears them.
- **Screenshot storage** (`src/server/storage/`): captures, thumbnails and previews are saved through a small store interface with two backends, local files and S3-compatible buckets. Keys are `<crawl id>/<page id>-<capture id>-<viewport>.jpg` (and `.thumb.webp`, `.preview.webp`, `.preview-sm.webp`); the database stores the keys, so a crawl's files are the same wherever they live.
- **Board previews**: each capture gets a 480px and a 144px WebP of the part a frame shows, written at capture time (or on first request for older crawls). The zoomed-out overview only loads the small ones.
