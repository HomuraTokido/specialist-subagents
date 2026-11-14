// The ledger module on a temp database. store.mjs reads SPECIALIST_SUBAGENTS_DB once, when it is
// first imported, so the variable is set before the dynamic import. Each loadStore gets a module URL
// query derived from its ledger path, so consolidated suites still get their own module and ledger.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './sandbox.mjs';

export async function loadStore() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-store-')));
  const file = path.join(dir, 'ledger.sqlite3');
  process.env.SPECIALIST_SUBAGENTS_DB = file;
  const storeUrl = pathToFileURL(path.join(REPO, 'src', 'store.mjs'));
  storeUrl.searchParams.set('ledger', file);
  const store = await import(storeUrl.href);
  if (path.resolve(store.dbFile()) !== file) throw new Error(`store opened ${store.dbFile()}, not the temp ledger`);
  return {
    store,
    file,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
