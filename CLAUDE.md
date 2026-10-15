# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TanStack Start (React 19, SSR via Nitro) app that draws Transjakarta bus routes on a MapLibre map. All UI text is in Indonesian (`<html lang="id">`). The data comes from the sibling project `../tije-api`, a Rust (axum) API that serves `GET /route-types`, `GET /routes?type=BRT,Mikrotrans`, the live bus feed `WS /ws?routes=...` and a per-bus event stream `GET /buses/{bus_body_no}`. Set its base URL with `VITE_API_URL` (default `https://api.tije.info`; `.env.local` points it at `http://localhost:8000`). When the API isn't running, the map shows an error card with a retry button.

## Working rules

- Write plans in Indonesian. Code, identifiers, comments and docstrings stay in English.
- Before implementing anything that touches the API (fetches, the WebSocket feed, the bus event stream, bus or route fields, update rates), read the backend source in `../tije-api`: `README.md` for endpoints and message shapes, `src/routes.rs` for `/route-types` and `/routes`, `src/live.rs` for `/ws`, `/buses/{bus_body_no}` and the bus fields, and `src/config.rs` for defaults. Don't infer field names, units, defaults or limits from the frontend alone. For example, the API often sends `speed` and `timestamp` as 0, it no longer sends `age_seconds`, and a `/ws` without `routes` streams every bus (about 3,900).
- Run every piece of prose (docs, docstrings, comments, commit messages, PR descriptions) through the `humanizer:humanizer` skill before saving it.
- Give every function a docstring (JSDoc `/** ... */` in TS/TSX).
- Use the `ponytail:ponytail` skill on every coding task.
- For any UI work, use the `ui-ux-pro-max:ui-ux-pro-max` skill.

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
  - The type filter is a row of checkbox chips. The chosen types live in the URL as `?type=BRT,Mikrotrans` (`src/routes/index.tsx`): no param means BRT, `all` means every type, and `RouteMap` gets them as `types: Array<string>`, where an empty array means all.
  - Live buses come from `/ws?routes=<codes of the routes drawn>`: one snapshot, then deltas. Updates arrive about every 1.5 to 2 seconds, and the backend doesn't interpolate positions. A ring pings around a bus when its `raw_latitude`/`raw_longitude` change.
  - Popups are built with `textContent` instead of HTML strings so API values never become markup.
- `src/components/BusInfo.tsx` follows the selected bus with an `EventSource` on `/buses/{bus_body_no}`. A `bus` event replaces the card's data; `gone` means the bus left the feed, and the card then closes the stream so it doesn't reconnect. The "updated" age counts from when the last `bus` event arrived.
- Basemap tiles come from OpenFreeMap's `positron` style.

## Styling

Tailwind v4 is configured in CSS (`src/styles.css`); there is no `tailwind.config`. Colors are CSS variables (`--ground`, `--surface`, `--field`, `--ink`, `--ink-soft`, `--accent`, `--accent-ink`) defined for light mode, for `[data-theme='dark']`, and for `prefers-color-scheme: dark` when no explicit light theme is set. Use them as `bg-[var(--accent)]` and similar. If you add a token, define it in all three blocks. The font is Plus Jakarta Sans.

## Conventions

- Prettier settings: no semicolons, single quotes, trailing commas.
- Import aliases: `#/*` (package.json `imports`) and `@/*` both map to `src/*`.
- Array types are written `Array<T>` in this codebase.
- Sentry (`.cursorrules`): `instrument.server.mjs` initializes it on the server and is skipped when `VITE_SENTRY_DSN` is unset. Wrap the body of any `createServerFn` handler in `Sentry.startSpan({ name: '...' }, async () => { ... })`, importing Sentry from `@sentry/tanstackstart-react`.
