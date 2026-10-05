# Surface: market terminal (/m/[engine]) and app shell

Scope: Operate. Users: perp-native traders first, prediction-market users second. Task: read the
market (chart, book, mark, lifecycle), place/cancel orders, watch position, margin and deadlines.
Constraints: live chain reads (Monad testnet, chain 10143); deployed market is unactivated, unpriced
and 1x, so empty and unavailable states are first-class. No rounded corners. Brand colours only
(Ink, Ivory, Signal); green/red limited to side and P&L.

## Direction contract

THESIS: The terminal is the Eros mark at working scale: price as stacked flat bars, the mark price
as the one Signal bar. Refuses the default DeFi skin of rounded glowing cards on navy.

OWN-WORLD: Ink #0A0A0B ground, a second neutral layer #111214 for rails, ivory #F2F1EC type at
three steps, 1-device-pixel hairlines for every divider, zero radius everywhere, flat solid bars
for depth, Signal #FF5A36 rationed to mark price, primary action and live risk. Inter Tight,
tabular figures, values flip per digit on change.

STORY: The trader sees where price is, how deep the book is at each level, how long until the next
deadline, and whether they can act; unavailable data says why.

FIRST VIEWPORT: Top bar (lockup, market selector, lifecycle chip, block, wallet). Left rail of
markets. Centre: chart owning ~45% width on bare Ink; the order book docked to its right on the
chart's own price axis so book levels align with chart levels; a Signal bar marks the mark across
both. Right: ticket. Below chart: next-deadline strip at large scale, then position/margin/orders.

FORM: Depth Ladder, candidate 7 of my ordered list; seed 0e5090ab. Signature interaction: the shared
price axis (book bars and chart share one probability scale; the Signal mark bar crosses both).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
