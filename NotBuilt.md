# What is not built

Written down rather than left to be found. This is a take-home with a fixed
deadline, so the question was never "what would a production system have" but
"what is worth the hours available". Everything below was a decision, not an
oversight.

Two lists, because they are different kinds of missing.
[EdgeCases.md](EdgeCases.md) is a third thing again — what the system does today
when something goes wrong, rather than what it does not do at all.

---

## Part one — chores that any product needs, and this one does not have

None of these are about turning messy documents into structured data. They are
the things every serious application grows, and they were left out because none
of them would have demonstrated anything about the problem.

### Authentication

`resolveTenant` returns a constant. The seam exists deliberately — `tenantId` is
threaded through every query and every stored row, so adding auth means changing
one function rather than every path that touches storage.

Worth stating what that means for the deployment linked in the README, rather
than leaving it as a feature checkbox. That API is public and unauthenticated
right now. Anyone holding the URL can list every analysis, read the documents
inside them, write to the customer's system, and ratify a lesson that changes how
every future document from a fund is read. They can also upload documents, and
each upload is a model call billed to me — an unauthenticated endpoint that
spends money is a different class of problem from one that merely leaks, and it
is the one I would fix first.

Nothing here is sensitive: the funds are public institutions, the figures are
invented, and the database is disposable. That is why it was acceptable to
deploy in this state for a review, and it would not be acceptable for anything
else.

### More than one customer

Multi-tenancy is modelled but not exercised. Every table carries `tenant_id` and
every lookup filters on it, including the lesson query the whole learning loop
depends on. What is missing is a second tenant to prove it, and the isolation
tests that would come with one.

### An administrative surface

Funds and field definitions are seeded into `customer-system` and read over its
API. There is no screen for a customer to add a fund, change a field, or
configure where their API lives. That is a CRUD application, and building one
would have said nothing about extraction.

### Client-side validation of a corrected value

Worth stating precisely, because the current behaviour is a decision rather than
a gap. A value that will not convert — `see note 7` in a money field — is
deliberately forwarded to the customer untouched, so that *their* schema refuses
it and names the field. Guessing on their behalf, or silently dropping it, would
hide a real disagreement about the data.

What is missing is only the fast half: catching it in the browser so the analyst
learns in no time rather than after a round trip. The server must keep its
current behaviour regardless, because a browser check is a convenience and never
a guarantee.

### Continuous integration

242 tests and nothing runs them on push. A repository where the tests are green
only when someone remembers to run them is a repository whose tests will
eventually be red.

### Knowing what it is doing

There is structured logging — Fastify's, with an analysis id on every line that
matters — but looking at what it actually records is not flattering. **Every log
statement in the service is a failure.** An extraction that works writes nothing
at all. So the logs answer "what broke" and are silent on "is it working, and how
well", which is the question you have on a normal day.

Three specific things, in order of how much they annoy me:

**The token counts arrive and are thrown away.** Every model reply carries
`input_tokens` and `output_tokens`, and `anthropic.ts` reads them, puts them in
the reply object, and then nothing stores or logs them. The cost of every
extraction and every diagnosis is handed to us and dropped on the floor. That is
not "cost accounting was out of scope" — it is a number already in a variable
that needed one `INSERT`. Per analysis and per tenant, it is also the only way to
answer whether the correction history in the prompt is worth what it costs.

**Duration is derivable and never derived.** `extraction_started_at` is stored,
and the row is updated when the work finishes, so how long an extraction took is
sitting in the database as a subtraction nobody performs. "Reading your documents
usually takes under a minute" is a claim from watching it, not from measuring it.

**A failure the analyst sees cannot be found in the logs.** Fastify assigns a
request id and the browser never sees it, so an analyst saying "it broke at about
four" leaves you grepping by timestamp. Surfacing the id on the error and logging
it with the failure is small and would pay for itself the first time.

Beyond that, and genuinely out of scope for a take-home: no metrics, no tracing,
no error reporting, and no alerting on any of it.

### Data lifecycle

Uploaded documents are stored as bytes in Postgres and never removed. There is
no retention policy, no deletion, and no export — all three of which are
obligations rather than features once real financial documents are involved.

### Migrations that can do more than add

The schema is applied with `CREATE TABLE IF NOT EXISTS` and
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which cannot express a rename or a
drop. This has already bitten once, in a way the tests structurally could not
catch — see decision 31. Fine at this size; not fine for long.

---

## Part two — the ones that are part of the problem

These are what I would build next. They are ordered by what I think they are
worth, not by effort.

### 1. Seeing and revoking what has been learned

The design rests on one claim: nothing becomes a durable rule without a human
confirming it. The inverse does not exist.

There is no screen showing what the agent currently believes about a fund. An
accepted lesson applies to every future document silently and permanently, and a
`global` one applies to every fund. A lesson accepted in error — or one that was
right in 2024 and wrong in 2025, because an issuer changed how it reports — can
only be undone in the database.

This is the largest hole in the thing the project is actually about, and it is
the first thing I would fix.

### 2. The lesson lifecycle

Following from the above, and all currently absent: retiring a lesson that has
stopped helping, noticing that two accepted lessons contradict each other,
consolidating duplicates, and ranking by relevance once a fund has fifty of
them. Right now the set only grows, and both cost and quality degrade with
success.

### 3. Doing something with a rejected diagnosis

When an analyst rejects a proposal they are asked why, and the answer is stored
and then never used — not to revise the proposal, not as context for the next
diagnosis, not shown again. Today it is a decision recorded rather than a
correction applied, which undersells the most informative thing the analyst
does.

### 4. Progress while the agent is reading

An extraction takes up to a minute behind a spinner. The upload already returns
immediately and the result already arrives over server-sent events, so the
transport is in place — what is missing is anything to send during the model
call.

Streaming the response and reporting progress from it is the honest version.
Streaming partial *values* into the review table is not: a half-formed figure is
not reviewable, and parsing incomplete JSON to render rows trades correctness
for motion.

### 5. Removing a document from an analysis

An analyst who uploads the wrong file has no way to take it back, and every
later extraction keeps reading it.

Asking the agent in a message to disregard a file is a workaround rather than a
fix, and it is worth being clear why: the document is still attached to the
request, still costs tokens on every call, and the instruction competes with the
document's own contents for the model's attention. A real deletion is a small
piece of work and the correct answer.

### 6. Re-uploading, and what happens to what was already found

A second upload currently replaces the previous extraction and sends only the
new documents. Two defensible alternatives exist and neither is chosen on
evidence:

- resend every document each time, so each extraction sees the complete set —
  the best answer, and the only one where a page in the second upload can revise
  a value found in the first
- send the previous findings alongside the new document — cheaper, but the model
  then reasons about its own summary rather than the page, which is the mistake
  provenance exists to prevent

The right way to settle this is to measure it: same fund, same documents, split
by strategy, compared on how often the analyst has to correct the result.

### 7. Data that is not one value per field

Every field here is a single scalar. Real schemas want repeating structures — a
schedule of investments by asset class, contributions by employer, a figure per
period across several years. That changes extraction, the review surface, and
what a correction even means, since a correction to a row is not a correction to
a field.

### 8. Correcting the agent in conversation

Explicitly out of scope, and worth keeping out until the rest is solid. An
analyst saying "the investments figure is wrong" in prose reintroduces exactly
the ambiguity the edit-triggered design removes: which field, which value, and
on what evidence. It becomes tractable once there is a way to point at a row
while talking about it.

### 9. Knowing whether any of this is working

There is no way to tell whether the learning loop improves anything. Nothing
measures correction rate per fund over time, or whether extraction gets better
after a lesson is ratified, or whether a given lesson has ever changed an
outcome.

For a demonstration that is acceptable. For a system whose central claim is that
it learns, it is the evidence the claim rests on — and I would want it before
trusting a single automatically applied rule in front of a customer.

### 10. Verifying provenance

The quoted source line is taken on trust and never checked against the document.
Provenance is the thing the analyst is relying on when they approve a value, so
a confident wrong figure with a plausible-looking quotation is the most
expensive failure this system can produce. Checking that the quoted string
actually appears in the text is cheap and is not done.
