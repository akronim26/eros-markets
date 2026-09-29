# EventPerp — Theory and Design Spec

> Leveraged perpetual-style contracts on binary outcome tokens, settled to the outcome.
> Dated 29 Sep 2026. Builds on the build plan (`roadmap.md`, 27 Sep), which remains the only source of **parameter values** (its §3). This spec is the source of **derivations, proofs and design rationale**. §12 lists where it changes the plan.

---

## 0. Scope

- One YES/NO question per market. The contract ends at resolution and pays each position against $Y\in\{0,\tfrac12,1\}$ ($\tfrac12$ = INVALID).
- Native markets: own YES/NO ERC20s (OutcomeVault), spot on Kuru, index from the Kuru mid, $L_{\text{cap}}=3$. Mirrored markets (Polymarket price and outcome, $L_{\text{cap}}=5$) run on the same engine.
- Isolated margin per (trader, market), USDC collateral, Monad.

Non-goals: multi-outcome events (listed as separate binaries), cross-margin, mainnet real-money operation.

---

## 1. Notation

| Symbol | Meaning |
|---|---|
| $\tau,\ t,\ T=\tau-t$ | resolution time, now, time to resolution |
| $n=s\,x$ | signed position; $s=+1$ long, $-1$ short; $x$ size (1 unit pays 1 USDC on YES) |
| $p_0$ | average entry price; accounts store $N=n\,p_0$ |
| $C$ | collateral incl. realised P&L, settled funding, penalties |
| $I,\ I_S,\ m_k$ | fast index, slow index, last raw keeper sample |
| $q$ | mark |
| $w(p)$ | worst-case loss per unit: $p$ long, $1-p$ short |
| $W=x\,w(q)$, $E=C+n(q-p_0)$, $L=W/E$ | worst-case loss, equity, leverage |
| $J(T)$, $e(x)$, $u$ | jump buffer, path + execution buffer, IM headroom |
| $\Phi,\ \phi$ | standard normal CDF and density; $z=\Phi^{-1}(p)$ |
| $\varphi,\ \varphi_{\text{eff}}$ | liquidation penalty rate (roadmap notation) |

---

## 2. The underlying

### 2.1 Bounded martingale with a terminal jump

Under the pricing measure $p_t=\mathbb E[Y\mid\mathcal F_t]$, so $p$ is a martingale on $[0,1]$ with $p_\tau\in\{0,1\}$ (ignoring INVALID). Because $p_\tau^2=p_\tau$:

$$
\operatorname{Var}(p_\tau\mid p_t)=\mathbb E[p_\tau^2]-p_t^2=p_t-p_t^2=p_t(1-p_t).
$$

**Consequence.** The variance left until resolution is fixed at $p(1-p)$ however little time remains, so variance per unit time must grow as $T\to0$. Most assets have vol that doesn't depend on the horizon; binaries get more volatile as resolution nears. This is the root reason leverage must fall to 1.

### 2.2 Diffusion model: local volatility

Let the event be $\{B_\tau>c\}$ for a Brownian motion $B$ with variance rate $\sigma_B^2$. Then

$$
p_t=\Phi\!\Big(\frac{B_t-c}{\sigma_B\sqrt T}\Big),
\qquad
dp_t=\frac{\phi(z)}{\sqrt T}\,\frac{dB_t}{\sigma_B}
\ \Rightarrow\
\sigma_p(p,T)=\frac{\phi(\Phi^{-1}(p))}{\sqrt T}.
$$

(The drift vanishes because $p$ is a martingale; $\sigma_B$ cancels.) $\sigma_p$ is largest at $p=\tfrac12$ ($\phi(0)=0.399$), smallest at the edges, and grows like $T^{-1/2}$.

A $k$-sigma adverse move over a liquidation delay $h$ is

$$
\Delta p_k(p,T)=k\,\phi(z)\sqrt{h/T}.
$$

### 2.3 Jumps

Real markets also jump: a headline moves 0.30 → 0.95 in one block, and markets that can resolve early ("by date X") can jump to 0 or 1 at any moment. No liquidation can act inside a jump. The diffusion term bounds the moves liquidators can react to; the jump buffer $J$ and the insurance fund bound the rest. Jump size scales with $w$ near the edges (a 0.05 longshot collapsing to 0 is a single headline), which is why $J$ is not taken from the diffusion model (§4.3).

---

## 3. Positions and accounting

### 3.1 Worst-case basis (Eq-1)

$$
w(p)=\begin{cases}p&\text{long}\\1-p&\text{short}\end{cases}
\qquad W=x\,w(q)\qquad E=C+n(q-p_0)\qquad L=\frac{W}{E}
$$

Leverage is measured against the capital that can actually be lost. A short YES position is therefore exactly a long NO position, and every formula is symmetric under $p\leftrightarrow1-p$. Measuring leverage as $x\,q/E$ for both sides would give a short at 0.9 ten times its real risk.

**Liquidation price (for intuition only; the engine uses Eq-10).** With a constant maintenance fraction $m$ of $W$ and $C=x\,w(p_0)/L$:

$$
p_{\text{liq,long}}=\frac{p_0(1-1/L)}{1-m},
\qquad
1-p_{\text{liq,short}}=\frac{(1-p_0)(1-1/L)}{1-m}.
$$

At $L=1$, $m=0$ these are 0 and 1, so the position can never be liquidated.

### 3.2 Fills (Eq-2)

Signed fill $\delta$ at price $q_f$, $n'=n+\delta$:

| Case | $p_0'$ | $C'$ |
|---|---|---|
| increase ($n\delta\ge0$) | $\dfrac{n p_0+\delta q_f}{n+\delta}$ | $C$ |
| reduce ($n\delta<0,\ \lvert\delta\rvert\le\lvert n\rvert$) | $p_0$ | $C-\delta(q_f-p_0)$ |
| flip ($n\delta<0,\ \lvert\delta\rvert>\lvert n\rvert$) | $q_f$ | $C+n(q_f-p_0)$ |

### 3.3 Conservation (Eq-3)

**Claim.** Every fill changes $C-n\,p_0$ by exactly $-\delta\,q_f$.

- increase: $\Delta(C-np_0)=-(n'p_0'-np_0)=-(np_0+\delta q_f-np_0)=-\delta q_f$
- reduce: $-\delta(q_f-p_0)-\delta p_0=-\delta q_f$
- flip: $n(q_f-p_0)-(n+\delta)q_f+np_0=-\delta q_f$

Buyer and seller have $\delta_b=-\delta_s$, so their changes cancel. With market balance $B_m$ (deposits − withdrawals ± IF transfers) and funding settled:

$$
\sum_i(C_i-n_ip_{0,i})=B_m,\quad\sum_in_i=0
\ \Rightarrow\
\sum_iE_i(q)=B_m\ \text{ for every common }q.
$$

The market is zero-sum at every price, in particular at $q=Y$.

### 3.4 Shortfall and the full-collateral identity (Eq-4)

At resolution $E_Y=C+n(Y-p_0)$. On the losing side $E_Y=C-x\,w(p_0)$, so

$$
\text{shortfall}=\max\big(0,\ x\,w(p_0)-C\big).
$$

With $C=x p_0/L$: shortfall $=x p_0(1-1/L)$, which is zero **only at $L=1$** (Alice: $1000\times0.60\times0.8=480$).

**Proposition (full collateral, mark-free).**

$$
E\ge W\iff
\begin{cases}C+x(q-p_0)\ge xq&\text{long}\\C-x(q-p_0)\ge x(1-q)&\text{short}\end{cases}
\iff C\ge x\,w(p_0).
$$

The mark cancels, so "fully collateralised" can be checked without any price. This is what makes the final tier oracle-proof.

**Corollary (L=1 is spot).** A matched long/short pair at $p_0$ with $C_{\text{long}}=xp_0$ and $C_{\text{short}}=x(1-p_0)$ holds exactly $x$ USDC: the collateral of $x$ complete sets in the OutcomeVault. Settling to the outcome is then solvent by construction.

---

## 4. Margin

### 4.1 Buffers (Eq-5, Eq-6)

Closing $x$ units into a book with half-spread $s_b$ and linear depth density $\rho$ walks the price by $x/\rho$. The average execution cost per unit is

$$
\frac1x\int_0^x\Big(s_b+\frac y\rho\Big)dy=s_b+\frac{x}{2\rho},
\qquad
e(x)=k\sigma\sqrt h+s_b+\frac{x}{2\rho}.
$$

The jump buffer steps down by tier and ends at 1:

$$
J(T)=J_0\ (T>T_1),\ J_1\ (T_2<T\le T_1),\ J_2\ (T_3<T\le T_2),\ 1\ (T\le T_3).
$$

### 4.2 Maintenance and initial margin (Eq-7 – Eq-9)

$$
MM=x\,\min\big(w(q),\ J(T)+e(x)\big)
$$

$$
IM=x\,\min\Big(c\,w(q),\ \max\Big(\frac{w(q)}{L_{\text{cap}}},\ J(T-T_g)+e(x)+u\,w(q)\Big)\Big),
\quad c=\begin{cases}1+u&T>T_3\\1&T\le T_3\end{cases}
$$

$$
L_{\max}=\frac{W}{IM}=\max\Big(\frac1c,\ \min\Big(L_{\text{cap}},\ \frac{w}{J(T-T_g)+e+u\,w}\Big)\Big).
$$

**INV-5 proof ($T>T_3$).** $J(T-T_g)\ge J(T)$ because $J$ is non-increasing in $T$.
- Cap branch: $IM=(1+u)xw\ge MM+uxw$, since $MM\le xw$.
- Otherwise: $IM\ge x(J(T-T_g)+e+uw)\ge x(J(T)+e)+uxw\ge MM+uxw$.

**Final tier ($T\le T_3$).** With $J=1$, $MM=IM=W$, so by §3.4 an account is healthy iff $C\ge x\,w(p_0)$ (INV-1).

**Why $IM$ may exceed $W$ before the final tier.** The headroom $u\,x\,w$ lets a fully collateralised position pay funding for $T_{\min}$ without becoming liquidatable (§6). It is also why $L_{\max}<1$ is possible (long at 0.05: 0.95x). The UI must show this as "no leverage available", not "0.95x".

### 4.3 Justifying the tiers from §2.2

Setting $k=3$, $p=\tfrac12$, $h=10$ min, the diffusion requirement at the **end** of each tier (its worst point) against the plan's $J+e$ (with $e=0.036$):

| Tier ends at $T$ | $k\phi(0)\sqrt{h/T}$ | plan $J+e$ | surplus = jump budget |
|---|---|---|---|
| 7 d | 0.038 | 0.086 | 0.048 |
| 48 h | 0.071 | 0.136 | 0.065 |
| 6 h | 0.200 | 0.236 | 0.036 |

The tiers cover diffusion everywhere, and the surplus is what's left for jumps. Diffusion alone would need full collateral only from $T^*=h\,(k\phi(0)/p)^2\approx57$ min. The plan's $T_3=6$ h adds about five hours of jump protection.

**Recommendation.** The diffusion term shrinks at the edges ($\phi(\Phi^{-1}(0.05))=0.103$) but jump size does not (§2.3). Keep $J$ absolute, but let C-1 set it per (tier, price decile), since C-1 already buckets by decile. Don't replace $J$ with the diffusion term.

### 4.4 Continuous alternative (paper only)

$$
MM^{\text{cont}}=x\,\min\Big(w,\ k\phi(z)\sqrt{h/T}+J_{\text{hazard}}+s_b+\tfrac{x}{2\rho}\Big)
$$

This removes tier cliffs but loses the announced, penalty-free step structure (Eq-8's $T_g$ look-ahead, Eq-11). Presented in the paper as the model the tiers approximate; not implemented.

---

## 5. Index, mark and manipulation

### 5.1 Index (Eq-13)

The keeper samples $m_k$, the median Kuru mid over the last 60 s of blocks, and pushes it every $\Delta_{\text{poke}}$. The chain never reads Kuru.

$$
\Delta=\min(t-t_{\text{idx}},\Delta_{\max}),\quad
I\leftarrow\operatorname{clamp}\big(I+\operatorname{clamp}(m_k-I,\pm v_{\max}\Delta),\,0.001,\,0.999\big),\quad
I_S\leftarrow I_S+\tfrac{\Delta}{\Delta+\tau_S}(I-I_S).
$$

The push also stores $m_k$ (new, §8).

### 5.2 Index lag (new analysis)

In continuous time $\dot I_S=(I-I_S)/\tau_S$. For a genuine move of size $M$, $I$ ramps at $v_{\max}$ for $t_1=M/v_{\max}$:

$$
I_S(t)=v_{\max}\big(t-\tau_S(1-e^{-t/\tau_S})\big)\quad(t\le t_1),
\qquad
M-I_S(t)=(M-I_S(t_1))\,e^{-(t-t_1)/\tau_S}\quad(t>t_1).
$$

During a sustained ramp $I_S$ trails $I$ by up to $v_{\max}\tau_S=0.30$. For $M=0.20$ (defaults $v_{\max}=0.03$/min, $\tau_S=10$ min): $t_1=6.7$ min and $I_S(t_1)=0.054$. $I_S$ covers half the move at about 10.5 min and 90% at about 27 min.

Liquidation needs both indices (Eq-10), so **the effective liquidation delay for a large genuine move is 10–27 min, not $h=10$ min.** Options:
1. Calibrate C-2 with $h\approx20$ min ($k\sigma\sqrt h$ grows by $\sqrt2$, 0.030 → 0.042).
2. Replace the EMA with a delayed copy $I_S=I(t-\Delta_c)$, which has a deterministic lag $\Delta_c$ (e.g. 5 min) and needs the same sustained push to fool.
3. Accept it and state that $J$ absorbs the excess.

**Default: option 1** (a parameter change only). Option 2 is recorded in the paper as the sharper design.

### 5.3 Mark (Eq-14)

$$
b(I)=\operatorname{clamp}(0.5\,d,\ 0.01,\ 0.05),\quad d=\min(I,1-I),
\qquad
q=\operatorname{clamp}\big(\operatorname{median}(\text{bid},\text{ask},I),\ \max(I-b,0.001),\ \min(I+b,0.999)\big).
$$

Best levels under $D_{\min}$ count as missing (bid 0, ask 1). The mark sets funding and tightens new-exposure and withdrawal checks; **liquidation never reads it.**

### 5.4 Manipulation model

Model the Kuru book as uniform depth density $D$. Moving the mid by $\Delta$ means buying $D\Delta$ units at average slippage $\Delta/2$:

$$
\text{Cost}(\Delta)\approx\tfrac12D\Delta^2\ \text{per book refill}.
$$

An attacker gains roughly $\lambda\,p\,\rho_{\text{liq}}\Delta$ from triggering liquidations, where $\lambda$ is the attacker's share of the penalty and $\rho_{\text{liq}}$ the density of liquidation thresholds near $p$. Cost is quadratic and gain linear, so **small nudges onto positions sitting at their threshold are always cheap.** The design shrinks the gain instead of trying to make every nudge expensive:

| Channel | Defence |
|---|---|
| Push the index to liquidate | 60 s median ⇒ the push must hold for most of a window; $v_{\max}$ ⇒ lag $\ge\Delta/v_{\max}$; Eq-10 needs $I$ and $I_S$; liquidation goes to the IF at $I$ (the attacker can't buy the position); keeper gets half of the 1% penalty |
| Inflate own equity, then withdraw (Mango) | withdrawals $\le C$ (no unrealised profit), checked at the worst of $\{q,I,m_k\}$ (§8) |
| Dust order steers the mark | $D_{\min}$; mark only tightens checks; funding rate set only at pushes |
| Kuru vault price | the vault's first depositor sets its price; the keeper median plus the OI cap tie exposure to measured depth (Eq-17) |
| Compromised INDEXER key | drift $\le v_{\max}$ per unit time (INV-6); divergence ⇒ ReduceOnly; $m_k$ is used only in the conservative direction |

**The leverage schedule is also a manipulation defence.** In the final tier no position can be liquidated (MM $=W$ is mark-free), so index manipulation is worthless exactly when resolution volatility makes it cheapest.

**OI cap (Eq-17).** $OI_{\max}=k_{OI}D_{\text{spot}}$ keeps $\rho_{\text{liq}}/D$ bounded, which is the only lever on the linear-gain term.

---

## 6. Funding (Eq-15, Eq-16)

With the settle-to-outcome design, funding only keeps $q$ near $I$ while $L>1$. There is no carry (holding YES earns nothing), so the fair perp price is $I$ and funding is pure premium, in **absolute** price units (relative premia blow up near 0).

$$
\lambda(d)=\operatorname{clamp}\Big(\tfrac{d_z-d}{d_z-\varepsilon},0,1\Big),\quad
g(d)=\alpha+\lambda(d)\tfrac{\beta}{\max(\varepsilon,d)},\quad
f=\operatorname{clamp}\big(g(d)(q-I),\ -\bar f_-,\ \bar f_+\big)
$$

$$
\bar f_+=\min\Big(\bar f_{\text{abs}},\tfrac{u\,q}{T_{\min}}\Big),\quad
\bar f_-=\min\Big(\bar f_{\text{abs}},\tfrac{u(1-q)}{T_{\min}}\Big).
$$

**Cap derivation.** At open, $IM-MM\ge u\,x\,w$ (INV-5), and funding drains $x f$ per hour. So the payer survives $T_{\min}$ iff $f\le u\,w/T_{\min}$; the long pays when $f>0$, hence $w=q$ for $\bar f_+$.

**Accrual.** $F\leftarrow F+f_{\text{last}}(\bar t(t)-\bar t(t_{\text{fund}}))$ on every market touch; only `pushIndex` sets a new $f_{\text{last}}$. Accounts settle $C_i\leftarrow C_i-n_i(F-F_i)$. Since $\sum n_i=0$, funding is zero-sum (INV-3).

**Freeze.** From $\tau-T_3$ every trader has $C\ge x\,w(p_0)$ with equality possible, so any payment could break full collateral. Hence $f\equiv0$ from $t_{\text{frz}}=\min(\tau-T_3,t_{\text{halt}})$, and while the index is stale.

---

## 7. Liquidation and deleverage (Eq-10 – Eq-12)

**Trigger:** $H(p)=E(p)-MM(p)$; liquidatable iff $\max(H(I),H(I_S))<0$; executed at $I$.

**Penalty:** $\varphi_{\text{eff}}=0$ if $E\ge MM_{\text{prev}}(I)$ (the tier step caused it), else $\varphi$, charged on $w(I)\Delta$.

**Size.** Transferring $\Delta$ units to the IF account at $I$ leaves $E$ unchanged (valued at $I$) and removes the penalty. Requiring IM on the remainder:

$$
E-\varphi_{\text{eff}}w(I)\Delta\ge(x-\Delta)\,i
\iff
\Delta\,(i-\varphi_{\text{eff}}w)\ge x\,i-E
\ \Rightarrow\
\Delta^*=\min\Big(x,\Big\lceil\frac{x\,i-E}{i-\varphi_{\text{eff}}w(I)}\Big\rceil\Big),
$$

with $\Delta^*=x$ if $i\le\varphi_{\text{eff}}w$. Using the pre-liquidation $i=IM/x$ over-liquidates slightly, because $e(x)$ falls as $x$ falls. That is conservative.

Vectors: $x=1000,E=167,i=0.25,\varphi_{\text{eff}}=0\Rightarrow332$. Short at $I=0.9$, $E=73$, $i=0.091$, $\varphi=0.01$: $18/0.090=200$, penalty 0.2.

**Waterfall:** penalty (50% keeper / 50% IF) → IF absorbs negative equity immediately up to its balance → remainder stays in $S_Y$ → one ratio $r$ at settlement.

**IF inventory hedge (optional).** An IF long of $x$ acquired at $I$ is exactly hedged by minting $x$ complete sets, selling $x$ YES on Kuru and holding $x$ NO. Cost $(1-I)x$, residual risk only the Kuru execution. This is possible only because markets are native.

---

## 8. Withdrawals (changed)

$$
\text{withdraw}\le\min\Big(C,\ \min_{p\in\{q,\,I,\,m_k\}}\big(E(p)-IM^{+}(p)\big)\Big),
\qquad
\text{blocked while }\lvert I-I_S\rvert>\delta_I\text{ or }\lvert m_k-I\rvert>\delta_I.
$$

- **Including $m_k$ closes the lag hole (§5.2).** During a genuine jump, $I$ lags by up to $M/v_{\max}$. At the stale $I$ a loser still shows spare collateral, and withdrawing it turns buffer into bad debt. $m_k$ is used only in the direction that tightens the check, so a bad $m_k$ can block withdrawals but never enable one.
- **$IM^{+}$ covers resting orders:**

  $$
  IM^{+}=\max\big(IM(n+R_{\text{buy}}),\ IM(n-R_{\text{sell}})\big),
  $$

  where $R_{\text{buy}},R_{\text{sell}}$ are the account's resting sizes, kept as two account fields and updated on place, fill and cancel. Otherwise an attacker can post 32 dust orders at the touch, withdraw the collateral behind them, and make every taker burn `maxFills` on skipped orders.

---

## 9. Caps, stress and settlement

**Shortfall aggregates (Eq-18):**

$$
S_Y=\sum_i\max(0,-E_i(Y)),\quad Y\in\{0,\tfrac12,1\}.
$$

They are updated incrementally in the single account-write function (subtract the old term, add the new). A trader with $C\ge0$ contributes only at its losing outcome; a negative $C$ (the IF account) contributes to all three. New exposure on side $s$ is blocked if $S_s>\gamma\,\mathrm{IF}$.

**Settlement (Eq-19).** Once funding is settled for every open account (frzCount = openCount), Eq-3 at $q=Y$ gives $\sum_iE_i(Y)=B_m$, hence

$$
\sum_i\max(0,E_i(Y))=\sum_iE_i(Y)+\sum_i\max(0,-E_i(Y))=B_m+S_Y.
$$

With draw $=\min(S_Y,\mathrm{IF})$ and $r=(B_m+\text{draw})/(B_m+S_Y)$, $\text{claim}_i=r\max(0,E_i(Y))$ sums to exactly $B_m+\text{draw}$ (INV-4). $r=1$ iff the IF covers the shortfall. Claims are pull-based and independent of order.

**INVALID (Eq-20):** Eq-19 at $Y=\tfrac12$, matching OutcomeVault redemption of 0.5/0.5.

---

## 10. Order book

### 10.1 Price levels: bitmap, not a red-black tree

Prices are ticks $k\in\{1,\dots,999\}$ at $k/1000$. The whole key space fits in **999 bits = 4 words per side**.

- Best bid: highest set bit; best ask: lowest set bit. At most 4 SLOADs plus `LibBit.fls`/`ffs`.
- Insert or remove a level: flip one bit, i.e. one SSTORE to a word that is usually already warm and non-zero.

Solady's `RedBlackTreeLib` is the right structure for an **unbounded** key space: $O(\log n)$ descent (depth ≤ ~20 for 999 nodes) plus rotation writes on insert and delete. With a bounded, tiny key space the bitmap dominates on every operation. The tree becomes relevant only if ticks move to 1e-4 over the full range and a two-level bitmap (like Uniswap v3's tickBitmap) is rejected.

### 10.2 Within a level

- Level (1 slot): head 32 · tail 32 · size 96.
- Order (1 slot): owner id 32 · size 96 · next 32 · prev 32 · tick 16 · flags 8.

FIFO doubly linked list gives O(1) cancel from the middle via `prev`. Eager fills are required: each maker fill runs an IM check and cancels the order if the check fails, which is incompatible with lazy cumulative-fill accounting. `maxFills` (skips included) bounds gas. uint32 ids index a per-market array, so consecutive orders share a 128-slot storage page (MIP-8: 8,100 gas per cold page).

### 10.3 Latency on Monad

- 0.3 s blocks, 1 s timestamps: every Δ comes from timestamps, and Δ = 0 moves nothing.
- Makers requote via one `batch` (cancels first), with a budget of < 100k gas.
- Only per-market and per-account state is written on the hot path, so Monad's parallel execution isn't serialised. The IF is written only on liquidation and settlement.
- The mm-bot quotes around its **live** spot mid, never the lagged $I$, and pulls quotes when they diverge by more than 0.02. This stops stale-quote pick-off (X19).
- **Recorded, not built:** a one-block taker speed bump (takers execute next block; cancels immediately) would protect makers the way cancel-priority does on Hyperliquid, at the cost of taker latency.

---

## 11. Architecture

Contracts, state layout, interface, roles, lifecycle and services are as in `roadmap.md` §4. They're summarised here only for the flow.

```
Keeper ─ m_k (60 s Kuru median) ─▶ Pricing: I, I_S, m_k, q, f
Trader ─ orders ─▶ Book (bitmap + FIFO) ─ fill hooks ─▶ Clearing (Eq-2, IM at q, I; stress/OI gates)
Liquidator ─▶ Clearing.liquidate (Eq-10–12 → IF account at I)
Time + flags ─▶ Markets.stage / tier (pure view)
Oracle (CRE, 3 voters) ─▶ Resolution ─ finalize (r, draw) ─▶ Clearing.claim
OutcomeVault: 1 USDC ⇄ 1 YES + 1 NO; YES/USDC on Kuru feeds m_k
```

Stage is a pure function of time, alert/halt flags and resolution status: Open → Compression ($T\le T_1$) → ReduceOnly ($T\le T_{RO}$, alert, or divergence) → Halted ($t\ge\tau$ or halt) → Proposed → (Disputed) → Settled.

---

## 12. Changes to `roadmap.md`

| # | Change | Where | Why |
|---|---|---|---|
| 1 | `pushIndex` stores $m_k$; withdrawals checked at the worst of $\{q,I,m_k\}$ and blocked while diverged | §4.4, Eq-13 | Losers withdraw buffer during index lag (§5.2, §8) |
| 2 | Withdrawal IM includes resting orders via $R_{\text{buy}},R_{\text{sell}}$ | §4.3 account state, §4.4 | Dust-order `maxFills` griefing (§8) |
| 3 | C-2 calibrates $h$ to the two-index delay (~20 min), not 10 min | §3, §11 | The EMA's steady-state lag is $v_{\max}\tau_S$ (§5.2) |
| 4 | C-1 sets $J$ per (tier, price decile) | §3, §11 | Jump size depends on $w$ near the edges (§4.3) |
| 5 | Unit test: a 0.20 genuine jump; withdrawal during the ramp is refused | §6.3 | Covers change 1 |
| 6 | Unit test: resting orders reduce withdrawable collateral | §6.2 | Covers change 2 |

---

## 13. Limitations (paper §Discussion)

1. **Jumps are bounded, not removed:** the stress gate, IF, and ratio $r$ handle them.
2. **Compression pre-empts some winners.** C-7 measures how many.
3. **Early-resolution markets** break the time-to-resolution model. They're limited to scheduled categories (sports, macro releases, elections).
4. **Index lag trades manipulation resistance for liquidation delay** (§5.2). The trade-off can't be avoided, only moved along.
5. **Thin books early on:** $D$ is small, so OI caps are small. On testnet the Kuru mid is mostly the mm-bot.
6. **Trust:** INDEXER, MONITOR and PROPOSER keys are held by the team; the committee judges its own proposals; the LLM voters' errors are correlated (0.53–0.69).
7. **Calibration** uses one week of data, 51% sports.
8. **Funding near the edges** is capped, so convergence pressure isn't uniform there.

---

## 14. Open questions

- Delayed-copy $I_S$ (§5.2, option 2): adopt now, or leave it in the paper only?
- IF delta-hedge through the OutcomeVault + Kuru (§7): stretch, or out?
