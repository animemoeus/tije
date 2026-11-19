# tije

## What this is

A TanStack Start (React 19, SSR via Nitro) app that draws Transjakarta bus routes on a MapLibre map. All UI text is in Indonesian (`<html lang="id">`). The data comes from the sibling project `../transjakarta-api`, a Rust (axum) API that serves `GET /route-types`, `GET /routes?type=BRT,Mikrotrans`, the stops of those types `GET /stops?type=...`, the live bus feed `WS /ws?routes=...` and a per-bus event stream `GET /buses/{bus_body_no}`. Set its base URL with `VITE_API_URL` (default `https://api.tije.info`; `.env.local` points it at `http://localhost:8000`). When the API isn't running, the map shows an error card with a retry button.

## Working rules

- Write plans in Indonesian. Code, identifiers, comments and docstrings stay in English.
- Before implementing anything that touches the API (fetches, the WebSocket feed, the bus event stream, bus or route fields, update rates), read the backend source in `../transjakarta-api`: `README.md` for endpoints and message shapes, `src/routes.rs` for `/route-types`, `/routes` and `/stops`, `src/live.rs` for `/ws`, `/buses/{bus_body_no}` and the bus fields, and `src/config.rs` for defaults. Don't infer field names, units, defaults or limits from the frontend alone. For example, the API often sends `speed` and `timestamp` as 0, it no longer sends `age_seconds`, and a `/ws` without `routes` streams every bus (about 3,900).
- Give every function a docstring (JSDoc `/** ... */` in TS/TSX).
- For any UI work, use the `ui-ux-pro-max:ui-ux-pro-max` skill.

### Ponytail

Keep ponytail mode (`ponytail` / `ponytail:ponytail`, level `full`) active on every coding task (writing, fixing, refactoring, reviewing, choosing dependencies). Turn it off only when the user says "stop ponytail" or "normal mode". Even in agents without the plugin, follow these rules:

- Read the task and every file the change touches before editing: callers, tests, fixtures, config, exports, and anything the change could break.
- Stop at the first option that solves the full task:
  1. Skip features, options, and flexibility nobody asked for, and name what you skipped in one line.
  2. Reuse an existing helper, component, service, or pattern from this codebase the way surrounding code uses it.
  3. Use the standard library or a browser/platform feature unless this repo already has its own component.
  4. Use an already-installed package from `package.json`. Never add a dependency for a few lines.
  5. Write one readable line if a reader gets it at a glance.
  6. Otherwise, write the smallest complete change that works.
- Finish every part the task needs (callers, types, config, docs that break). Skip unrequested abstractions, wrappers, options, and "for later" code. Prefer deletion over addition.
- For bug fixes, grep every caller of the function before editing and fix the root cause once in shared code.
- Keep validation at trust boundaries, error handling that prevents data loss, security, accessibility, and everything the user asked for.
- Keep inline `//` comments to one line explaining why when the code cannot show it (in addition to the JSDoc docstring required on every function).
- Mark deliberate shortcuts with a known limit using `// shortcut: <limit>, <when to upgrade>` (existing code also has older `// ponytail:` comments).
- End replies with one or two lines stating what was skipped or not checked and any risk the user should know.

### Humanizer

Run every piece of prose through the `humanizer` (`humanizer:humanizer`) skill before saving it. This covers documentation (`README.md`, `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `docs/`), docstrings, code comments, commit messages, PR descriptions, changelogs, and user-facing copy. In agents without the skill installed, apply the same rules directly:

- Lead with facts and the main point. Drop filler, hype words ("seamless", "pivotal", "delve", "landscape", "game-changer"), and staged run-ups ("Let's dive in", "At its core", "Here's the thing").
- Avoid "not X, but Y" contrasts, dramatic one-line closers, forced three-item lists, decorative bold labels, and emojis.
- Use periods, commas, colons, or parentheses instead of chaining em-dashes.
- Keep exact code identifiers, commands, flags, file paths, and schema fields unchanged. Keep technical docs and comments plain and direct.

### Context7

Check `package.json` for exact package names and versions first, then use the Context7 MCP (`resolve-library-id`, then `query-docs`) or the `context7-mcp` skill to fetch current docs before planning, implementing, optimizing, refactoring, migrating, or debugging work that touches a library, framework, SDK, API, or CLI tool (such as TanStack Start, TanStack Router, React 19, MapLibre GL, Tailwind CSS v4, Nitro, Vite, or Sentry). Prefer Context7 over web search or training memory. Skip it for pure algorithmic or general programming tasks that do not involve a library or platform API.

1. Read `package.json` to confirm the library name and version used here.
2. Call `resolve-library-id` with the library name and what to look up, unless you already have an exact `/org/project` ID.
3. Pick the best match by exact name, source reputation, benchmark score, and a version-specific ID matching `package.json` when available.
4. Call `query-docs` with one concept per call. Split separate topics (such as routing, SSR, and caching) into separate calls unless asking how they interact.
5. Plan and implement against the fetched docs.

## Commands

```bash
npm run dev              # dev server on :3000; loads .env.local and preloads instrument.server.mjs (Sentry)
npm run build            # vite build, then copies instrument.server.mjs into .output/server
npm run start            # run the production build from .output/
npm run lint             # eslint (@tanstack/eslint-config, with import-order/sort rules turned off)
npm run format           # prettier --write + eslint --fix
npm run check            # prettier --check
npm run generate-routes  # regenerate src/routeTree.gen.ts by hand (the Vite plugin normally does this)
npx tsc --noEmit         # type check; there is no npm script for it
```

There is no test runner set up in this project.

The build output goes to `.output/`. The README's "Deploy with Nitro" section mentions `dist/`, which is wrong for this setup.

## Architecture

- File-based routing lives in `src/routes/`. `src/routeTree.gen.ts` is generated, so don't edit it. `src/router.tsx` exports `getRouter()`, which TanStack Start calls.
- `src/routes/__root.tsx` renders the HTML shell, the `Header`, and the devtools. It also inlines `THEME_INIT_SCRIPT`, which reads `localStorage.theme` (`light`/`dark`/`auto`) and sets the `light`/`dark` class plus `data-theme` on `<html>` before hydration. `ThemeToggle.tsx` writes the same key, so if you change the theme logic, update both places.
- `src/components/RouteMap.tsx` holds all of the app's logic:
  - It imports `maplibre-gl` dynamically inside `useEffect` so SSR never touches it. The worker URL comes from Vite (`?worker&url` plus `setWorkerUrl`) because maplibre's own worker lookup fails after Vite pre-bundles it.
  - The API returns paths as `[lat, lon]`. `toGeoJSON` flips them to `[lon, lat]` and makes one LineString per route direction, colored from `route_color`.
  - It adds one GeoJSON source and one line layer (`routes`) once the map loads. Changing the type filter calls `setData` on that source and doesn't rebuild the map. Fetches are aborted with `AbortController`, and the `attempt` counter re-runs them on retry.
  - The type filter is a row of checkbox chips. The chosen types live in the URL as `?type=BRT,Mikrotrans` (`src/routes/index.tsx`): no param means BRT plus Angkutan Umum Integrasi (`DEFAULT_TYPES` in `src/api.ts`), `all` means every type, and `RouteMap` gets them as `types: Array<string>`, where an empty array means all.
  - Under it, the route filter lists the routes of those types that have live buses right now, each with its bus count. Picked routes live in `?rute=1,9`; only their lines, buses and stops are drawn, and the map frames them. A pick whose type is no longer chosen stays in the URL and comes back with its type. `?halte=off` hides the stops.
  - `src/routes/index.tsx` also saves the whole filter to `localStorage` (`tije.filter`). Opening the app at a bare URL restores it; a link with its own filter wins and replaces the saved one.
  - Live buses come from `/ws?routes=<codes of the routes drawn>`: one snapshot, then deltas. Updates arrive about every 1.5 to 2 seconds, and the backend doesn't interpolate positions. A ring pings around a bus when its `raw_latitude`/`raw_longitude` change.
  - The locate button (`locate`) works like Google Maps, built on `navigator.geolocation.watchPosition` rather than maplibre's `GeolocateControl`. The first tap asks for permission and follows the user with a `.user-pin` marker and a `user-accuracy` circle layer sized in metres. Dragging the map or picking a bus switches to `free`, and the next tap recentres. A refused or failed lookup shows a `notice`. So does a fix outside the map's `maxBounds`. Geolocation needs HTTPS or localhost.
  - Stops come from `/stops?type=<the chosen types>`, shown by default and hidden with the floating `Halte` chip under the top bar. They're drawn in the `stops` circle layer and `stop-label` symbol layer, under the buses. BRT haltes (`type: "halte"`) are bigger blue dots (`HALTE_COLOR`) shown at every zoom, with bold names from `HALTE_LABEL_ZOOM`; the ~7,000 plain bus stops are small hollow dots from `BUS_STOP_ZOOM`, named from `STOP_LABEL_ZOOM`. Clicks go to the invisible, wider `stops-hit` layer so a fingertip can hit a stop. The popup is pinned to the stop and lists its routes in natural order, and the `stop-focus` ring marks the stop while the popup is open.
  - Popups are built with `textContent` instead of HTML strings so API values never become markup.
- `src/components/BusInfo.tsx` follows the selected bus with an `EventSource` on `/buses/{bus_body_no}`. A `bus` event replaces the card's data; `gone` means the bus left the feed, and the card then closes the stream so it doesn't reconnect. The "updated" age counts from when the last `bus` event arrived.
- Basemap tiles come from OpenFreeMap's `positron` style.
- On phones (below `md`) the panel is a bottom sheet opened from a tab bar (`Peta`, `Rute`, `Diskusi`, `Info`) in `RouteMap`. The Disqus thread (shortname `transjakarta`, one thread for the whole map) mounts only after it is opened: from the `Diskusi` tab on phones, or from md up from a floating button left of the locate button, which shows it in a card on the right of the map. Disqus allows one thread per page, so `wide` (a `matchMedia` check) picks which of the two places renders it. `disqus-react` needs `prop-types` installed but does not declare it as a dependency. The `tab` state decides which panel sections show (`onTab`), a status pill sits at the top, and tapping the map or the open tab closes the sheet. `BusInfo` is its own sheet resting on the tab bar. From `md` up the panel is a sidebar.
- The app can be installed (Add to Home Screen) through `public/manifest.webmanifest` and the meta tags in `__root.tsx`. There is no service worker, because the data is live and an offline cache wouldn't help. The PNG icons in `public/` were cut from two source drawings with ffmpeg: the "Info Tije" logo for the app icons (the maskable one padded on `#fbf1dc`) and the cat-in-a-car crop for `favicon.png`. `favicon.png`, `icon-192.png` and `icon-512.png` have transparent rounded corners (radius 22% of the width). `apple-touch-icon.png` and the maskable icon stay square, because iOS and Android apply their own mask.

## Styling

Tailwind v4 is configured in CSS (`src/styles.css`); there is no `tailwind.config`. Colors are CSS variables on `:root` (`--ground`, `--surface`, `--field`, `--line`, `--ink`, `--ink-soft`, `--accent`, `--accent-ink`, `--accent-soft`, `--accent-on-soft`) plus `--shadow` for floating controls. Use them as `bg-[var(--accent)]` and similar. The app is light only, because the positron basemap has no dark style. Base element rules live in `@layer base`; an unlayered rule would beat every Tailwind utility. The font is Plus Jakarta Sans.

The UI follows the category standard (Google Maps and Citymapper are the bar): fully rounded chips and buttons, 28px sheet corners, pale blue for selected states. `PRODUCT.md` and `.impeccable/surfaces/` hold the product record and the design brief.

## Conventions

- Prettier settings: no semicolons, single quotes, trailing commas.
- Import aliases: `#/*` (package.json `imports`) and `@/*` both map to `src/*`.
- Array types are written `Array<T>` in this codebase.
- Sentry (`.cursorrules`): `instrument.server.mjs` initializes it on the server and is skipped when `VITE_SENTRY_DSN` is unset. Wrap the body of any `createServerFn` handler in `Sentry.startSpan({ name: '...' }, async () => { ... })`, importing Sentry from `@sentry/tanstackstart-react`.
