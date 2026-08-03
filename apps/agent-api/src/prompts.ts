/**
 * Prompts live here rather than inline in routes, because they are the part of
 * this system most likely to be edited, reviewed, and argued about.
 */

/**
 * A trivial prompt sent after an upload. The documents themselves are not sent —
 * this exists to prove the model call works end to end before extraction depends
 * on it, and to give the analyst something in the chat panel that reflects a
 * real round trip rather than a hardcoded string.
 *
 * The analyst's note is quoted rather than interpolated as instructions. It is
 * user input, and it should be treated as something to read, not obey.
 */
export function acknowledgementPrompt(filenames: string[], analystNote: string): string {
  const documents = filenames.map((name) => `- ${name}`).join('\n');
  const note = analystNote
    ? `\nThe analyst added this context, quoted verbatim:\n"""\n${analystNote}\n"""\n`
    : '';

  return `You are assisting a financial analyst who extracts values from published financial reports into their firm's system of record.

They have just uploaded ${filenames.length} ${filenames.length === 1 ? 'document' : 'documents'}:
${documents}
${note}
You have not been given the contents of these documents, and extraction is not built yet. Reply with one or two short sentences confirming what was received and saying that extraction is coming next. Do not invent any figures and do not claim to have read anything.`;
}
