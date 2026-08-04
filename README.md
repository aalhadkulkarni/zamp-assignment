# Turning published financial reports into structured, queryable data

A financial analyst is assigned a pension fund. They read its published annual
report, find the values their firm's schema asks for, and type them into an
internal tool. That data is later queried by customers. This replaces the typing
— not the system of record.

1. The analyst uploads pages from the fund's report.
2. The agent extracts the values the customer's schema asks for.
3. Every value arrives with **provenance**: the line it came from, the page, and
   why the agent believes it.
4. The analyst reviews and corrects what is wrong.
5. On approval the values are written to the **customer's own API**. Their
   database stays the source of truth.

---

## The part worth reading the code for

**Learning from corrections.** When an analyst changes a value, the edit says
*what* changed but not *why*. A figure corrected from 7.00 to 6.75 might be a
typo, a value read from the wrong column, a units mistake, two concepts confused,
or a label nobody recognised. Same gesture; wildly different consequences. One
affects nothing. One affects every future document from that issuer.

So the agent **proposes a diagnosis and a scope**, and the analyst confirms or
corrects it. Nothing becomes a durable rule without a human ratifying it. The
point is that ratifying a diagnosis takes seconds where authoring one takes
minutes.

The trap here is implementing "learning" as appending correction text to a
prompt — five labels on one mechanism. So each lesson type is **stored as typed
data and applied at a different point in the pipeline**:

| Lesson | Stored as | Applied |
|---|---|---|
| `typo` | the record only | **nowhere**, on purpose |
| `synonym` | the exact printed label | the **output schema**, on that field |
| `concept_confusion` | the same, negated | the same slot, opposite polarity |
| `wrong_source` | prose | the **prompt**'s document-reading section |
| `units` | a **number** | **post-processing arithmetic** — the model never sees it |

Asking the diagnosis for a *number* when it says "units" is what makes this real:
a units lesson becomes arithmetic we perform, not a sentence we hope is honoured.
And `typo` doing nothing is deliberate — a system that cannot conclude "there is
nothing to learn here" turns every slip of a keyboard into a standing rule.

Start with [`apps/agent-api/src/lessons.ts`](apps/agent-api/src/lessons.ts).

---

## Running it

Node 22 (`.nvmrc`). No database, no API key, nothing to provision:

```bash
npm install
npm run dev
```

Open http://localhost:5173.

That gets you the whole product on recorded model replies and an in-memory
Postgres — the real schema and the real SQL, kept nowhere. It says so loudly at
startup. Enough to click through upload → review → correct → write → diagnose →
ratify, and to see a second document benefit from a lesson learned on the first.

### With real model calls

```bash
cp apps/agent-api/.env.example apps/agent-api/.env
```

Then set `ANTHROPIC_API_KEY` and `USE_FIXTURES=false`. Add a `DATABASE_URL`
pointing at any Postgres if you want analyses to survive a restart.

### Tests

```bash
npm test        # 229 unit and integration tests
npm run typecheck
npm run e2e     # Playwright, needs the dev servers running
```

The valuable ones are fixture-based and live in
[`apps/agent-api/src/`](apps/agent-api/src/): given this document and these field
definitions, extraction produces this value with this provenance; given this
edit, diagnosis produces a lesson of this type and scope; given this lesson, a
later extraction produces a different result.

---

## Deployed

| | |
|---|---|
| Review surface | _add Vercel URL_ |
| Agent API | _add Render URL_ |
| Customer system | _add Render URL_ |

---

## Layout

```
apps/agent-web         Vite + React + TS. The review surface.
apps/agent-api         Fastify. Extraction, diagnosis, lessons, model calls.
apps/customer-system   Fastify. Stand-in for the customer's system of record.
e2e                    Playwright
decisions.md           Every non-obvious call, and what was rejected
EdgeCases.md           What this does not handle yet, and what it costs
```

`customer-system` is a separately deployed service with its own database, not an
in-process module. The boundary is real so that writes can genuinely be refused —
validation failures, uniqueness collisions, timeouts — and handling those
refusals is part of the work. No types are imported across it.

---

## How it behaves

**Uploads return before the work is done.** Reading a document is a model call
taking tens of seconds. The upload persists the files, records what the analyst
sent, and returns `202`; the result arrives over server-sent events. Same for the
diagnosis — but *not* for the write, which is fast and is the one operation that
can be refused with per-field errors the analyst has to see.

**Notifications go through Postgres `LISTEN/NOTIFY`**, not an in-process emitter.
The browser's event stream and the extraction it waits on need not be handled by
the same instance.

**Failure travels the same road as success.** Nothing in the background runners
throws; every outcome is recorded on the analysis and announced, or a spinner
turns forever. Work orphaned by a restart is marked failed at the next boot.

**The analyst is never surprised by a rule they agreed to.** A ratified units
lesson can change a value by a factor of a thousand, so the row says so.

---

## Documents

Public pension fund ACFRs — genuinely messy, and they report the same
standardised concepts in very different layouts across issuers, which is the
variation the learning loop needs. Pages are **pre-cut**: a few containing the
target concepts and a few that do not, so extraction has to discriminate rather
than being handed the answer. Locating the right section in a 300-page report is
deliberately out of scope.

The system is domain-agnostic. The target schema and field definitions are
per-tenant configuration fetched from the customer's API, not code.

---

## Deliberately not built

Named here rather than left to be discovered:

- **Authentication.** `tenantId` is threaded through everything and resolved from
  a constant, so the seam exists.
- **Chat-driven corrections.** Edit-triggered diagnosis is the focus; correcting
  the agent in prose reintroduces exactly the ambiguity this design removes.
- **Automatic section location** in a full report.
- **Viewing or revoking accepted lessons**, which is the honest gap in the
  learning loop — see [EdgeCases.md](EdgeCases.md) §5.

[EdgeCases.md](EdgeCases.md) is the fuller survey: what happens today, what
should, and which six would be worth the next day's work.
