# CLAUDE.md

Context for working on this repo. Read this before making changes.

## What this is

A take-home project for a Senior Frontend Engineer role. The brief was one of three
open-ended problem statements; I picked **"turn messy documents into structured,
queryable data."**

Evaluation is on problem framing, product thinking, UX decisions, code quality,
meaningful tests, documentation, setup experience, and — explicitly — going deep on
one hard sub-problem rather than shallow on many. Depth beats breadth.

Timeline is short (3 working days remaining). Scope accordingly.

## The product

A financial analyst is assigned a company or fund. They read its published financial
reports, find specific values, and type them into their employer's internal tool.
That data is later queried by end customers. This is real — the workflow came from
talking to someone who does the job.

We replace the typing, not the system of record.

1. Analyst uploads documents to our page.
2. We extract the values the customer's schema asks for.
3. We show the proposed data with **provenance** — what value, from where in the
   document, and why we think it's right.
4. Analyst reviews. They correct what's wrong.
5. On approval, we POST to the customer's own API. Their database stays the source
   of truth.

## The hard problem — read this twice

**Learning from corrections.** This is the centre of the project. Everything else
exists to make this demonstrable.

When the analyst edits a value, the edit tells us *what* changed but not *why*. A
value corrected from 7.00 to 6.75 could be:

- a one-off typo fix (learn nothing)
- a value read from the wrong table (learn a precedence rule)
- a units problem, e.g. thousands vs millions (learn a normalisation rule)
- a concept confusion, e.g. discount rate vs assumed rate of return (learn a
  disambiguation constraint)
- an unrecognised label for a known concept (learn a synonym)

Same gesture, very different blast radius. One affects nothing; one affects every
future document from this issuer; one affects every document from everyone.

So the agent **proposes a diagnosis and a scope**, and the human confirms or
corrects it. Nothing becomes a durable rule without confirmation. The point is that
the human ratifies a diagnosis (seconds) instead of authoring one (minutes).

**Anti-goal:** do not implement "learning" as appending correction text to a system
prompt. If every lesson type ends up as a string in one prompt, we have built one
thing with five labels. Different lesson types must be stored differently and
applied at different points in the pipeline.

## Repo state

Monorepo, npm workspaces, TypeScript throughout. Currently scaffolded with health
checks only — deployed and working end to end.

```
/apps
  /agent-web         Vite + React + TS. The review surface. Deployed on Vercel.
  /agent-api         Fastify + TS. Extraction, field definitions, lessons, LLM calls.
                     Deployed on Render.
  /customer-system   Fastify + TS. Stand-in for the customer's system of record.
                     Strict CRUD API, own database, no UI. Deployed on Render.
/e2e                 Playwright specs
decisions.md         Required deliverable. See below.
```

- Unit tests: Vitest, colocated as `*.test.ts` next to source.
- E2E: Playwright at root.
- `npm run dev` from root starts all three.
- Node 22 required (`.nvmrc`).
- Backends are ESM — import paths need the `.js` extension.

`customer-system` is deliberately a separate deployed service, not an in-process
module. The boundary must be real so that writes can genuinely be rejected —
validation failures, constraint violations, auth errors, timeouts. Handling those
rejections is in scope. Do not import types across that boundary or shortcut it with
a direct function call.

## Domain for the demo

Public pension fund ACFRs (annual comprehensive financial reports). Chosen because
they're public, genuinely messy, and report the same standardised concepts in very
different layouts across issuers — which is the variation the learning loop needs.

The system is domain-agnostic. Target schema and field definitions are per-tenant
configuration, not code.

**Documents are pre-cut**: a few pages containing the target concepts plus a few
that don't, so extraction has to discriminate rather than being handed the answer.
Full ACFRs are hundreds of pages and exceed request limits. Automatic section
location is deliberately out of scope.

## Build order

Work in vertical slices. Each step should end with something demonstrable and a
commit. Do not run ahead.

1. **Upload UI** — page with a chat panel and a document upload control. Submit does
   nothing yet except confirm receipt (list filenames and sizes).
2. **Upload endpoint** — `agent-api` accepts files plus optional prompt, persists
   them, returns 200.
3. **LLM call, no documents** — `agent-api` calls the Anthropic API with a trivial
   prompt and returns the response. Proves the integration.
4. **Display response** in the chat panel.
5. **Fixture mode** — a flag that returns a recorded response instead of calling the
   API, so development and tests don't burn tokens. Build this before real
   extraction, not after.
6. **Customer schema and API** — `customer-system` gets a data model (entity, period,
   field, value) and a write endpoint. Keep it small but make it strict: required
   fields, enum constraints, a uniqueness constraint. It should reject bad writes.
7. **Real extraction** — send document pages plus field definitions, ask for values
   with per-field provenance (source page, source text, confidence). Render as a
   table: field, value, reasoning, source.
8. **Approve and write** — POST approved values to `customer-system`. Handle
   rejection properly: surface validation errors to the analyst, don't swallow them.
9. **Edit capture** — when the analyst edits a value in the review table, capture a
   structured event: field, old value, new value.
10. **Diagnosis** — send the edit and its context to the model, get back a proposed
    lesson: type, scope, and a plain-language explanation. Display it in chat with
    accept / reject-with-comment.
11. **Lesson storage and application** — on accept, persist the lesson in a form
    appropriate to its type, and apply it on subsequent extractions. Show that a
    second document benefits from a lesson learned on the first. **This is the
    payoff — protect time for it.**
12. **Streaming** — only if time permits. Extraction takes long enough that a blank
    screen is a bad experience. Baseline (build this first, in step 7) is a clear
    loading state — "analysing your documents" with a loader — followed by the
    filled table and a short summary in chat. The upgrade is server-sent events:
    per-field results streamed as extraction completes, so the table fills row by
    row. Token-level streaming is only worth it for the diagnosis text in step 10,
    which is prose. Do not stream raw tokens into the extraction table — partial
    values aren't reviewable, and parsing incomplete JSON to render rows is a bad
    trade.
13. **Auth** — only if time permits. Firebase Auth on the frontend, token
    verification in `agent-api`. Thread a `tenantId` through from the start
    regardless, resolved from a constant for now, so the seam exists.

Chat-initiated corrections (analyst tells the agent what's wrong in words) are out
of scope — edit-triggered diagnosis is the focus.

## Tests

Meaningful, not token coverage. The most valuable ones are fixture-based:

- Given this document excerpt and these field definitions, extraction produces this
  value with this provenance.
- Given this edit, diagnosis produces a lesson of this type and scope.
- Given this lesson, a later extraction produces a different result.

Playwright covers the journey. Vitest covers the substance.

## decisions.md

Required deliverable, already started. It is a running log of real calls made while
building — the decision, the alternatives seriously considered, the reasoning
including tradeoffs accepted, and what was deliberately cut and why.

Append to it as we go. Keep it in my voice: plain, specific, no marketing language.
Do not add entries for trivial choices.

## How to work with me

- I have to defend every architectural decision in a follow-up interview round.
  When you make a non-obvious choice, say what it was and why, and name the
  alternative you rejected. If I'm accepting a framework default without
  understanding it, tell me.
- Push back if something in this file is wrong or if a step won't work as specified.
- Prefer boring, explicit code over clever abstraction. A stranger should be able to
  read it.
- Small commits with clear messages.
- Don't add dependencies without saying why.
