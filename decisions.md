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

On storage: it uses SQLite, and that choice is not one I would defend for a real system of record - which is the point. This is a stand-in for a database I don't own and wouldn't be building. A customer with this problem already has Postgres or Oracle or whatever their firm standardised on years ago, with backups, replicas and a DBA. What I needed was something that enforces real constraints so a write can genuinely be refused, and SQLite does that with no dependency and no server to run.

It persists locally but not on Render, whose free tier has an ephemeral filesystem. Free Postgres would persist but expires after 30 days, which fails less honestly - someone opening this in a month would get connection errors and conclude the project is broken. Nothing in the build depends on data surviving a restart.


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


20 - Corrections are one batch, submitted together, with one entry per field.

Captured on blur, not on change. Typing 462090073000 into a box fires eleven change events and none of them are a correction - they're a person part-way through typing a number.

One entry per field, showing only where the value ended up. Change it to 100, put it back, change it to 200, and that is one correction to 200 - not three things that happened. The analyst doesn't care about their own false starts and neither does a diagnosis.

Getting that right meant rendering the pending corrections from state rather than appending a line to the chat each time one was captured. That was the actual bug: a chat log is append-only history, pending corrections are mutable current state, and putting the second inside the first is what produced three lines for one correction. So there's a draft block between the log and the composer - not history, not an action, just what you have changed and not yet submitted.

The whole set goes to the server in one call when the analyst confirms, not field by field as they work.

Why batch: corrections made together are usually one mistake seen from several angles. Five values all changed by the same factor is a single misunderstanding about units, and asked about one at a time that pattern is invisible - step 10 would find five coincidences instead of a cause. This is the open question from earlier, and I'm settling it in favour of batching. The cost is losing the tight coupling between one edit and one question about it, which I think is the cheaper thing to give up: the analyst is still in the review when they confirm, so the context is fresh either way.

They're submitted only after the customer accepted the values. Learning from a correction that was itself rejected would teach us the wrong thing.

Each event carries a snapshot of the provenance - source text, page, confidence, the model's reasoning - rather than a pointer to it. A second upload replaces the fields it came from, and an event that silently starts describing a different reading of a different document is worse than one that is merely old.

Stored as one file per batch on the server for the same reason it's sent as one: splitting them per field would throw away the only evidence that they share a cause.


21 - The diagnosis gets the corrections, their provenance, and the pages.

The Anthropic API is stateless. There is no session id and no server-side memory, so whatever the model should know has to be in the request. The question is what belongs there.

I send the corrections, the provenance we snapshotted when each was captured - the line it quoted, the page, its own stated reasoning, its confidence - the customer's field definitions, and the documents themselves.

I first built this without the documents, on the reasoning that the model had already told us what it read and why, so handing it the pages again would invite re-extraction rather than introspection. That was wrong, and the way it is wrong is worth recording.

Sort the five lesson types by what they need to be diagnosed. A units mistake needs only the two values and the quoted line - the ratio is exactly a thousand and the analyst's figure matches the printed one. A typo needs nothing, it's what's left when nothing else fits. But a value read from the wrong column can only be recognised by seeing the other columns. A concept confusion needs the other labelled lines on the page to compare against. An unrecognised label is, by definition, not in the line the model quoted.

So three of the five are blind without the page, and they're the three that produce the lessons worth having. On a CalPERS statement with six plan columns sharing one set of row labels, wrong-column is the most likely mistake there is, and provenance alone cannot see it.

The re-extraction worry was real but it is a prompt problem, not an architecture one. The prompt now says the pages are attached, that the model is not extracting again, and what to use them for: whether the analyst's figure appears elsewhere on the page, whether another line carries the label this field really means, whether the units heading says what was assumed. I had traded away three lesson types to avoid a risk that one sentence handles.

The cost is a second pass over the same pages, which is real but small next to getting the diagnosis wrong. If it matters later, prompt caching applies directly.

When the pages are gone - which on Render's ephemeral filesystem is routine - the diagnosis still runs without them. Degraded is better than failed, and the two types that survive are still worth proposing.

The lessons come back with a type and a scope, and the scope is the part that matters. Type is interesting; scope is consequential. "This applies to every document from every fund" is a much bigger claim than "this once", and it is what the analyst is really being asked to ratify - so the card states it in full rather than as a one-word tag, and the card is coloured by scope rather than by type.

The prompt pushes for the narrowest scope that fits, and says explicitly that proposing a rule for a typo is worse than proposing nothing. A wrong rule gets applied to every future document; a missing one costs one correction.

Lesson ids are assigned by us, not asked of the model. An accept has to name exactly one lesson, and a model inventing identifiers is a way to get collisions and dangling references for no benefit.

The reject comment is a textarea on the card it refutes, not the chat composer. Typed loose into the chat, a correction would have to be matched back to a proposal by guessing which one it referred to - which is the exact ambiguity this whole feature exists to remove. Same reasoning as decision 8.

A failed diagnosis does not lose the corrections. They are stored before the model is called, and a malformed or unreachable answer degrades to "recorded, but I could not work out why" rather than a 500 that would make a successful write look like a failure.

Nothing is durable yet. Accepting a lesson records the decision and nothing more - persisting it, and applying it to the next extraction, is step 11.

22 - Each lesson type is applied at a different point in the pipeline.

This is the decision the project is about, so it gets the most space.

The temptation is obvious. You have five lesson types, each with a plain-language rule attached, and you have a prompt. Concatenating the rules into the prompt takes an afternoon and demos fine. It is also one thing with five labels: the type field decorates a string that all five end up being, and nothing in the system behaves differently depending on which type was diagnosed.

What stops that is asking the diagnosis for typed data instead of prose. A units lesson now has to come back with a number - 1000, not "check whether this section is in thousands". A synonym has to come back with the label exactly as printed - "Receivables, Net" - not a sentence about it. Once a lesson is a number or a string bound to a field, it can be applied by something other than a prompt, and the five types stop being interchangeable.

Where each one goes:

A synonym attaches to the field it is a synonym for, in the output schema. Not the prompt. The next extraction sees "In this issuer's reports this has also been printed as 'Receivables, Net'" in that field's own description, and no other field is affected.

A concept confusion attaches to the same place with the opposite polarity - do not read this label for this field. Keeping the two apart matters concretely rather than tidily: flattened into one list of "notes about this field" they would contradict each other, since one says match this label and the other says avoid one.

A wrong-source rule goes into the prompt, in the document-reading instructions. It is not a fact about any one field. "Read the Total column rather than an individual plan column" is about navigating the statement, and it belongs with the other navigation guidance.

A units rule never reaches the model at all. We already do the multiplication ourselves - the model reports the printed figure and the multiplier separately, and we multiply, which was decision 17. A ratified units lesson replaces the multiplier at that point. The model is not asked again about something it already got wrong once and a human has since ruled on.

A typo does nothing. It is a case in the switch that deliberately falls through, and it is guarded twice - the SQL never returns scope 'none', and the code ignores type 'typo' regardless. This is the one I would defend hardest if pushed. A system that cannot conclude "there is nothing to learn here" turns every slip of a keyboard into a standing rule applied silently to every future document. The ability to learn nothing is what makes the other four trustworthy.

Two consequences worth stating.

The output schema changed shape to make this possible. It used to be an array of objects each carrying a key; it is now one named property per field. With an array there is literally nowhere to put a per-field instruction - `items` describes all fields identically - so a synonym could only ever have been prose. Named properties give every field its own description slot. The side benefit, which was not the motive, is that `required` now lists every field, so the model can no longer return four of five or the same field twice.

The units case overrules the model, which is the largest thing this system does on its own authority - a factor of a thousand, without asking. So it is the only one that annotates the row it changed: "Read as 1,000x; you confirmed this fund reports in 1s, so that is what was used." Applying a ratified rule invisibly would undo the point of ratifying it. The analyst agreed to a rule once; if they cannot see it acting, the next wrong value reads as the model getting worse rather than as a rule that needs revising.

What I did not build: no confidence decay, no automatic retirement of lessons that stop helping, no detection of contradictory lessons beyond newest-wins for units. All of those are real, and all of them need usage data that a three-day take-home does not have. Inventing a decay curve with no evidence would be worse than leaving the gap visible.


23 - An analysis owns its fund; the caller cannot restate it.

Found by running the loop against the live database rather than by thinking about it, which is why it is here.

Both the upload and the corrections endpoint took a fundId from the request body, and the lesson lookup used it. The fund is what decides which ratified lessons apply, so a wrong or forged value would read one fund's rules into another fund's document - the scoping guarantee that decision 22 rests on was conditional on the client being honest about a fact the server already knew.

The fund is now read from the analysis row, which fixes it at creation. A body that disagrees is a 409 rather than being silently ignored, because a client sending the wrong fund is confused about something and should be told.

Nothing about this is exotic. It is the ordinary rule that the server does not accept from a client what it can look up itself. Worth recording only because the bug was invisible in tests - the fixtures agreed with each other - and appeared the moment two funds existed at once.


24 - Past corrections go into the extraction prompt as evidence, beside the rules.

Until now the model saw a correction exactly once, at the moment it was made, and afterwards only the ratified lesson that came out of it. That is defensible - a lesson is a conclusion a human agreed to, a correction is only a thing that happened - but it throws away a category of signal.

The per-batch diagnosis can only reason about the document in front of it. The same field corrected on three separate documents is a pattern, and no single diagnosis ever had enough evidence to see it. Corrections diagnosed as typos produce no lesson at all; three typos on one field are not three typos. A rejected diagnosis leaves the correction with nothing attached, even though the correction still happened.

So the last twenty corrections for this fund now go into the extraction prompt, with the reasoning that produced each one. This does not replace anything: the typed lessons of decision 22 still go to their four separate places, and this is a fifth input alongside them, clearly marked as unratified.

The risk is value leakage, and it is worth being honest that the mitigation is weaker than the rest of the system. A list of correct-looking figures next to their field names, inside a prompt asking for figures, is an invitation to copy them forward. What stands against that is a sentence - the block says every value comes from a different document covering a different period, that the correct answers now will be different numbers, and not to carry any across. That is a prompt instruction, where the units rule beside it is arithmetic. I would rather have the structural guarantee, but there isn't one available here: the values are the informative part, so they cannot be stripped.

Two other things bound it. The list is capped at twenty, newest first, because a prompt that grows with every correction ever made stops working somewhere around the hundredth document. And an analysis never sees its own corrections - those are about the document being read right now, not a previous one.

Kept deliberately: corrections whose diagnosis the analyst rejected. A rejection means our explanation was wrong, not that the correction did not happen. The edge is real - the model may re-derive a conclusion a human turned down - but suppressing the evidence because we misread it once is worse.

What this makes plain, and what I would say in an interview: this is the weakest-typed part of the learning loop. It is prose in a prompt, which is exactly the shape decision 22 exists to avoid for lessons. It earns its place by carrying information the typed path structurally cannot - cross-document patterns, and corrections that produced no lesson at all - and it is labelled as evidence rather than as a rule so that its status is legible to the model and to anyone reading the prompt.


25 - Navigating to an analysis renders that analysis loading, not the screen you left.

A bug, found by using the thing rather than by reading it.

Starting an analysis showed the list for a second or two before the workspace appeared. It looked like a redirect, or like the click had failed and something recovered. The cause was that the workspace only rendered once the analysis had been fetched - so between creating it and holding it, the render fell through to the list at the bottom of the component. The list was not a stale frame. It was the actual fallback branch.

The fix is that "navigated to an analysis we do not hold yet" is now its own state with its own screen. The analyst asked for a specific screen; the honest answer is that screen, loading.

Two round trips are involved and they need different treatment. Creating the analysis happens before there is anything to navigate to, so the form keeps its own pending state - the button reads "Starting…" and is disabled, because an enabled button that appears to do nothing invites a second click and a second analysis. Fetching it happens after, so navigation is immediate and the workspace shows the loading state itself. Waiting for the fetch before switching screens would have left the analyst on a form whose button had stopped responding.

A failure in the first case keeps them on the form with the reason, rather than dropping them back to the list having lost the fund they picked.

On the list itself: it now says it is fetching before it claims there is nothing. An empty list and a list not yet loaded look identical, and "No analyses yet" is a statement about what the server said, which we cannot make before it has said anything. The New analysis button stays enabled throughout, because starting one does not depend on knowing about the others.

The spinner is CSS rather than an animated image. It inherits the current colour, costs no request, and stops when the page stops - an animated GIF keeps spinning through a frozen tab, which is the one moment a spinner most needs to be telling the truth. It honours prefers-reduced-motion by pulsing instead.

Refreshing the list after an action deliberately has no spinner. The analyst has already been given feedback for what they did, and flipping the list into a loading state behind them would be movement without information.


26 - The upload is accepted, not completed. The result arrives over SSE.

The upload handler used to persist the documents, call the model, write the results and only then answer. So the browser held a request open for the length of a model call - thirty to sixty seconds - with the send button reading "Sending…" and nothing else on screen. The analyst had no way to tell a slow extraction from a broken one.

The split is the whole point, and it is independent of transport. POST /analyses/:id/documents now validates, stores the documents, records the analyst's own message, claims the analysis for an extraction, and returns 202. Everything slow happens after, on its own, and ends by announcing that the analysis changed.

The acknowledgement comes after persisting rather than before it. Persisting is milliseconds, and it is the step that can legitimately refuse you - a file too large, a type we do not accept, more documents than the limit. Those are already clean 400s with a reason per file. Acking first would turn every one of them into an error arriving asynchronously, seconds later, on a message the analyst had already been told was accepted. Ten milliseconds buys keeping all the rejection paths as ordinary request failures.

SSE rather than WebSockets. The traffic is entirely one way - the server tells the browser something changed, and the browser never sends anything back on the channel. EventSource brings reconnection with it, so a dropped connection re-establishes itself and the next change still lands. A socket would have added an upgrade handshake, a heartbeat scheme, and a reconnect loop of our own writing, to buy a direction we do not send in. The one real argument for WebSockets is a client that needs to talk mid-stream - cancel an extraction, or chat while waiting - and chat-initiated corrections are explicitly out of scope. If that changes, the transport changes; nothing else here would.

Polling was the other option, and it is genuinely close. It needs no new transport and no notification plumbing at all. I did not take it because a poll interval is a choice between latency and load with no good answer - one second is a request per second per open tab for a minute, five seconds means a result that has been ready for four of them.

The notification goes through Postgres LISTEN/NOTIFY rather than an in-process emitter. The browser's event stream and the extraction it is waiting on are separate requests, and nothing makes them land on the same process. An in-memory bus would drop the notification whenever they did not - and would reintroduce exactly the single-instance ceiling that was the argument for choosing Postgres over SQLite in decision 20. Having made that argument, building something that quietly depends on one instance would have been dishonest.

The event carries no payload beyond an analysis id. The client re-reads the analysis it already knows how to fetch, so there is one description of an analysis rather than two that can drift apart, and adding a field to the server needs no change in the notification.

Failure has to travel the same road as success. The browser is waiting on an event, not a response, so an extraction that fails without announcing itself leaves a spinner turning over work that stopped a minute ago. Nothing in the runner throws: every outcome, including one nobody predicted, is recorded on the analysis and announced. Extractions running when the process dies are marked failed at the next boot, because that is the only moment we can be certain nothing we started is still going.

One extraction at a time per analysis, claimed with a conditional UPDATE rather than a read followed by a write, so two uploads arriving together cannot both proceed. The composer says so rather than letting the analyst discover it from a 409.

Two things this cost. Extraction state is a new axis on the analysis - an analysis is a draft whether or not the agent happens to be reading for it, so folding this into status would have meant a crash could leave one permanently in a state it cannot leave. And the tests cannot exercise LISTEN/NOTIFY at all: pg-mem does not parse either statement, so the suite swaps in an in-process emitter the same way it swaps in a pool. Everything either side of the notification is tested; the notification itself is only ever proven against real Postgres, which I did by hand.


27 - Writing to reply.raw discards every header Fastify staged.

A bug worth recording because the tests could not have caught it and the browser gave no error.

The SSE handler writes its headers with reply.raw.writeHead, which goes straight to the Node response and ignores whatever has been set on the Fastify reply - including the CORS headers @fastify/cors adds in a hook. The stream opened, sent its events, and the browser silently discarded all of them, because the response had no Access-Control-Allow-Origin.

Nothing in the suite noticed: the tests read the stream with same-origin fetch from Node, which does not need CORS. Only a browser hitting a different port does, which is every real deployment - agent-web on Vercel, agent-api on Render.

The fix is to spread the headers Fastify already staged into the writeHead call rather than replacing them. Found by opening the page.


28 - Confirm and write does two things. Only the slow one was deferred.

The same button covered a call to the customer's system and a model call, and it waited for both. Splitting it needed a decision about which half to defer, and the answer is not "both".

The write stays synchronous. It is sub-second, and it is the one operation here that can be refused - a missing required field, a value their schema will not take, a period that collides with a report they already hold. Those come back as per-field problems the analyst has to see and fix before anything else makes sense. Deferring it would mean releasing the button, saying nothing, and then retracting a write the analyst had every reason to believe had gone through.

The diagnosis is deferred. It is a model call, it happens after the write has already been confirmed, and nothing about it changes what the analyst does next unless they choose to ratify something. So the corrections are stored, the request returns 202, and the proposal arrives on the same event stream the extraction uses.

Measured in a browser: the button releases 4.3 seconds after the click, having confirmed the write, and the proposal lands ten seconds later. Before this the button held for the whole of both.

Extraction state and diagnosis state are separate columns rather than one "the agent is busy" flag. They start at different moments, fail independently, and an analysis can plausibly be having a new document read while an older batch of corrections is still being explained. One flag would have had to pick which of those to describe.

The failure path matters more here than for extraction, because the corrections are already stored and the write already succeeded. An explanation that fails is not a lost correction - it is a missing sentence about a correction that is safely recorded, and the message says exactly that.


29 - What the analyst changed is part of the conversation.

The corrections were rendered from browser state while they were being made, and nothing recorded them once they were sent. So the moment an analyst confirmed, the draft block disappeared and the agent's explanation arrived with nothing above it saying what had been changed. The one message that most needs its subject stated was the one without it.

Submitting corrections now appends an analyst message the same way uploading documents does, and it survives a refresh for the same reason.

Stored structurally - field, from, to - rather than written into the message body as prose. The browser already formats a value in the review table, and having the server write "$462,090,073,000" into a string would put currency formatting in two places that would eventually disagree. It also keeps the record honest about what was typed: a value that is not a number is shown as entered rather than dressed up as money.

One message for the batch, not one per field, for the same reason the batch is diagnosed together. Six values changed by the same factor is one thing that happened.

The same evidence is on the lesson card itself, not only in the conversation. The card listed the fields a lesson was about but not what had happened to them, which asked the analyst to agree to a standing rule while going somewhere else to check what it was about. The corrections are attached to the lesson on the server rather than correlated in the browser, matched on the batch as well as the field - the same field can be corrected twice, and a lesson belongs to exactly one of those batches.

The formatter is shared between the table, the conversation and the card. The same figure rendered three ways in three places is how a UI starts looking untrustworthy.


30 - One lesson per correction, even when the cause is shared.

The diagnosis originally proposed one lesson per cause, with a list of the fields it covered. Four values all moved by a factor of a thousand became one card naming four fields, which looked like the right economy.

It is not, because a card is a single ratification. Accepting it applies the rule to all four fields at once, so an analyst who agrees about three and not the fourth has no way to say so - they can only reject the whole proposal and lose the part that was right. The economy was ours, and the cost was theirs.

So the corrections still go up in one call, because that is what lets a shared cause be seen at all. Asked one at a time the model can only find coincidences. But the proposal comes back one per corrected field, and a shared cause is reported rather than acted on: each card names the other fields it thinks moved for the same reason, and says they are decided separately.

Enforced in the schema rather than asked for in the prompt. The lessons object has one named property per corrected field, all required, additionalProperties false - so exactly one verdict per correction is a property of the contract. It also closes a gap that was there before: a correction could previously come back with no lesson at all, silently unexplained. Now a slip has to be said out loud, as type typo with scope none.

The cost is more cards and more clicks when a cause really is shared. That is the trade being made, and it is the right way round: the analyst spends a click to keep the ability to disagree about one field.

I also got the ordering of this wrong. The grouping arrived as part of rewriting the recorded diagnosis to read its inputs, which was not what I had been asked to do, and I noted it in a commit message instead of raising it. The design change above came from being told so.


31 - A column that leaves the schema has to be dropped, not just stopped being written.

Renaming field_keys to field_key passed every test and broke immediately against the real database.

The migration is CREATE TABLE IF NOT EXISTS plus ALTER TABLE ADD COLUMN IF NOT EXISTS, which is enough for adding things and nothing else. A database created before the change still had field_keys, still NOT NULL, and no longer written to - so every insert failed.

The tests could not see it. pg-mem builds every table from the current schema, so it never has the old shape to be wrong about. Only a database with history does, which is exactly what the deployed one is.

Dropping the column explicitly fixes it. The wider point is that this migration strategy has a ceiling: it expresses additions and nothing else, and anything that removes or renames has to be written by hand and verified somewhere the old shape actually exists. That is fine at this size, and would not be for long.


32 - The agent checks whose document it is before reading it.

Nothing verified that the pages uploaded to a CalPERS analysis were CalPERS pages. The obvious cost is wrong figures written to the customer's database. The expensive one is quieter: an analyst correcting a value read from a CalSTRS statement teaches a lesson scoped to CalPERS, and that rule then applies to every future document from a fund it was never about. It is the longest-tailed mistake this system can make, and nothing stood in its way.

The extraction schema now requires a verdict on the document before any figures are asked for. Three answers, not two, and the third is the one that matters: matches, mismatch, cannot_tell.

A two-way check would have been wrong. Pension reports are hundreds of pages and the useful ones here are cut from the middle - a statement of fiduciary net position frequently carries no letterhead, no plan title and no fund name anywhere on it. Treating silence as a mismatch would refuse correct documents routinely, and a false refusal is worse than the thing it prevents: the analyst is holding exactly the right pages and is being told they are not, with no way forward. So only a positive identification of a different issuer stops anything.

On a mismatch nothing is extracted and nothing is stored. A value from the wrong fund is worse than no value, because a blank is obvious and a wrong number is not - the same reasoning as decision 12. The documents are kept, because the analyst may well be right and we should not make them pick the files again to argue.

The recorded reply always answers cannot_tell, which is the honest answer for something that has not read anything. I first had it guess from the filename so the refusal could be demonstrated without an API key, and that was a mistake worth recording: real documents are called financial_detail_4471.pdf, and code that treats a filename as evidence of which fund a document belongs to teaches the wrong thing to whoever reads it next. Whose document this is can only be decided by reading it. The mismatch path is covered by tests that stub the model's answer directly, and by real calls.

The filename is still sent to the model as the document's title, because that is ordinary metadata and a real system would send it. That means a misleadingly named file can influence the model's judgement - which is the model weighing evidence, not a rule of ours, and is the right place for it.

What is not built: overruling is a sentence in the chat that nothing acts on. Sending the same documents again produces the same refusal. The honest version is a "read them anyway" the analyst can click, and it is listed rather than built.


33 - The client re-reads when the stream opens, not only when it is told to.

An extraction completed, the database had all five values, and the browser sat on "Reading your documents" indefinitely.

The change itself is right and stands: a notification published while the event stream is down is gone, because nothing replays it. EventSource reconnects on its own, so a client listening only for `changed` can end up waiting on a message that has already been sent and missed. It now re-reads whenever the stream opens, and `open` fires again on every reconnect. Re-reading when nothing changed costs one idempotent request.

But it was not what was happening, and the first version of this entry said it was. The real cause was operational and mine: stale dev servers of my own were holding ports 3001 and 3002, so the developer's own `npm run dev` had died on EADDRINUSE without either of us reading the output, and the browser was talking to an old build with a long-dead LISTEN connection. On a single clean instance the notification arrives in under a second, which I should have established before changing any code.

Two things worth keeping from that.

I diagnosed from a plausible theory rather than from a measurement. The evidence I gathered - extraction completed, notification published, LISTEN connections alive in pg_stat_activity - was all consistent with the reconnect theory and also consistent with the true cause, and I did not look for the test that would separate them. That test took two minutes: open a stream, publish a notification by hand, see whether it arrives. It did not.

And a bug that will not reproduce on a clean environment is worth checking is not the environment. "Consistently reproducible" was what made me look harder, which is the right instinct - but only after I had already shipped a fix for it.
