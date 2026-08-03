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


Stack -
Node/TS for the backend service. Vite with typescript. Render + Vercel for hosting.