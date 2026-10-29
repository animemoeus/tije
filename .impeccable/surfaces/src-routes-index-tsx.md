---
version: 1
slug: "src-routes-index-tsx"
primary_target: "src/routes/index.tsx"
related_targets: ["src/components/RouteMap.tsx","src/components/BusInfo.tsx"]
---

# Map page (/)

Mode: Operate. Phone first, desktop designed on purpose.

Audience and job: Jakarta riders find their bus or halte on the live map within seconds, while waiting outdoors or while planning which route stops where. Constraints: one hand, bright light, a live feed that can drop, an API that can be down.

Undecided: search by route code or halte name (not built).

## Direction contract

THESIS: The category standard, played straight at Google Maps and Citymapper craft. One map, one top bar, one sheet at a time. It refuses the current mix of square chips beside round pills and the two competing status pills.

OWN-WORLD: White surfaces on a light basemap, near-black ink, Google-style blue accent with a pale tonal blue for selected states. Fully rounded chips and buttons, 28px sheet corners, soft offset shadows. Route badges in each route's own colour. Plus Jakarta Sans, tabular numerals for live counts.

STORY: The rider opens the app, sees every live bus at once, taps theirs and reads where it is between two haltes and how far the next one is.

FIRST VIEWPORT: Phone 390x844. Full-bleed map. One floating top bar 12px from the edges: logo, "1.201 bus · 94 rute", live state on the right. Locate button bottom right above a Material-style nav bar (Peta, Rute, Diskusi, Info) with a pill indicator on the active tab. Desktop: a 384px left panel with logo header and live state, the map fills the rest.

FORM: canon (the standing exit, chosen by the user), reference bar Google Maps and Citymapper. Signature interaction: the bus card shows a Citymapper-style stop strip (previous halte, the bus, next halte with distance) drawn in the route colour. seed:b7ecb0a0b78180f7

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
