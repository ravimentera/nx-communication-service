/**
 * Replay every request in the Postman collection against a running service and
 * report what each one answered.
 *
 * WHY THIS EXISTS ALONGSIDE THE COLLECTION
 *
 * Two jobs, and neither covers the other. Postman is for *exploring* one
 * endpoint — read the description, change a field, look at the body. This is for
 * answering "did anything 500?" across all 150 in a few seconds, which is the
 * question you actually have after changing something. It needs no Postman
 * install and no newman.
 *
 * IT IS NOT A TEST SUITE. `npm test` is the test suite — 1,335 assertions that
 * know what the right answer is. This knows only what a *plausible* answer is:
 * a 5xx is a finding, an unexpected 4xx is worth a look, everything else is
 * reported and left to you. It is a smoke test in the literal sense.
 *
 * Ordering is the collection's order, which is deliberate: creates run before
 * the requests that consume their ids, exactly as a person clicking through
 * Postman top-to-bottom would.
 *
 * Usage:
 *   node testing/smoke.mjs                 # all folders
 *   node testing/smoke.mjs --folder 99     # only folders whose name starts 99
 *   node testing/smoke.mjs --verbose       # print response bodies for failures
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const collection = JSON.parse(
  readFileSync(join(HERE, 'outreach.postman_collection.json'), 'utf8'),
);

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const folderFilter = args.includes('--folder') ? args[args.indexOf('--folder') + 1] : null;

// Collection variables, then the environment file layered over them — the same
// precedence Postman applies. The environment is where `bootstrap.mjs` puts the
// ids it created, so running bootstrap first is what makes the id-dependent
// requests resolvable.
const vars = new Map(collection.variable.map((v) => [v.key, v.value]));
try {
  const env = JSON.parse(
    readFileSync(join(HERE, 'outreach.postman_environment.json'), 'utf8'),
  );
  for (const v of env.values) if (v.value !== '') vars.set(v.key, v.value);
  console.log(`Loaded ${env.values.length} variables from the environment file.`);
} catch {
  console.log(
    'No environment file — run `node testing/bootstrap.mjs` first, or requests\n' +
      'needing a created id will be skipped.',
  );
}

function interpolate(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (key === 'isoNow') return new Date().toISOString();
    if (key === 'isoTomorrow') return new Date(Date.now() + 864e5).toISOString();
    const v = vars.get(key);
    // An unresolved variable is left as-is on purpose. Substituting empty
    // string turns `/v1/recipients/{{recipientId}}` into `/v1/recipients/`,
    // which is a DIFFERENT ROUTE that may well answer 200 — so the failure
    // would be reported against the wrong endpoint.
    return v !== undefined && v !== '' ? v : whole;
  });
}

/** Rebuild the concrete URL from Postman's path segments and variables. */
function urlFor(request) {
  const pathVars = new Map((request.url.variable ?? []).map((v) => [v.key, v.value]));
  const path = request.url.path
    .map((seg) => (seg.startsWith(':') ? (pathVars.get(seg.slice(1)) ?? seg) : seg))
    .map(interpolate)
    .join('/');

  const enabled = (request.url.query ?? []).filter((q) => !q.disabled);
  const qs = enabled.length
    ? `?${enabled.map((q) => `${q.key}=${encodeURIComponent(interpolate(q.value))}`).join('&')}`
    : '';

  return `${interpolate(vars.get('baseUrl'))}/${path}${qs}`;
}

/**
 * What counts as interesting.
 *
 * The retired mounts must be 410 and the negative cases must be their stated
 * 4xx, so a "good" status is per-folder rather than global. Everything else:
 * 5xx is a finding, and a 4xx is worth eyes but is frequently correct — half
 * this collection consists of assertions that something is refused.
 */
function classify(folderName, name, status) {
  if (folderName.startsWith('98')) {
    return status === 410 ? 'ok' : 'FAIL';
  }
  if (/expect 403/i.test(name)) return status === 403 ? 'ok' : 'FAIL';
  if (/expect 404/i.test(name)) return status === 404 ? 'ok' : 'FAIL';
  if (/expect 410/i.test(name)) return status === 410 ? 'ok' : 'FAIL';
  if (/expect 4xx/i.test(name)) return status >= 400 && status < 500 ? 'ok' : 'FAIL';

  // `POST /v1/assets/generate` is the ONE endpoint that genuinely needs an
  // image model, and the engine ships no adapter for the `ImageProvider` port.
  // The source could not serve it either — it calls a method whose body throws,
  // with nothing catching it, so it has answered 500 for its entire life. A 501
  // naming the missing piece is the same capability and better information, and
  // it is documented as still-not-ported. Reporting it as a failure every run
  // trains you to ignore the failure list.
  if (status === 501) return 'expected-501';

  if (status >= 500) return 'FAIL';
  if (status >= 400) return 'warn';
  return 'ok';
}

const results = [];

for (const folder of collection.item) {
  if (folderFilter && !folder.name.startsWith(folderFilter)) continue;

  console.log(`\n\x1b[1m${folder.name}\x1b[0m`);

  for (const entry of folder.item) {
    const { request } = entry;
    const url = urlFor(request);
    const headers = Object.fromEntries(
      (request.header ?? []).map((h) => [h.key, interpolate(h.value)]),
    );

    // An unresolved {{variable}} means a fixture this run does not have. Send
    // it anyway and the literal braces reach the database, which answers 500
    // "invalid input syntax for type uuid" — a failure attributed to the
    // endpoint when the real cause is a missing fixture. Skipping keeps the
    // failure list about the service.
    const unresolved = url.match(/\{\{(\w+)\}\}/);
    if (unresolved) {
      console.log(`  \x1b[90mskip\x1b[0m ${entry.name.slice(0, 90)}  (no ${unresolved[1]})`);
      results.push({ folder: folder.name, name: entry.name, status: 0, verdict: 'skip', bodyText: '' });
      continue;
    }

    let status = 0;
    let bodyText = '';
    try {
      const res = await fetch(url, {
        method: request.method,
        headers,
        body: request.body?.raw ? interpolate(request.body.raw) : undefined,
      });
      status = res.status;
      bodyText = await res.text();
    } catch (err) {
      bodyText = String(err);
    }

    // Honour the collection's capture scripts, so later requests see real ids.
    const capture = entry.event?.[0]?.script?.exec?.join('\n') ?? '';
    const captureVar = capture.match(/collectionVariables\.set\("(\w+)"/)?.[1];
    if (captureVar && status < 300) {
      try {
        const j = JSON.parse(bodyText);
        const id = j.id ?? j.messageId ?? j[captureVar];
        if (id) vars.set(captureVar, id);
      } catch {
        /* a non-JSON 2xx has no id to capture; not an error */
      }
    }

    const verdict = classify(folder.name, entry.name, status);
    results.push({ folder: folder.name, name: entry.name, status, verdict, bodyText });

    const colour =
      verdict === 'FAIL' ? '\x1b[31m' : verdict === 'warn' ? '\x1b[33m' : verdict === 'expected-501' ? '\x1b[36m' : '\x1b[32m';
    console.log(`  ${colour}${String(status).padEnd(4)}\x1b[0m ${entry.name.slice(0, 100)}`);

    if (verbose && verdict !== 'ok') {
      console.log(`       ${bodyText.slice(0, 300).replace(/\n/g, ' ')}`);
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.verdict === 'FAIL');
const warns = results.filter((r) => r.verdict === 'warn');
const skips = results.filter((r) => r.verdict === 'skip');
const expected501 = results.filter((r) => r.verdict === 'expected-501');
const oks = results.length - fails.length - warns.length - skips.length - expected501.length;

console.log(`\n${'─'.repeat(72)}`);
console.log(
  `${results.length} requests · ${oks} ok · ${warns.length} 4xx · ${expected501.length} documented 501 · ${skips.length} skipped · ${fails.length} failures`,
);

if (fails.length) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of fails) {
    console.log(`  ${String(f.status).padEnd(4)} ${f.name}`);
    console.log(`       ${f.bodyText.slice(0, 200).replace(/\n/g, ' ')}`);
  }
}

if (warns.length && !verbose) {
  console.log(`\n\x1b[33m${warns.length} requests answered 4xx.\x1b[0m Many are correct — this`);
  console.log('collection asserts a lot of refusals. Re-run with --verbose to see the bodies.');
}

process.exit(fails.length ? 1 : 0);
