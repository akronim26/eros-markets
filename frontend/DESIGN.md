---
name: Eros Markets
description: Binary event perpetuals on Monad, drawn as an engineering sheet: Ivory dot grid, hard Ink frames, one Signal mark.
colors:
  ground: "#f2f1ec"
  panel: "#f7f6f2"
  hover: "#e9e7e0"
  press: "#dfdcd3"
  ink: "#0a0a0b"
  ink-2: "#18181a"
  fg: "#0a0a0b"
  fg-2: "#3d3b37"
  fg-3: "#57544e"
  fg-4: "#6b6862"
  ivory: "#f2f1ec"
  ivory-3: "#a8a59d"
  line: "#d2cec5"
  line-strong: "#0a0a0b"
  dot: "#c9c5bb"
  signal: "#ff5a36"
  signal-text: "#c2401c"
  on-signal: "#0a0a0b"
  bid: "#17784e"
  ask: "#b02a45"
typography:
  display:
    fontFamily: "Geist Pixel Grid, Geist Mono, monospace"
    fontSize: "clamp(2.75rem, 8vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  page-title:
    fontFamily: "Geist Pixel Grid, Geist Mono, monospace"
    fontSize: "3rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.01em"
  countdown:
    fontFamily: "Geist Pixel Grid, Geist Mono, monospace"
    fontSize: "2.25rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "\"tnum\""
  headline:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    fontFeature: "\"tnum\""
  label:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.08em"
rounded:
  none: "0"
spacing:
  hair: "1px"
  xs: "6px"
  sm: "12px"
  md: "20px"
  lg: "24px"
  xl: "32px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
  button-primary-disabled:
    backgroundColor: "{colors.press}"
    textColor: "{colors.fg-4}"
  arrow-square:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
    rounded: "{rounded.none}"
    size: "40px"
  button-secondary:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-bid:
    backgroundColor: "{colors.bid}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    height: "40px"
  button-ask:
    backgroundColor: "{colors.ask}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    height: "40px"
  chip:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 8px"
    height: "24px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "36px"
  panel-head:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.fg-3}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "32px"
  panel-head-inverted:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ivory-3}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "32px"
  nav-link:
    textColor: "{colors.fg-3}"
    typography: "{typography.label}"
    padding: "0 12px"
  nav-link-active:
    textColor: "{colors.fg}"
---

# Design System: Eros Markets

## Overview

**Creative North Star: "The Engineering Sheet"**

Every surface is a drawing on squared paper: an Ivory ground pricked with a dot grid, regions boxed in hard one-pixel Ink frames, labels set in uppercase mono as if stencilled onto the sheet, and one Signal orange reserved for the thing that matters right now (the mark price, the primary action, live risk). The world is the user-pinned v0 "Brutalist AI SaaS" template translated into Eros colours and sharpened: its rounded pills become square frames, its invented demo metrics are replaced by live chain values.

Density is trader-grade. The terminal packs a market rail, a chart and book on one shared probability axis, a ticket, and account tables inside a single frame, separated by rules rather than gaps. Marketing and index pages loosen to a 1280px column of framed bento panels, each introduced by a numbered `// SECTION` rule. Inverted Ink panels (the landing's live terminal, the middle resolution layer) are the only change of material; there is no drop shadow, glow, blur or shading gradient anywhere.

Motion is mechanical and small: changed digits flip into place without moving their column, a block caret blinks at the end of typed terminal lines, a ticker marquee crawls, and pixel headlines resolve through scrambled characters. All of it stops under reduced motion.

**Key Characteristics:**
- Ivory dot-grid ground (22px pitch), hard 1px Ink frames, zero radius on every element including native controls.
- Geist Mono for all text; Geist Pixel Grid only for display headlines, page titles and the deadline countdown.
- Signal orange is a single voice: mark, primary action square, live status, active nav underline.
- Green and red mean side and P&L, nothing else.
- Unknown values are drawn as outlined marks with a reason, never as zero.

## Colors

A near-monochrome ink-on-paper palette with one hot accent and two strictly scoped trading colours.

### Primary
- **Signal Orange** (signal): the mark-price bar and axis tag, the arrow square on every primary action, live status squares, the active nav and tab underline, text selection, focus outline and caret. Fills and large type only.
- **Burnt Signal** (signal-text): the same voice at text size on Ivory (mark values in tables, the `// TESTNET` tag, Signal chips, spec callouts), because full Signal fails contrast as small text.
- **Ink on Signal** (on-signal): the only colour placed on a Signal fill (arrow glyphs, the mark tag's number).

### Secondary
- **Bid Green** (bid) and **Ask Crimson** (ask): buy/sell side tabs and submit buttons, book bars, bid/ask chips, P&L and transaction outcomes. Never decoration, never status.

### Neutral
- **Ivory Sheet** (ground): the page ground and the fill of most framed panels.
- **Raised Ivory** (panel): a barely lifted fill for figure backgrounds inside a frame.
- **Worn Ivory / Pressed Ivory** (hover / press): hover and pressed states on Ivory controls; pressed also marks the selected segment and disabled fills.
- **Ink** (ink, line-strong, fg): frames, primary text, the primary button block and inverted panels. **Ink Lift** (ink-2) is hover on Ink.
- **Text steps** (fg-2, fg-3, fg-4): body copy, secondary labels, and the faintest legible tier (axis ticks, placeholders, disabled text).
- **Ivory on Ink** (ivory, ivory-3): primary and secondary text inside inverted panels.
- **Inner Rule** (line): rules between rows and cells inside a frame, chart gridlines, segmented-control gutters.
- **Grid Dot** (dot): the ground's dot grid, nothing else.

### Named Rules
**The One Voice Rule.** Signal marks what is live or actionable now: the mark, the primary action, live risk. It never fills a panel and never colours body copy.

**The Small Signal Rule.** Signal text below large-type size uses Burnt Signal on Ivory; full Signal is for fills, bars, squares and display-size type.

**The Side-Only Rule.** Green and red are reserved for trade side and P&L. Health, warnings and status use Ink, outlines and Signal.

## Typography

**Display Font:** Geist Pixel Grid (with Geist Mono, monospace)
**Body Font:** Geist Mono (with ui-monospace, monospace)
**Label/Mono Font:** Geist Mono

**Character:** A single monospaced family carries everything, so every number lines up and every label reads as an instrument readout; the pixel-grid face appears only at scale, where its dot construction echoes the ground.

### Hierarchy
- **Display** (pixel, clamp 2.75 to 6rem, line-height 0.95): the landing hero only, uppercase, resolved through scramble text.
- **Page title** (pixel, 3rem, line-height 1, uppercase): one per index page (Markets, Portfolio, Resolution).
- **Countdown** (pixel, 2.25rem, tabular): the terminal's next-deadline readout, the one pixel number in the app.
- **Headline** (mono 600, 1.5rem, -0.02em, uppercase): section headings and bento panel titles on the landing.
- **Title** (mono 600, 1rem to 1.25rem): market question titles and card titles.
- **Body** (mono 400, 0.875rem, line-height 1.625): explanatory paragraphs, held to 52 to 70ch.
- **Data** (mono 400, 0.75rem, tabular): key-value rows, transaction notes; headline stats step up to 1.5 to 1.875rem at weight 500.
- **Label** (mono 500, 0.6875rem, 0.08em tracking, uppercase): nav, buttons, chips, panel heads, section rules, form labels.

### Named Rules
**The Pixel-at-Scale Rule.** Geist Pixel Grid is used only at 2.25rem and above, and only for the hero, page titles and the countdown. Everything else is Geist Mono.

**The Fixed Column Rule.** Every number is tabular, and a changing value flips only its changed characters in place (150ms); columns never shift.

## Layout

The page ground is the full-bleed dot grid; content sits inside Ink frames on it. The top bar is a framed 48px strip, sticky with a 12px ground margin (8px on mobile), followed by the unframed `// TESTNET` disclosure row.

Marketing and index pages use a centred 1280px column with 16px gutters (32px from md), page titles 40px below the bar, and 96px between sections. Each section opens with a `// SECTION: NAME ———— 00n` rule, then a framed grid 24px below it: two columns on the landing bento, three for the resolution layers, collapsing to one column below md, with cells divided by 1px Ink rules rather than gaps.

The terminal is one frame filling the viewport (12px inset) with a three-column grid from lg: a 232px market rail, a flexible centre (market header, legend, shared price axis, deadline strip, detail tabs) and a 300px ticket and account column. Below lg the rail hides and the ticket and account stack under the chart, which keeps 46vh (minimum 300px).

Inside frames, rhythm comes from rules: 1px Inner Rules between rows, 1px Ink rules between regions, 12px padding in dense panels and 20 to 24px in bento panels. Region heads are 32 to 36px; controls are 28, 32 or 40px tall.

## Elevation & Depth

The system is flat. There are no drop shadows, glows, blurs or colour-wash gradients (the only gradients in the build draw the dot grid and dash patterns). Depth is stated by line and material: a 1px Ink frame encloses a region, a 1px Inner Rule divides inside it, and an inverted Ink panel is the single way to make one region read as a different instrument. The few `box-shadow` values in the build are all inset 1px hairlines used as rules, not elevation.

### Named Rules
**The Frame-Not-Float Rule.** Regions are separated by drawn lines and material inversion; nothing lifts off the sheet.

**The Real Frame Rule.** Outer frames are true 1px borders, so child backgrounds can never paint over them; inset hairlines are for inner rules and outlined chips only.

## Shapes

Every corner is square (0), enforced globally including third-party and native controls. Shapes are rectangles and squares: arrow squares on actions, 8px status squares, 10px outlined unavailable marks, 6px node squares in diagrams, a drawn square checkbox. Lines are 1px for frames and rules, 2px for active underlines and deadline progress, 3px for the mark bar. Dashed and dotted strokes distinguish derived series (book price, index unavailable) from solid ones.

## Components

### Buttons
Blunt, labelled blocks; the primary action is a two-part object.
- **Shape:** square (0).
- **Primary:** an Ink block with an Ivory uppercase label, preceded by a flush Signal square holding an Ink arrow (28, 32 or 40px square to match the button height).
- **Hover / Focus:** Ink lifts to Ink Lift; focus draws a 2px Signal outline at 2px offset. Disabled turns both parts Pressed Ivory with faint text.
- **Secondary:** an Ivory block outlined in 1px Ink, Worn Ivory on hover, Pressed Ivory when active.
- **Ghost:** text only in fg-2, Worn Ivory on hover.
- **Bid / Ask:** the submit button takes the side colour as its label block (Ivory text) behind the same Signal arrow square.
- **On Ink:** inverted panels flip the label block to Ivory with Ink text.

### Chips
- **Style:** a 24px uppercase label in a 1px outline of its tone colour, on the ground: Ink outline for neutral and warning, Signal outline with Burnt Signal text, side colours for bid/ask, Inner Rule outline with fg-3 text when muted.
- **State:** chips are status, not controls; they carry no hover.

### Cards / Containers
- **Corner Style:** square (0).
- **Background:** Ivory Sheet, or Ink for an inverted panel.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px Ink frame outside, 1px Ink rule under the head, Inner Rules within.
- **Internal Padding:** 12px dense, 20 to 24px bento.

### Inputs / Fields
- **Style:** 36px Ivory field with a 1px Ink outline, tabular body text, fg-4 placeholder, Signal caret.
- **Focus:** the global 2px Signal outline at 2px offset; an outline swap from Ink to Ink is not a focus state.
- **Checkbox:** a drawn 14px square, 1px Ink border, filling Ink with an Ivory check when on.
- **Segmented control:** cells sit on an Inner Rule gutter (1px); the selected cell is Pressed Ivory with Ink text.

### Navigation
- **Top bar:** a framed 48px strip: lockup left, uppercase label links centred, block indicator and wallet right. Links are fg-3, Ink on hover; the active link is Ink with a 2px Signal underline inset 12px. On mobile the links wrap to a second row ruled in Ink and scroll horizontally.
- **Tabs:** the same label-plus-Signal-underline treatment on a ruled 36px strip.

### Panel Head
A 32 to 36px label row ruled underneath in Ink: the region name left (`TERMINAL.SYS`, `MANIFEST.MD`, `STATE.PRICE` on bento and state panels; a plain name such as `ORDER` in the terminal), its meta right in fg-3. On Ink panels the text is Ivory secondary.

### Section Rule
`// SECTION: NAME`, an Inner Rule running to the edge, and the section's real three-digit ordinal, all in fg-3 label type. It opens every section of a marketing or index page.

### Shared Price Axis
The chart and the order book share one probability axis (0.00 to 1.00, Inner Rule gridlines, fg-4 tick labels). Book levels are side-coloured bars docked right of the chart, separated by an Ink rule; the mark is a 3px Signal bar crossing both with a Signal tag on the axis. With no mark, the axis carries an outlined Signal box and an empty book shows outlined level squares.

### Unavailable Mark
A 10px outlined square (fg-3, or Signal for the mark price) followed by a short reason such as "no mark" or "book empty", with the full reason on hover. It replaces any number the contract cannot yet supply.

### Live Terminal and Ticker
An inverted Ink panel types the market's real chain state line by line behind a blinking block caret. A framed marquee of live values crawls across the page, cells divided by Ink rules. Both stop under reduced motion.

## Do's and Don'ts

### Do:
- **Do** keep every corner at 0, native controls and third-party widgets included.
- **Do** box regions in 1px Ink frames on the Ivory dot grid, and divide inside them with 1px Inner Rules (#d2cec5).
- **Do** lead every primary action with the Signal arrow square joined to an Ink (or side-coloured) label block.
- **Do** set labels in uppercase Geist Mono at 0.6875rem with 0.08em tracking, and every number in tabular figures.
- **Do** use Burnt Signal (#c2401c) for Signal-coloured text below display size.
- **Do** state unknown values with an Unavailable mark and its reason.
- **Do** number `// SECTION` rules with the section's real ordinal.

### Don't:
- **Don't** use drop shadows, glows, blur, colour-wash gradients or rounded pills; depth is line and inversion only (the dot grid's radial dots and dash masks are pattern, not shading).
- **Don't** use green or red for anything but trade side and P&L.
- **Don't** set Geist Pixel Grid below 2.25rem or for body, labels or table data.
- **Don't** show invented metrics, volumes or testimonials; only live chain values or real protocol constants appear.
- **Don't** fill a panel or colour body copy with Signal.
