Problem selection - Problem 3
Why - It's a genuine business problem, where companies may want to automate some of their analytics work using AI. It's a difficult problem, where not only does AI need to read the unstructured text from many different sources, but it needs to understand exactly what the user needs from this unstructured data. It also needs to learn from the mistakes it does - this is where a human comes into picture where the human reviews the AI works and corrects it.
So this problem has multiple difficult sub problems that need solving, and genuine work on front end side.

Problem scope and assumptions -
1 - We will assume the AI needs to analyse multiple documents, and extract necessary values from it, and map them into an existing data model.
Why -
Any company with enough of this pain to buy a solution already has a system of record and a manual workflow filling it. The data is already being queried by downstream consumers, and those queries run against the customer's schema, not ours. A tool that produces structured data somewhere else is therefore not usable — it creates a second source of truth and a migration problem, which is a worse position than the manual process it replaced. So the target schema is a given, and the extraction problem is constrained by it: the agent is not deciding what fields should exist, it is deciding which values in a messy document correspond to fields that already do.

Real world justification for this - I have talked to a financial analyst and understood how their workflow. What I learnt is, they are assigned a company to analyse. They access the publicly available financial records of the company, analyse them, and enter relevant data into their internal tool. This data is used to provide insights to the customers. This sounds like exactly the problem that problem 3 describes. An existing internal tool and internal database, which a human fills based on a messy input. And the data they enter is searchable and queryable by the end customers.

Deliberately cut: schema inference for customers without an existing data model. It's a real need for greenfield users, but it changes the problem from mapping to modelling, and mapping is the case that matches how this work is actually done today.



2 — The customer exposes an API. We call it.

We give the customer our own page. They upload documents there, we show them the data we propose to enter, and they approve it or correct it. On approval, we post it to an API on their side.

This assumes an integration layer already exists between our system and theirs. That assumption is deliberate. A customer's internal system is their own, and nobody else has the same schema, so writing into it can't be handled by a prebuilt connector the way writing into a standard product like Salesforce can. It needs per-customer work: agreeing the endpoints, the field contract, and the credentials.

So I've scoped that layer out of the build and treated the write API as a given. What I haven't scoped out is the fact that it's a real boundary. In this project the customer system is a separate deployed service with its own database, its own credentials, and its own validation, so a write can actually be rejected. Handling those rejections is in scope.

Alternatives considered

2a - Give the customer a code snippet to embed in their own page.
They insert a script tag into their existing data entry page, which opens our agent in a side panel. The agent reads the DOM to work out the form, and fills the fields directly instead of calling an API.

Rejected on reliability. Every customer's page is different, and any page can change without warning. A renamed class or a reordered form breaks it silently, and the failure shows up as wrong data rather than an error.

The bigger cost is to the learning loop in decision 3, which depends on knowing exactly what the human edited. On our own page we own the components, so an edit tells us the field, the old value, the new value, and lets us ask about it there and then. On a page we don't control, the same edit arrives as a DOM mutation with no field identity we can trust. That's a worse version of a signal we can get natively, in exchange for brittleness.

The distribution advantage is real. The analyst never has to leave the tool they already use. If the AI learning loop weren't the centre of this project, then this alternative could have been better.

2b - We expose an API, the customer fetches from us.
Rejected. This means the data lives in our system and the customer has to pull it across every time. That's an extra step and a second source of truth. Once the human has approved the data, there's no reason it shouldn't go straight into the system that already owns it.


3 - Correcting the agent -
There can be 2 ways of correcting the agent
3a - after the data parsing, human can manually update the data in our data entry page. The agent can watch the changes, and for every change, infer why this change was made. It will post the findings in the chat, and huaman can confirm the agent's understanding, or explain if it was incorrect
3b - human uses the chat to tell the agent what is wrong. It may or may not tell why it is wrong. Agent makes the modifications, and the whole process can repeat until human approves the changes.
In a real acceptable production system, both these modes need to be supported. We cannot make a choice between one of them. We cannot put a restriction that the human can only do updates through agent chat - in case of minor fixes, this will waste valuable time and token cost. And we also cannot put restriction that the human can only do updates in the page, and never through agent chat - if the fixes needed are major, then it's lot of manual work for the human, which is exactly what we want to avoid by creating this system.
But for the 5-day project, I will focus on the mode 3a, where the human makes manual edits, and agent has to watch and infer why an edit was made, and update its learning.
Why - because this is a genuinely interesting and difficult problem where the agent has to passively learn something without human explicitly teling it. Not only the agent needs to learn what was fixed, but it needs to figure out the "why"

4 - Specific use case for the demo - Public pension fund ACFRs 
Why -
As mentioned above in assumption 1, I have a real world use case where I talked to an actual employee who works on this problem. The system is domain-agnostic. The target schema and field definitions are per-tenant configuration, not code. For the demo I've used public pension fund ACFRs as the use case, because they're publicly available, genuinely messy, and report the same standardised concepts in materially different layouts across issuers, which is exactly the kind of variation the learning loop needs to be tested against.


5 - The analyst picks the fund before uploading anything.

The flow is: landing page listing existing analyses, start a new one, pick a fund from a dropdown, then land on a page that asks for documents. The fund is chosen by the human, not inferred from the documents.

Why - the fund is the entity the values get written against in the customer's system. Getting it wrong means correct values written to the wrong record, which is worse than a failed extraction because nothing looks broken. It's also honest to the workflow: the analyst is assigned a fund, so they already know it. Asking the model to infer something the human already knows for certain is spending accuracy for nothing.

Picking the fund first also means we know which schema applies before any extraction runs, so the field definitions are available at the point we need them.

Alternative considered - open on a chat box and let the analyst say what they want in text. Rejected because the task is already known at that point. A blank prompt asks the analyst to invent an instruction they don't have, and it frames the product as a chatbot rather than a document-to-data tool. The text box is still there, below the upload control, but as somewhere to add context ("figures are in thousands", "use the table on page 4") rather than as the way in.

Deliberately cut for now - reopening an analysis that has already been approved and written. Resuming a draft is a read of state we already hold. Editing an approved one means a second write path against customer-system, updating rows that its uniqueness constraint is there to protect. That's a real feature but it's not on the path to the learning loop, so approved analyses are read-only.


6 - No router.

There are two screens and a workspace, and view state is held in App. React Router would be the reflex here and I didn't add it.

Why - it earns its place when URLs need to be shareable or bookmarkable. Analyses are currently in memory in the browser, so there is nothing stable to link to. When they move to agent-api and get real ids, a URL per analysis becomes worth having, and that's the point to add it.


7 - Accepted file types: pdf, txt, md.

Cut .doc and .docx. They're binary, they need a parser dependency and a conversion step, and the model API won't take them directly the way it takes PDFs. Every document in the demo domain is a PDF, so supporting them would be work against a case that doesn't occur here.

Files are validated by extension rather than MIME type, because browsers disagree about the type of a .md file - some report an empty string.

Validation happens in the browser when the file is picked, and it's synchronous, so a staged file is either ready or rejected with a reason. There's no progress state to show, and inventing one would be theatre. The actual upload to the backend is a single request for all files, so there's nothing per-file to report there either.


8 - Every message must carry at least one document. There is no free-text chat.

The send button stays disabled until a usable document is staged. You can type into the message box on its own, but you can't send on its own, and when you try the UI says why: attach a document to send.

Why - this falls straight out of decision 3. I chose 3a, where the analyst corrects values by editing them in the table and the agent infers the reason. I put 3b, where the analyst tells the agent what's wrong in words, out of scope. A free-text message box that sends is 3b. If I shipped one, the analyst would use it - it's the obvious thing to do when there's a text box and a send button - and every message would land on a system with nothing to do with it. Better to not offer the action than to accept it and drop it.

So the text box is scoped down to what 3a actually needs: context that travels with the documents. Which table to use, that figures are in thousands, that the fund changed actuary that year. It's an argument to the upload, not a channel of its own.

This also means adding documents later is a first-class thing, not an edge case. The analyst can come back to a draft, attach more documents with more context, and send again. That is the only way to say something to the agent, which is deliberate.

Where this loosens - step 10, rejecting a hypothesis. When the agent proposes a reason for an edit and the analyst says it's wrong, the correction is prose and there's no document attached to it. That input belongs on the hypothesis itself, not in a general message box, so that the explanation is structurally tied to the hypothesis it refutes. Working out which hypothesis a loose message referred to is the same guessing problem this project exists to avoid, and I'm not going to reintroduce it in the chrome.


9 - The browser's file checks are for the analyst. The server's are the real ones.

Both sides check the same three things - extension, size, not empty - and the duplication is deliberate. The browser copy exists so the analyst finds out immediately, in the composer, next to the file. The server copy exists because anything can post to that endpoint and the browser rules are advice, not enforcement. I didn't factor them into a shared package. Two short lists that happen to agree today is a smaller problem than a shared package that makes the server's rules feel like a formality.

The server also rejects the whole upload if any single document is unacceptable, rather than storing the good ones. Our UI can't produce that request - it won't let you send a file it rejected - so a mixed upload means the caller isn't our UI, and at that point storing part of what they sent is guessing at what they wanted.

Added @fastify/multipart for parsing. Multipart is not something to hand-roll: boundary parsing, streaming, and per-file limits are exactly where a naive implementation goes wrong. The alternative was base64 in a JSON body, which inflates the payload by a third and buffers every file in memory before any of it can be checked. The plugin enforces the size and count limits during parsing, so an oversized upload is cut off rather than fully received and then refused.

The analysis id is in the URL and lands in a filesystem path, so it has to be a uuid or the request is refused outright. Uploaded filenames are stripped to their basename before they touch disk, and the bytes are written under a generated id with the original name only as a label. A file called ../../etc/passwd.pdf stores fine and stores harmlessly.


10 - Documents go to local disk, and that is not the final answer.

Files are written under DATA_DIR/tenant/analysis, with a manifest json per upload recording the prompt and what was stored. The manifest is written after the documents, so a directory with a manifest is known to be complete.

On Render this disk is ephemeral - a redeploy or a restart wipes it. I'm accepting that for now because documents are input to an extraction that runs immediately after upload, not a record anyone is relying on us to keep. What has to survive is the lessons, and those aren't files.

Where it breaks: resuming an old analysis after a restart. When that matters this becomes object storage, and only the storage module changes, because nothing above it knows where the bytes are.

Deliberately not built: a storage interface with a filesystem implementation behind it. There's one implementation and one caller. An interface here would be design for a second implementation that doesn't exist yet.


11 - tenantId is threaded through now, resolved from a constant.

There's no auth, so resolveTenant returns a fixed string. Every stored path already includes it.

Why now rather than when auth arrives - because retrofitting a tenant into storage paths means migrating data that's already on disk in the wrong shape. Doing it now costs one function and one path segment. Adding auth later means changing resolveTenant and nothing else.


12 - The API key lives in agent-api and nowhere else.

The browser never talks to Anthropic. It talks to agent-api, and agent-api talks to Anthropic.

Why - a key in the frontend is a published key. Anything the bundle contains, a visitor can read; Vite compiles VITE_ variables into the JavaScript it serves, so there is no version of "put it in the frontend carefully" that works. This is most of the reason agent-api exists as a service rather than the page calling Anthropic directly.

Locally the key sits in apps/agent-api/.env, which is gitignored. On Render it's an environment variable in the dashboard. There's a committed .env.example showing the names and no values.

No dotenv dependency. Node 22 reads .env itself via process.loadEnvFile, and index.ts calls it inside a try/catch - in production the file doesn't exist because the platform supplies the environment directly.

A missing key doesn't stop the service from starting. It logs a warning and /llm/* returns 503 saying exactly which variable is unset. Uploads don't need a key and keep working. I went back and forth on this - crashing at startup surfaces a misconfiguration immediately, which is the usual argument. But a service that won't boot tells you less than one that boots and names the missing variable, and it takes working functionality down with it.


13 - Model choice and settings for the connectivity check.

claude-opus-5, thinking disabled, effort low, 256 max tokens.

Why - this endpoint sends a fixed trivial prompt and expects a fixed trivial answer. Its only job is to prove the integration works before anything depends on it. Paying for reasoning on "reply with pong" proves nothing the cheap version doesn't. Extraction in step 7 will want the opposite settings, and that's a separate call site.

Not added here: server-side refusal fallbacks. They exist so a request the model declines gets retried on another model, which matters for real document content and not at all for a hardcoded ping. It goes in with extraction, where a refusal is a plausible outcome.

Refusals are handled even so, because they aren't errors. A declined request returns HTTP 200 with an empty response body and stop_reason "refusal". Code that reads the first content block without checking gets an empty string and reports success. So the check is explicit, and the route returns 422 rather than folding it into a generic 502 - the call worked, the model declined, and those are different things to debug.

The route separates upstream failures too. A rejected key is 502, not 401 - our credential is broken, not the caller's, and returning 401 would tell an analyst to log in again when the problem is on our side.


14 - Fixture mode is a flag, not a code change.

USE_FIXTURES=true makes the upload return a recorded reply instead of calling Anthropic. Off unless explicitly set.

Why a flag rather than swapping which function the route calls - because the same code has to behave differently in three places at once. Tests must never spend money. Local development mostly shouldn't. The deployed demo must make real calls. If the choice is a code edit then those three can't coexist, and the day someone commits the stubbed version is the day production quietly starts serving a canned answer to every customer. It fails silently, because a fixture looks exactly like a real reply.

That's also why the flag defaults to off and why an exact string match is required - USE_FIXTURES=1 does not enable it. Anything looser and a stray value flips a deployed service into serving recordings.

The recorded text is a real reply captured from claude-opus-5, not something I wrote. An invented fixture drifts from what the model actually produces, and then the UI gets tuned against prose the model never emits.

ask and askFixture have identical signatures, so the route picks between them and doesn't know which it got. That's the whole mechanism:

  const respond = usingFixtures() ? askFixture : ask;

Visible in two places, deliberately. The service logs a warning at startup, and every reply carries fixture: true through to the UI, which shows a "recorded" tag next to the agent's name. A demo that can't be distinguished from a real one is a demo I'd rather not give.

.env.example ships with USE_FIXTURES=true, so a fresh clone runs with no key and no spend. Turning it off is the deliberate act, and it's the one that costs money.


15 - What we integrate with is the customer's API, not their database.

I had started sketching customer-system as a generic (entity, period, field, value) table. That's wrong, and not just cosmetically.

customer-system is the customer's system of record. A real analytics firm doesn't keep pension data in a shapeless key-value table; they keep it in a model shaped like their business. If I invent a generic schema for them, I'm designing their database for my own convenience, which is exactly the thing decision 1 rejects. It also makes the integration story a lie: we'd be claiming to map into an existing system while quietly requiring that system to look however suits us.

So customer-system has an opinionated schema, and agent-api never sees it. What crosses the boundary is HTTP:

  GET  /funds                     which plans exist
  GET  /field-definitions         the contract we map into
  POST /funds/:id/reports         the write
  GET  /funds/:id/reports         read back

The domain-agnostic property belongs on our side, not theirs. agent-api knows nothing about pensions - it asks /field-definitions what to extract. That claim is only worth anything if the customer's schema is genuinely specific, which it now is.

The browser never calls customer-system directly. It goes through agent-api, because a real integration carries per-customer credentials and those belong server-side for the same reason the Anthropic key does.


16 - A fund is the whole retirement system, not one plan inside it.

CalPERS is one fund. Not CalPERS PERF A, CalPERS PERF B and so on.

I initially modelled it the other way. The CalPERS statement of fiduciary net position puts six plans side by side as columns on one page - PERF A, PERF B, PERF C, and the Legislators' and two Judges' funds - so "Total Investments" is six numbers on that page, not one. Making the analyst pick a plan would settle which column to read before extraction ever ran.

That's the wrong instinct, for two reasons.

It doesn't match the job. An analyst is assigned CalPERS. Nobody is assigned PERF C. And the customer wants figures for CalPERS, because that's the entity they're forming a view about.

More importantly, picking the plan up front doesn't solve the column problem, it hides it. Which column - or which combination of columns - answers "total investments for CalPERS" is a real question about a real document, and it's exactly the kind of thing the agent will get wrong in an interesting way. "You read PERF B's column, I wanted the total across the plans" is a correction with a genuine diagnosis behind it and a scope that reaches every future CalPERS document. Designing that ambiguity out of existence would have removed one of the better demonstrations of the thing this project is actually about.

So the fund list is five systems - CalPERS, CalSTRS, New York State Common, Texas TRS, Florida FRS - and the six-column page stays hard on purpose.


17 - Only the totals, stored in whole dollars.

total_receivables, total_investments, total_assets, total_liabilities, net_position.

Five fields. Reports differ enormously between funds, and mapping every line on one CalPERS page would be fitting the schema to one document. Totals are the concepts every plan reports.

They're also where the interesting variation lives. net_position appears as "Net Position Restricted for Pensions", "Plan Net Assets", "Total Fiduciary Net Position" depending on the issuer. Same concept, different label - which is the synonym problem, available for free because we only had to name the concept once.

Amounts are whole USD. The CalPERS page is headed "Dollars in Thousands", stated once, a long way from the numbers it governs - $462,090,073 there means $462 billion. Units are a property of the document, not of the data, so normalising happens before the write and the stored value is unambiguous. That also gives the units lesson somewhere real to apply.

What I deliberately did not add: a CHECK that net_position equals assets minus liabilities. It doesn't - the real identity includes deferred outflows and inflows, which we don't collect, and for PERF A the two sides differ by exactly those amounts. An invariant that is subtly wrong is worse than none.


18 - SQLite, and it will not persist on Render.

customer-system stores rows in SQLite via node:sqlite, which ships with Node 22 - no dependency. The API is marked experimental, which is why the repo pins Node 22.

Render's free web services have an ephemeral filesystem and can't attach a persistent disk, so the database file is wiped on every redeploy, restart and inactivity spin-down. Locally it persists properly.

I still chose it over the alternatives. In-memory is strictly worse - same behaviour on Render, no persistence locally, and no real constraint engine. Free Render Postgres persists but expires 30 days after creation, which is a worse failure: someone opening the repo five weeks from now gets connection errors and concludes the project is broken, when the cause is a free-tier clock. SQLite fails by starting empty, which is honest and self-explanatory. Making it durable is a paid instance with a disk, not a rewrite.

The constraints are the point, and those work either way:

  UNIQUE (fund_id, fiscal_year_end)   one statement per plan per year
  NOT NULL on every amount
  CHECK (total_assets > 0), others >= 0
  FOREIGN KEY fund_id -> fund          with PRAGMA foreign_keys ON, which SQLite leaves off

Uploading the same document twice is rejected with 409 by the customer's database, not by us. That's the rejection worth demoing: a constraint we don't own, failing a write we thought was fine.

Validation errors report every problem at once rather than one per attempt. Fixing a form field at a time, resubmitting to discover the next one, is the interaction I'd least want an analyst to have.


Stack -
Node/TS for the backend service. Vite with typescript. Render + Vercel for hosting.