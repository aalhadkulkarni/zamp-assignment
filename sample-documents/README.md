# Sample documents

Two excerpts for exercising the real extraction path. Both are written in the
style of a Management's Discussion and Analysis section — prose citing the
figures rather than a table of them, which is how an ACFR actually presents
these numbers before the statements themselves.

Both are **synthetic**. The layout, labels and traps are drawn from real CalPERS
and CalSTRS reports; the figures are invented and should not be quoted as fact.

| File | Fund | Reports in |
|---|---|---|
| `calpers-2025-mda.txt` | CalPERS | thousands |
| `calstrs-2025-mda.txt` | CalSTRS | whole dollars |

## What each one is for

### `calpers-2025-mda.txt`

Upload to a **CalPERS** analysis. Every expected value is somewhere in it, but
none of it is easy:

- **Units are declared once, far away.** "All dollar amounts in the discussion
  that follows are expressed in thousands" is on page 18. The figures are on
  pages 19 and 22. Getting this wrong is a factor of a thousand.
- **Several plans, one narrative.** Every figure is given twice — once for PERF
  A, once for all plans combined. Nothing says which the analyst wants. The
  right behaviour is to pick one, say which, and say it was ambiguous.
- **Receivables have no total.** Three components are given and the text says
  explicitly that no combined line is presented. The correct answer is to leave
  it blank and say so, not to add them up.
- **The same figure twice, at two precisions.** Net position appears as
  `444,460,764` (thousands) and as "approximately $444.5 billion".
- **A concept trap.** The actuarial section gives a discount rate of 6.80% and
  an assumed rate of return of 6.80% — numerically identical, different
  concepts, and it says so. Neither is a field we want.
- **Two sections of pure noise.** Investment policy and governance contain
  percentages and no target figures at all.

Expected, in whole dollars, reading the **PERF A** column:

| | |
|---|---|
| `total_receivables` | blank — no combined line is printed |
| `total_investments` | 462,090,073,000 |
| `total_assets` | 508,215,927,000 |
| `total_liabilities` | 98,831,325,000 |
| `net_position` | 409,384,602,000 |

Reading **all plans combined** instead gives 502,073,818,000 / 551,388,204,000 /
106,927,440,000 / 444,460,764,000. Either is defensible on the text alone —
which is the point. Correcting from one to the other should produce a
`wrong_source` lesson, and that lesson should change how the next CalPERS
document is read.

### `calstrs-2025-mda.txt`

Two uses.

**Upload to a CalPERS analysis** to exercise the wrong-fund check. It names
California State Teachers' Retirement System in the first line, so the agent
should refuse to read it and say what it thinks it is.

**Upload to a CalSTRS analysis** to exercise a different shape from the same
extractor:

- reports in **whole dollars**, not thousands
- **one plan**, so no column ambiguity
- calls net position **"plan net assets held in trust for pension benefits"**,
  and says outright that it is the same concept other systems call net position
  restricted for pensions — a synonym worth learning
- **does** print a total receivables figure, unlike the CalPERS excerpt

| | |
|---|---|
| `total_receivables` | 4,882,110,447 |
| `total_investments` | 331,842,006,118 |
| `total_assets` | 349,117,552,904 |
| `total_liabilities` | 12,006,338,771 |
| `net_position` | 337,111,214,133 |

## A note on format

These are `.txt`, which the upload accepts alongside `.pdf` and `.md`. Text
files are sent inline rather than as document blocks, so they cost less and
answer faster — useful while testing the real API.

They are also a weaker test than a PDF in one respect: a real report's layout,
column alignment and page structure are part of what makes extraction hard, and
none of that survives as plain text. Use a real PDF excerpt for the honest
version of this test.
