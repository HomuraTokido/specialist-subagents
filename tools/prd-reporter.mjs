// A node:test reporter for tools/prd-check.mjs: one JSON line per finished test or suite, nothing else.
// prd-check parses only lines that are JSON objects with type "pass" or "fail".
export default async function* prdReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    let error = null;
    if (event.type === 'test:fail') {
      const err = data.details?.error;
      const message = err?.cause?.message ?? err?.message ?? String(err ?? '');
      error = String(message).slice(0, 300);
    }
    yield `${JSON.stringify({
      type: event.type === 'test:pass' ? 'pass' : 'fail',
      name: data.name,
      file: data.file ?? null,
      nesting: data.nesting ?? 0,
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
      error,
    })}\n`;
  }
}
