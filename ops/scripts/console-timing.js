/*
 * Per-domain cost of an operations snapshot, measured on a real install.
 *
 * The whole-snapshot number hides which domain is expensive: collectors run
 * concurrently, so the total is the SLOWEST one, not the sum. Requesting each
 * domain on its own is the only way to see who that is.
 *
 * Read-only. Same JWT-minting approach as console-probe.js.
 */
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:4000/api';
const SECRET = process.env.JWT_ACCESS_SECRET;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(user) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: user.id, username: user.username, roles: [], permissions: [],
    type: 'access', iat: now, exp: now + 300,
  });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

(async () => {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true, username: true } });
  const token = mint(user);

  const caps = await (await fetch(`${BASE}/operations/capabilities`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();

  const rows = [];
  for (const domain of caps.permittedDomains) {
    // Three runs: the first pays for any cold cache, and reporting only that
    // would blame a domain for a cost a polling console never pays again.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const res = await fetch(`${BASE}/operations/snapshot?domains=${domain}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      runs.push({ wall: Date.now() - t0, server: body.durationMs });
    }
    rows.push({
      domain,
      first: runs[0].server,
      best: Math.min(...runs.map((r) => r.server)),
      wall: Math.min(...runs.map((r) => r.wall)),
    });
  }

  rows.sort((a, b) => b.best - a.best);
  console.log('\n  domain            first   best   wall   (ms, server-measured)');
  for (const r of rows) {
    const flag = r.best >= 250 ? '  <== dominates the snapshot' : '';
    console.log(
      `  ${r.domain.padEnd(16)} ${String(r.first).padStart(5)} ${String(r.best).padStart(6)} ${String(r.wall).padStart(6)}${flag}`,
    );
  }

  const t0 = Date.now();
  const full = await (await fetch(`${BASE}/operations/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  console.log(`\n  full snapshot: ${full.durationMs}ms server / ${Date.now() - t0}ms wall`);
  console.log(`  slowest single domain: ${rows[0].domain} @ ${rows[0].best}ms`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error('timing probe failed:', e.message);
  process.exit(1);
});
