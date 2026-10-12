# Site Inspector

Give it a URL and it crawls every same-domain link up to the depth you choose, takes a full-page screenshot of each page at mobile, tablet and desktop sizes, and lays the sitemap out on a canvas you can pan, zoom and rearrange.

## Stack

TanStack Start (Router, Query, server functions) · TypeScript · Zod · Drizzle ORM + SQLite (better-sqlite3) · Playwright (Chromium) · sharp · shadcn/ui + Tailwind CSS v4 (square corners only) · React Flow (@xyflow/react) + d3-hierarchy.

## Getting started

```bash
pnpm install
pnpm playwright:install   # downloads Chromium and its system libraries
pnpm dev                  # admin UI on http://localhost:3000
pnpm runner               # in another terminal: captures the pages
```

The admin only queues crawls; a separate **runner** process does the crawling. Run as many runners as you like against the same data directory and they share the work page by page.

The SQLite database (`data/site-inspector.db`) and screenshots (`data/screenshots/`) are created on first start; migrations in `drizzle/` are applied automatically. Set `DATA_DIR` or `DATABASE_URL` to put them somewhere else.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` / `pnpm start` | Production build, then run `.output/server/index.mjs` |
| `pnpm runner` | Start a crawl runner. `RUNNER_CONCURRENCY` (default 3) sets how many pages it captures at once, `RUNNER_ID` names it (default `host-pid-random`). Ctrl+C finishes in-flight pages first; press it again to quit immediately |
| `pnpm test` | Vitest: URL/robots units, the job queue (including several processes racing for pages), and a two-runner crawl of a local fixture site |
| `pnpm typecheck` | Regenerates the route tree and runs `tsc` |
| `pnpm lint:corners` | Fails if any `rounded-*` class other than `rounded-none` shows up in `src/` |
| `pnpm db:generate` | Generate a migration after editing `src/server/db/schema.ts` |

## How it works

- **Crawler** (`src/server/crawler/`): breadth-first, one depth level at a time. Links are normalized (fragments, tracking params, trailing slashes and default ports removed) and kept only if they're on the same host (`www.` and the bare domain count as the same site). Asset links (PDFs, images, …) and `robots.txt`-disallowed paths are skipped. Each page is loaded once per selected viewport, scrolled to trigger lazy loading, and captured full-page (capped at 16,000px tall) along with a WebP thumbnail.
- **Queue** (`src/server/crawler/jobs.ts`): lives in SQLite, so the admin and runners share nothing but the database file. Every page row is a job: a runner claims one, captures it, then writes back its screenshots, the pages it links to (added as new jobs) and its link edges. A page is only handed out once every shallower page of its crawl is finished, so parents are always shallowest links. At most 6 pages per crawl are in flight across all runners; older crawls go first and idle runners spill over to the next one.
- **Runners** (`src/runner/`): any number of processes on the same host (sharing `DATA_DIR`). Claims carry a 60s lease that runners renew every 15s. If a runner dies, its pages go back to the queue when the lease runs out, and are marked failed after 3 attempts. Cancelling or deleting a crawl takes effect between viewports, and late results are discarded. The admin shows how many runners are online and warns when a crawl is waiting without one.
- **Canvas** (`src/components/sitemap/`): a Figma-style board. Every page is a numbered frame showing its full-page screenshot (pages taller than the frame fade out at the bottom), grouped into sections by the page that first linked to it. Frames wrap into a grid inside each section and sections wrap into rows, so the board takes roughly the shape of the screen instead of one long row. Frame names and section titles stay the same size on screen at any zoom. The resizable **Pages** panel shows every page as a tree under the page that first linked to it; each row's ←N badge lists every page that links there. Resting the pointer on a row zooms the board to that frame and opens the resizable preview panel on the right with its full-size screenshots. Search filters the tree to the matches (and the pages leading to them), dims everything else on the board and zooms to the matches; **Desktop / Tablet / Mobile** switches which captures the board shows. Click a frame to select it, double-click (or its ⤢ button) to open it in the preview panel. **Show links** draws the selected page's outgoing (solid) and incoming (dashed) links, or every link when nothing is selected. Dragged positions are saved to SQLite; **Re-layout** clears them.
- **Board previews**: each capture gets a 480px and a 144px WebP of the part a frame shows, written at capture time (or on first request for older crawls). The zoomed-out overview only loads the small ones.
