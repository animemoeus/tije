# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Transit riders in Jakarta. Most open Tije on a phone while they wait at a halte or walk to one, to see where their bus is and how far away it is. The same riders also plan ahead: which routes stop at a halte, and where a route goes, before they leave. They use one hand, often outdoors in bright light, and close the app again within a minute. A smaller group opens it on a laptop to look at the whole network.

## Product Purpose

Tije shows Transjakarta routes, haltes and every live bus on one map, so a rider can watch their bus come instead of guessing. It is live at https://tije.info. Success means a rider finds their bus or halte in a few seconds and trusts what the map says about it.

## Positioning

Live positions for the whole fleet (about 1,200 buses on the default routes, 3,900 across all types) on one map, with buses that glide along their route lines between GPS reports and a per-bus card that follows one bus as it moves.

## Operating Context

- Phone first, installed to the home screen as a standalone portrait app, or opened from a link. Desktop is a full second home, not a stretched phone layout.
- Data comes from tije-api: route types, routes, stops, a WebSocket bus feed that updates every 1.5 to 2 seconds, and a per-bus event stream. The feed can drop and reconnect, and the API can be down.
- Location comes from the browser's geolocation and needs HTTPS.
- All UI text is Indonesian.

## Capabilities and Constraints

- Full-screen live map as the first screen on phones.
- Filter by route type (BRT, Angkutan Umum Integrasi, Mikrotrans, Transjabodetabek, Royaltrans, Rusun, Bus Wisata); the choice lives in the URL.
- Halte layer on or off; tapping a halte lists the routes that stop there.
- Tapping a bus opens a live card: route, direction, previous and next halte, distance to the next halte, last update.
- Locate button that follows the user like Google Maps.
- One Disqus discussion thread for the whole map.
- Undecided: search by route code or halte name. Riders plan trips, but no search exists yet.

## Brand Commitments

- The "Info Tije" logo and the white cat in a small blue car (`public/icon-512.png`, `public/favicon.png`) stay as the app's identity. The icons sit on cream `#fbf1dc`. They appear only as the app icon and favicon; the owner chose to keep the cat image out of the in-app UI on phones and desktop.
- The voice is lightly satirical, like the README's fine print. Jokes belong in small copy, never in live information.
- Tije is unofficial. It must not copy PT Transjakarta's logo or corporate branding.
- The app UI follows the category standard on purpose (chosen 2026-10-29): a map app that sits next to Google Maps and Citymapper and matches their craft, without novelty for its own sake.

## Evidence on Hand

Live data from https://api.tije.info, the app icons in `public/`, and the README. No user counts, testimonials or press exist; do not invent them.

## Product Principles

1. The map is the product. Every control earns its pixels against the map.
2. Live information is plain and exact. Personality stays out of numbers, states and errors.
3. A glance in bright sun is enough: big targets, strong contrast, short labels.
4. Phone and desktop are both designed on purpose.
5. Calm over busy. Decoration and motion that do not report a state get cut.

## Accessibility & Inclusion

Outdoor use in sunlight and one-handed use: large touch targets (44 px minimum), high contrast, and support for reduced motion. Screen readers and keyboards must keep working for the filters, tabs, cards and dialogs.
