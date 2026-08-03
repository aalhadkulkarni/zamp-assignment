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


15 - We integrate against the customer's API, not their database.

customer-system is a stand-in for something we don't own. I'm building it only so the boundary is real, and its internals are not my decisions to defend - which fund names it seeds, what its tables look like, how it persists rows. What matters is the interface:

  GET  /funds                     which funds exist
  GET  /field-definitions         the contract we map into
  POST /funds/:id/reports         the write
  GET  /funds/:id/reports         read back

I started sketching it as a generic (entity, period, field, value) table and stopped, because that would have made the integration story a lie. We'd be claiming to map into a system that already exists while quietly requiring it to look however suits us - the thing decision 1 rejects. So it has an opinionated schema and agent-api never sees it.

The domain-agnostic property belongs on our side. agent-api knows nothing about pensions; it asks /field-definitions what to extract. That claim is only worth something if the customer's schema is genuinely specific.

Two things about it are deliberate rather than incidental:

It is strict enough to actually refuse us. Required fields, type checks, a range check, and a uniqueness constraint on fund plus fiscal year. Uploading the same document twice is rejected by their database, not by ours. Handling that rejection is the point; a permissive stand-in would have made the whole boundary decorative.

It stores whole dollars. The CalPERS page is headed "Dollars in Thousands", stated once, a long way from the numbers it governs - $462,090,073 there means $462 billion. Units are a property of the document, not the data, so normalising happens on our side before the write. That's our decision, and it gives the units lesson somewhere real to apply.

The browser never calls customer-system directly. It goes through agent-api, because a real integration carries per-customer credentials and those belong server-side for the same reason the Anthropic key does.

Caveat worth stating once: it uses SQLite, which persists locally but not on Render, whose free tier has an ephemeral filesystem. Free Postgres would persist but expires after 30 days, which fails less honestly - someone opening this in a month would get connection errors and conclude the project is broken. Nothing in the build depends on data surviving a restart.


16 - I did not design the hard part out of the fund list.

CalPERS is one fund. Not CalPERS PERF A, CalPERS PERF B and so on.

I had it the other way round at first. The statement of fiduciary net position puts six plans side by side as columns, so "Total Investments" is six numbers on one page, and keying the fund list on plans would have settled which column to read before extraction ever ran.

That's tempting and wrong. It doesn't match the job - an analyst is assigned CalPERS, nobody is assigned PERF C - and more importantly it doesn't solve the ambiguity, it hides it. Which column, or which combination, answers "total investments for CalPERS" is a real question about a real document. Getting it wrong produces exactly the correction this project exists to learn from: "you read PERF B's column, I wanted the total", with a diagnosis behind it and a scope that reaches every future CalPERS document.

Removing that would have removed one of the better demonstrations of the whole idea. So the fund list is five retirement systems and the six-column page stays hard on purpose.


17 - Structured outputs, not a tool.

The model has to return both prose for the chat panel and structured values for the table. My first instinct was a fill_fields tool that Claude calls with the values as arguments.

That's a tool we would never execute - borrowing the mechanism purely to force a JSON shape, and inheriting a tool-use loop we don't want. It also can't give us both halves reliably. Leave tool_choice on auto and the model may answer in prose and never call the tool, so there's no table. Force the tool and it tends to skip the prose, so there's no chat message. Either way one half goes missing, and which half is not up to us.

Structured outputs constrain the whole response to a JSON schema, which means there is no room for loose prose beside it - so the summary becomes a required field of the object. That turns the constraint into the answer: the model cannot return the values without also writing the sentence, because both are required properties of one result.

It's better than a workaround. The summary is produced by the same pass that produced the fields, so when it says "total receivables was only shown as a breakdown, so I left it blank", that is the same reasoning that put the null in the table - not a narration written separately about it. Split across a tool boundary, the two can drift.

The field keys are an enum built from the customer's own /field-definitions response. The model cannot name a field that doesn't exist, which removes an entire class of rejection before it can reach customer-system.


18 - The model reports the units. We do the multiplication.

Each extracted field comes back as valueAsPrinted and unitsMultiplier, separately, and agent-api multiplies them.

The obvious alternative is asking for the final number. I don't want that. The CalPERS page is headed "Dollars in Thousands" once, far from the figures it governs; asking the model to return 462,090,073,000 buries that judgement inside a number nobody can check. Multiplying by a thousand in its head is precisely where a units error becomes invisible.

Split, three things get better. The arithmetic is deterministic - we do it, so it cannot be wrong. The judgement is one inspectable field, and the table shows both the printed figure and the multiplier so an analyst can check the number against the page and the scaling against the heading, without opening the document.

And a units correction becomes a clean lesson. "The multiplier was wrong" is a specific, storable diagnosis with an obvious scope. "The value was wrong" leaves us inferring the factor from the difference, which is guesswork dressed up as learning.

Related: a value that isn't there comes back as null, never zero. Zero is a real figure on a financial statement - an em-dash in a column means nil and is worth recording as such. Conflating "not present" with "nil" corrupts an aggregate quietly, which is the worst way to corrupt one.


19 - A rejected write is an outcome, not an error.

The customer refusing a write is a normal part of this flow, not an exceptional one. A duplicate report, a value out of range, a field they don't recognise - all expected. So the client returns a result rather than throwing, and only a failure to reach them at all is an exception.

Their message reaches the analyst unaltered, and their per-field complaints are shown against the rows they name. I deliberately don't reword them. Their schema is what refused the write; putting our own phrasing in between would make us the apparent author of a rule we don't own, and would go stale the moment they change it.

Coercion is deliberately timid. The analyst's text is converted to a number only when that conversion is unambiguous. A money field holding "see note 7" is forwarded as that string, so their API answers "Must be a number" against that field - rather than us sending NaN, dropping it, or refusing locally. Guessing on their behalf hides a real disagreement about the data. An empty value is omitted rather than sent as null, because absent and blank are different claims and their schema decides about absent.

A rejection clears as soon as the analyst edits the field it named. Continuing to flag a value they have already fixed is worse than not flagging it.

On success the analysis becomes read-only. Their database owns those values now, and offering an edit box that writes nowhere would be a lie about where the data lives.

Deliberately deferred: the reporting period. It isn't in the extraction contract - the analyst picks it in the review footer. It's the customer's uniqueness key, so writing without it would be refused anyway and less clearly, which is why the button stays disabled until it's set. Having the model read the period off the document is the obvious next step, and it becomes another field with provenance rather than a special case.


Stack -
Node/TS for the backend service. Vite with typescript. Render + Vercel for hosting.