# AEGIS demo — design plan

Subject: a pre-signing inspection gate for agent wallets. The page is an
inspection console and an evidence record, in the vernacular of the
inspection ledger and the customs stamp: a document is presented, it is
examined stage by stage, and the outcome is stamped onto the record.
Audience: Agent Games judges and technical visitors. The page's job is
to let a visitor watch a real screening (or inspect a recorded one) and
then verify the sealed proof themselves.

The hero is the screening console itself — the most characteristic
thing in this subject's world — not a marketing banner.

## Tokens

Color — ledger neutrals; color is reserved for verdicts.

- Ledger black `#0A0B0D` — page ground (neutral near-black)
- Raised panel `#131619` — card surfaces, lifted by a 1px hairline and
  one surface step, not by shadows
- Inset well `#0E1013` — recessed areas: the preview document, data wells
- Hairline `#262B31` — every border and rule line
- Paper `#E9EBED` — primary text
- Secondary `#9BA3AB` — supporting text
- Steel `#84A9C9` — the only non-semantic accent: links, focus ring,
  active pipeline stage. Muted on purpose; it is wayfinding, not brand pop
- Verdict red `#F2706E` — BLOCK (text-safe on the panels; the stamp uses
  the same hue at display size)
- Verdict amber `#E8AC54` — WARN
- Verdict green `#63B67F` — ALLOW

Type — IBM Plex, chosen for its technical-record character (engineering
documentation, not the Inter/Geist SaaS default).

- IBM Plex Sans 400/500/600/700 — all prose, headings, labels
- IBM Plex Mono 400/500 — data only: hashes, addresses, selectors,
  field values, timestamps. Never labels.
- Scale: verdict word 44px/700 · section titles 20px/600 · body 15px ·
  small 13px · data 12.5px mono. Prose line length ≤ 72ch.

Layout — single column, max 1100px, left-aligned throughout.

- Top strip: shield mark + AEGIS wordmark + one-sentence descriptor;
  plain text links (GitHub, Policy, Circuit, Engine) at the right.
- The console (hero): one raised panel. Inside it, the three recorded
  field cases as ledger rows (radio behaviour), the preview document in
  an inset mono well, and the run row. The five-stage pipeline
  (Decode, Census, Simulate, Evaluate, Seal) is a ruled strip attached
  to the console — stages joined by a hairline, numbered because this
  content genuinely is a sequence.
- Verdict record: the stamp, then the report as ruled key-value
  ledgers — canonical fields, simulated effects — then the 30-rule
  table (scrollable sideways on narrow screens).
- Sealed proof: a record panel — status, commitment, Kurier job,
  transaction link, finalization time.
- Policy: three severity bands in ruled rows with counts and named
  example rules, then the honesty note.
- Footer: one ruled line of facts and links.

## The one bold element

The verdict stamp. An oversized verdict word inside a double-ruled
stamp frame in the verdict color, rotated −2.5°, the way an inspector's
stamp lands on a paper record. It is the only decorative object on the
page and the only animated one: at the end of a live screening, an
Anime.js timeline completes the pipeline stages, sweeps a highlight
across the fired rule rows, and slams the stamp in (scale 1.7 → 1,
420ms). Recorded reports render with the stamp already on the page —
motion is earned by a live run, never replayed for decoration.
`prefers-reduced-motion` (or a missing Anime) renders the final state
instantly.

## Principles

1. Every number on the page is real and traceable: recorded reports
   from `engine/replays/`, the sealed proof record, live chain reads.
2. Color means verdict, nothing else. Structure is hairlines and
   surface steps — no gradients, no soft shadows, no glow.
3. Honesty is rendered, not footnoted: recorded vs live is labeled on
   every report; NOT_IMPLEMENTED rules are shown, never hidden.
4. One motion moment. Nothing else animates except the progress state
   of a running screening.
5. Copy names things by what the visitor does: "Screen it live",
   "Recorded screening", "Sealed on zkVerify". No selling language.

## Review against the generic defaults (second pass)

Checked against the current AI-design clusters and template tells:

- *Near-black + single acid accent* — near-black is pinned by the
  brief; the accent here is muted steel used only for wayfinding, and
  the saturated colors are the semantic verdict colors the brief
  requires. No acid green, no vermilion pop.
- *SaaS card kit* (identical rounded cards, one radius, soft grey
  shadows, gradient washes) — rejected: no gradients, no shadows;
  radius is a small functional 6px; most content sits in ruled tables
  and ledgers, not cards. The case picker became ledger rows inside
  one panel instead of three floating cards (changed from first draft).
- *GitHub-dark clone* (the previous build: `#0d1117`, `#58a6ff`,
  pill chips) — rejected: neutral ledger black, steel accent, and
  rule status shown as colored text with a square tick in a ruled
  table, not pills.
- *All-caps eyebrow labels, `A · B · C` meta strings, `→` on links* —
  none. Section titles are sentence case with no eyebrows; links carry
  no arrows; the pipeline uses a ruled connector, not arrow glyphs.
  The stamp word is uppercase because a stamp is — it is an artifact,
  not a label.
- *Monospace label chrome* — mono is restricted to genuine data
  values; every label is Plex Sans.
- *Numbered section markers* — sections are unnumbered; only the
  pipeline stages are numbered, because they are a real sequence.
- *Headline with one accented word* — the descriptor is a plain
  sentence, no italic or colored word.
