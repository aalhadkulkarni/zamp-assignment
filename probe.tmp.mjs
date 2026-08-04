import { readFileSync } from 'node:fs';
const API = 'http://localhost:3001';
const t0 = Date.now();
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const j = async (r) => r.json();

const a = await j(await fetch(`${API}/analyses`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fundId: 'calpers' }),
}));
console.log(`analysis ${a.id}  (delete after)\n`);

const controller = new AbortController();
const stream = await fetch(`${API}/analyses/${a.id}/events`, { signal: controller.signal });
(async () => {
  const reader = stream.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break;
    for (const l of dec.decode(value, { stream: true }).split('\n'))
      if (l.startsWith('event:')) console.log(`${t()}  SSE <<< ${l.trim()}`); }
})().catch(() => {});
await new Promise(r => setTimeout(r, 300));

const text = readFileSync('sample-documents/calpers-2025-mda.txt');
const form = new FormData();
form.set('fundId', 'calpers'); form.set('prompt', '');
form.append('documents', new File([text], 'statement.txt', { type: 'text/plain' }), 'statement.txt');
await fetch(`${API}/analyses/${a.id}/documents`, { method: 'POST', body: form });
for (;;) { const s = await j(await fetch(`${API}/analyses/${a.id}`));
  if (s.extraction.state !== 'running') { console.log(`${t()}  extraction -> ${s.extraction.state}`); break; }
  await new Promise(r => setTimeout(r, 500)); }

const fields = (await j(await fetch(`${API}/analyses/${a.id}`))).fields;
console.log(`${t()}  fields: ${fields.length}`);
if (!fields.length) { controller.abort(); process.exit(0); }
const values = Object.fromEntries(fields.map(f => [f.key, f.value === null ? '1' : String(f.value)]));
console.log(`${t()}  write -> ${(await fetch(`${API}/analyses/${a.id}/report`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fundId: 'calpers', fiscalYearEnd: '2017-06-30', values }),
})).status}`);

const edits = [{ id: 'e1', fieldKey: 'total_investments', from: String(values.total_investments),
  to: '462090073000', at: new Date().toISOString(),
  context: { sourceText: 'Total investments 502,073,818', sourcePage: 1, confidence: 'high',
             reasoning: 'all-plans column' } }];
console.log(`${t()}  submitEdits -> ${(await fetch(`${API}/analyses/${a.id}/edits`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fundId: 'calpers', edits }),
})).status}`);
console.log(`${t()}  >>> THE MOMENT: client re-read says diagnosis = ${(await j(await fetch(`${API}/analyses/${a.id}`))).diagnosis.state}`);
console.log(`${t()}  ...now waiting for an SSE 'changed' that says the diagnosis finished`);

await new Promise(r => setTimeout(r, 150000));
const final = await j(await fetch(`${API}/analyses/${a.id}`));
console.log(`\n${t()}  server -> diagnosis = ${final.diagnosis.state} | lessons: ${final.lessons.length}`);
controller.abort();
