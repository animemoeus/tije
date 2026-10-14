# tije

Transjakarta bus routes on a MapLibre map. Because one route map app was clearly not enough.

## Run it

```bash
npm install
npm run dev   # http://localhost:3000
```

The data comes from `../transjakarta-api`, hosted at `http://transjakarta-api.animemoe.us` by default. If it's down, enjoy an error card with a "retry" button that will wait for you forever. Running your own? Set `VITE_API_URL` in `.env.local`.

## Production

```bash
npm run build
npm run start
```

The build lands in `.output/`. Not `dist/`, so don't go looking there.

## Other stuff

- `npm run lint`, `npm run format`, `npm run check`.
- `npx tsc --noEmit` if you want to know how bad it is.
- Tests? None yet. We run on courage.
- Sentry turns on when `VITE_SENTRY_DSN` is set. Leave it empty and the errors stay between you and me.
