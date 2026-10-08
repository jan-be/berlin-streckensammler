/**
 * Smoke test of the production bundle, run in the Docker build after
 * `bun run build`: start dist/server.js the way the container does (from
 * inside dist), open a deep link and check every file its page refers to
 * comes back as what it is. A deep link once loaded "./index-….js" relative
 * to /u-bahn/, got the app's HTML back and stayed blank.
 */
import { spawn } from 'bun';
import { join } from 'path';

const dist = join(import.meta.dir, '..', 'dist');
const port = 3999;
const proc = spawn(['bun', 'server.js'], {
  cwd: dist,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: ':memory:' },
  stdout: 'inherit', stderr: 'inherit',
});
const base = `http://localhost:${port}`;
const fail = (msg: string) => { console.error(`smoke: ${msg}`); proc.kill(); process.exit(1); };

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (i > 50) fail('server did not start');
    await Bun.sleep(100);
  }
  for (const page of ['/', '/u-bahn/U6']) {
    const html = await (await fetch(base + page)).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !r.startsWith('data:'));
    if (!refs.length) fail(`${page}: no script or stylesheet`);
    for (const ref of refs) {
      const url = new URL(ref, base + page);
      const res = await fetch(url);
      const type = res.headers.get('content-type') ?? '';
      const want = ref.endsWith('.js') ? 'javascript' : ref.endsWith('.css') ? 'css' : '';
      if (!res.ok || (want && !type.includes(want))) fail(`${page}: ${ref} -> ${res.status} ${type}`);
    }
  }
  const data = await (await fetch(`${base}/api/data`)).json() as { stations: unknown[] };
  if (data.stations.length < 2000) fail(`only ${data.stations.length} stations`);
  console.log('smoke: ok');
} finally {
  proc.kill();
}
