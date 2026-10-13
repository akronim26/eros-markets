"""Writes docs/assets/architecture.excalidraw. Edit the lists below, then run: python3 docs/assets/gen_architecture.py"""
import json
from pathlib import Path

INK = "#1e1e2e"
# name, stroke, fill
LANES = [
    ("Trader", "#e879f9", "#fdf4ff"),
    ("Keeper", "#2dd4bf", "#f0fdfa"),
    ("CollateralVault", "#a78bfa", "#f5f3ff"),
    ("EventPerp", "#fb923c", "#fff7ed"),
    ("ResolutionOracle", "#22d3ee", "#ecfeff"),
]
# (from, to, label, dashed); from == to draws a self-call; a str row is a phase label
STEPS = [
    "1 · fund",
    ("Trader", "CollateralVault", "deposit(atoms)", True),
    ("Trader", "CollateralVault", "allocate(engine, atoms)", True),
    ("CollateralVault", "EventPerp", "onAllocate(): credit cashQ", False),
    "2 · trade",
    ("Keeper", "EventPerp", "submitObservation(): index sample", True),
    ("Trader", "EventPerp", "placeOrder() / batch()", True),
    ("EventPerp", "EventPerp", "_riskPrepareTaker, _riskTryMatchedFill per maker", False),
    ("EventPerp", "Trader", "Fill at maker tick, remainder rests", True),
    "3 · liquidate",
    ("Keeper", "EventPerp", "liquidate(trader, maxLots, maxExaminations, partner)", True),
    ("EventPerp", "EventPerp", "pair close → forced IOC → takeover to reserve", False),
    ("EventPerp", "Keeper", "half the fee to keeperPayableQ", True),
    "4 · resolve",
    ("ResolutionOracle", "EventPerp", "halt(): immutable snapshot", True),
    ("ResolutionOracle", "EventPerp", "settle(Y) / settleInvalid()", True),
    ("Keeper", "EventPerp", "prepareSnapshotChunk(), preparePayoutChunk()", True),
    ("EventPerp", "CollateralVault", "escrow(owner, atoms)", False),
    "5 · claim",
    ("Trader", "EventPerp", "claimTrader(owner)", True),
    ("EventPerp", "CollateralVault", "claim(engine, owner)", False),
    ("CollateralVault", "Trader", "USDC sent back to Trader", True),
]

LANE_GAP, BOX_W, BOX_H, ROW, TOP = 270, 190, 64, 52, 40
FONT = 6  # Nunito
xs = {name: 100 + i * LANE_GAP for i, (name, *_) in enumerate(LANES)}
els, n = [], 0


def base(kind, x, y, w, h, **kw):
    global n
    n += 1
    e = dict(id=f"{kind}{n}", type=kind, x=x, y=y, width=w, height=h, angle=0, strokeColor=INK,
             backgroundColor="transparent", fillStyle="solid", strokeWidth=2, strokeStyle="solid",
             roughness=0, opacity=100, groupIds=[], frameId=None, roundness=None, seed=n,
             version=1, versionNonce=n, isDeleted=False, boundElements=None, updated=1,
             link=None, locked=False)
    e.update(kw)
    els.append(e)
    return e


def text(s, x, y, size=17, color=INK, align="center", container=None, w=None):
    w = w or len(s) * size * 0.55
    h = size * 1.25
    if align == "center" and not container:
        x -= w / 2
    return base("text", x, y, w, h, text=s, originalText=s, fontSize=size, fontFamily=FONT,
                textAlign=align, verticalAlign="middle", containerId=container, autoResize=True,
                lineHeight=1.25, strokeColor=color)


def lane_box(name, stroke, fill, y):
    r = base("rectangle", xs[name] - BOX_W / 2, y, BOX_W, BOX_H, strokeColor=stroke,
             backgroundColor=fill, roundness={"type": 3})
    t = text(name, xs[name] - BOX_W / 2, y + BOX_H / 2 - 11, container=r["id"], w=BOX_W)
    r["boundElements"] = [{"type": "text", "id": t["id"]}]


bottom = TOP + BOX_H + 30 + ROW * len(STEPS)
for name, stroke, fill in LANES:
    lane_box(name, stroke, fill, TOP)
    lane_box(name, stroke, fill, bottom)
    base("line", xs[name], TOP + BOX_H, 0, bottom - TOP - BOX_H, points=[[0, 0], [0, bottom - TOP - BOX_H]])

y = TOP + BOX_H + 40
for step in STEPS:
    if isinstance(step, str):
        text(step, xs[LANES[0][0]] - 210, y - 6, size=15, color="#868e96", align="left")
        base("line", xs[LANES[0][0]] - 210, y + 18, xs[LANES[-1][0]] - xs[LANES[0][0]] + 310, 0,
             strokeColor="#dee2e6", strokeWidth=1, strokeStyle="dotted",
             points=[[0, 0], [xs[LANES[-1][0]] - xs[LANES[0][0]] + 310, 0]])
        y += ROW
        continue
    a, b, label, dashed = step
    style = "dashed" if dashed else "solid"
    if a == b:
        x0 = xs[a]
        pts = [[0, 0], [48, 0], [48, 24], [6, 24]]
        base("arrow", x0, y + 4, 48, 24, points=pts, strokeStyle=style, startArrowhead=None,
             endArrowhead="triangle", elbowed=False)
        text(label, x0, y - 16, size=15)
    else:
        x0, x1 = xs[a] + (6 if xs[b] > xs[a] else -6), xs[b] + (-6 if xs[b] > xs[a] else 6)
        base("arrow", x0, y + 10, abs(x1 - x0), 0, points=[[0, 0], [x1 - x0, 0]], strokeStyle=style,
             startArrowhead=None, endArrowhead="triangle", elbowed=False)
        text(label, (x0 + x1) / 2, y - 16, size=15)
    y += ROW

out = Path(__file__).with_name("architecture.excalidraw")
out.write_text(json.dumps({"type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
                           "elements": els, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20},
                           "files": {}}, indent=1))
print(out, len(els), "elements")
