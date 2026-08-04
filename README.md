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

### What you need

**Node 22.12 or newer**, and nothing else. No Docker, no Postgres, no API key, no
account anywhere.

The version is pinned in [`.nvmrc`](.nvmrc), so with
[nvm](https://github.com/nvm-sh/nvm):

```bash
nvm use          # or: nvm install
node --version   # v22.x
```

npm ships with Node and is the only package manager used here — the lockfile is
npm's and the workspaces are npm workspaces, so yarn or pnpm will not reproduce
this install.

### Start it

```bash
npm install      # installs all three apps; npm workspaces, so one command
npm run dev      # starts all three together
```

| | |
|---|---|
| http://localhost:5173 | the review surface — **open this** |
| http://localhost:3001 | agent-api |
| http://localhost:3002 | customer-system |

`npm run dev` runs the three in one terminal with prefixed, colour-coded output.
Ctrl-C stops all of them. If a port is busy, nothing else in this project is
using it — check for an earlier run that did not exit.

That first run gives you the whole product with two substitutions, both announced
at startup:

```
DATABASE_URL is not set — running against an in-memory database.
  Everything works, and nothing survives a restart.
No ANTHROPIC_API_KEY — using recorded replies. Set one to make real calls.
```

It is enough to click through the entire loop: upload → review → correct → write
→ diagnose → ratify → watch a second document benefit from what was learned on
the first.

### Fixture mode

`USE_FIXTURES=true` returns a recorded reply instead of calling Anthropic, so
development and the test suite cost nothing and need no key.

It is not a stub that returns a fixed blob. **The recordings read their own
inputs**: the recorded extraction checks whether a ratified synonym reached the
field's schema description, and the recorded diagnosis parses the actual
corrections out of the prompt and proposes one lesson per corrected field. So a
second document improves because the lesson genuinely arrived, not because a
fixture was told to pretend — which is what makes the demo worth watching, and
what the tests assert.

A recorded reply is indistinguishable from a real one on screen, so three things
guard it:

- **off unless asked for** — the check is `USE_FIXTURES === 'true'`, an exact
  string, so `1` or `yes` or `TRUE` all leave it off
- **it announces itself at startup**, in the line above
- **every recorded message is tagged `recorded` in the UI**, so a demo cannot
  pass one off as a real call

The automatic fallback only happens when there is no API key **and**
`NODE_ENV !== 'production'`. A deployed service that lost its key fails loudly
instead of quietly serving recordings.

`FIXTURE_DELAY_MS` (default 1000) is how long a recording waits before answering.
A recording that returns instantly hides every loading state, so they never get
built. The test suite sets it to 0.

### With real model calls

```bash
cp apps/agent-api/.env.example apps/agent-api/.env
```

Then edit `apps/agent-api/.env`:

| | |
|---|---|
| `ANTHROPIC_API_KEY` | from https://console.anthropic.com/settings/keys. The API bills separately from a Claude subscription — it needs credit on the account. |
| `USE_FIXTURES` | set to `false` |
| `DATABASE_URL` | optional. Any Postgres. Without it everything works and nothing survives a restart. |

The key lives only in `agent-api` and is never sent to the browser. Nothing
prefixed `VITE_` may ever hold a secret — Vite compiles those into the served
bundle.

`.env` is gitignored. `apps/agent-web/.env.local` overrides the API URLs if you
run the services somewhere other than the default ports.

### Tests

```bash
npm run verify
```

Typecheck, then 242 unit and integration tests, then Playwright — in the order
that fails fastest. It starts and stops its own servers and forces an empty
`DATABASE_URL` and API key, so it uses the in-memory database and recorded
replies: no database is touched and no model is called. About thirty seconds,
and safe to run repeatedly.

The pieces separately, if you want them:

```bash
npm run typecheck   # types, including the test files
npm test            # unit and integration
npm run e2e         # Playwright, starts its own servers
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
| Review surface | https://zamp-assignment-agent-web.vercel.app/ |
| Agent API | https://zamp-agent-api.onrender.com |
| Customer system | https://zamp-customer-system.onrender.com |

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

Some of it is chores any product needs — authentication, a second tenant, an
admin surface, CI, cost accounting. `tenantId` is threaded through every query
and resolved from a constant, so the seam is there.

The rest is part of the problem and is what I would build next. The largest is
that there is no way to **see or revoke what has been learned**: the design rests
on nothing becoming a rule without a human confirming it, and the inverse does
not exist.

[NotBuilt.md](NotBuilt.md) is the full list, in both categories, with the
reasoning. [EdgeCases.md](EdgeCases.md) covers what happens today when something
goes wrong.
