---
version: 1
slug: "src-app-m-engine-page-tsx"
primary_target: "src/app/m/[engine]/page.tsx"
related_targets: ["src/app/layout.tsx"]
---

---
version: 1
slug: "src-app-m-engine-page-tsx"
primary_target: "src/app/m/[engine]/page.tsx"
related_targets: ["src/app/layout.tsx"]
---

# Surface: market terminal (/m/[engine]) and app shell

Scope: Operate. Users: perp-native traders first, prediction-market users second. Task: read the
market (chart, book, mark, lifecycle), place/cancel orders, watch position, margin and deadlines.
Constraints: live chain reads (Monad testnet, chain 10143); deployed market is unactivated, unpriced
and 1x, so empty and unavailable states are first-class. No rounded corners. Brand colours only
(Ink, Ivory, Signal); green/red limited to side and P&L.

## Direction contract

THESIS: The terminal is the Eros mark at working scale: price as stacked flat bars, the mark price
as the one Signal bar. Refuses the default DeFi skin of rounded glowing cards on navy.

OWN-WORLD: (Re-skinned 2026-10-05 under the user-pinned v0 brutalist theme; see PRODUCT.md.) Ivory
#F2F1EC dot-grid ground, hard 1px Ink #0A0A0B frames, Ink inverted panels, Geist Mono labels in
uppercase and data in tabular figures, Geist Pixel Grid for display numbers and titles, Signal #FF5A36
for the mark price, arrow-square primary actions and live risk, zero radius everywhere including native
controls. Kept from the original contract: the shared price axis, unavailable stated as marks, changed
digits flip in place, the next deadline at scale.

STORY: The trader sees where price is, how deep the book is at each level, how long until the next
deadline, and whether they can act; unavailable data says why.

FIRST VIEWPORT: Framed top bar (lockup, nav, block, wallet) and the // TESTNET disclosure row. Left rail of
markets. Centre: chart owning ~45% width on bare Ink; the order book docked to its right on the
chart's own price axis so book levels align with chart levels; a Signal bar marks the mark across
both. Right: ticket. Below chart: next-deadline strip at large scale, then position/margin/orders.

FORM: Depth Ladder, candidate 7 of my ordered list; seed 0e5090ab. Signature interaction: the shared
price axis (book bars and chart share one probability scale; the Signal mark bar crosses both).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
