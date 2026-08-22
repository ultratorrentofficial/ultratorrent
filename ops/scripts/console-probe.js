/*
 * UltraTorrent Console API probe — stands in for the console binary, which
 * does not exist yet.
 *
 * Runs INSIDE the backend container, because port 4000 is not published on
 * synoplex and only `node` is available in the image (no curl, no wget):
 *
 *   cat console-probe.js | ssh synoplex 'docker exec -i ultratorrent-core-backend-1 node'
 *
 * It answers the three questions a deploy of this feature raises, in order:
 *   1. Did `console.view` actually reach the database, and who holds it?
 *   2. Does the capability handshake work, and what does THIS caller get?
 *   3. Does every snapshot domain resolve, and how much does it cost?
 *
 * Read-only throughout: it mints a token, GETs twice, and writes nothing.
 */
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:4000/api';
const SECRET = process.env.JWT_ACCESS_SECRET;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** HS256 by hand — the container has no `jsonwebtoken`. */
function mint(user) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  /*
   * `permissions` here is decorative: JwtStrategy re-validates against the DB
   * and returns the user's stored grants, discarding whatever the token claims.
   * `sub` MUST therefore be a real, active user or this is a bare 401.
   */
  const body = b64({
    sub: user.id,
    username: user.username,
    roles: user.roles,
    permissions: [],
    type: 'access',
    iat: now,
    exp: now + 300,
  });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

(async () => {
  if (!SECRET) {
    console.error('JWT_ACCESS_SECRET is not in this process env — are you inside the backend container?');
    process.exit(1);
  }
  const prisma = new PrismaClient();

  // --- 1. Did the permission land, and who holds it? ----------------------
  const perm = await prisma.permission.findFirst({
    where: { key: 'console.view' },
    include: { roles: { include: { role: { select: { name: true } } } } },
  });
  console.log('\n=== console.view in the database ===');
  if (!perm) {
    console.log('  ABSENT — the manifest sync did not run, or this build predates it.');
    console.log('  Every non-SUPER_ADMIN will get 403 on /api/operations.');
  } else {
    const holders = perm.roles.map((r) => r.role.name);
    console.log(`  present; held by ${holders.length ? holders.join(', ') : 'NO ROLE (catalogued but granted to nobody)'}`);
  }

  // --- 2. Pick a caller ---------------------------------------------------
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, username: true, roles: { include: { role: { select: { name: true } } } } },
  });
  const shaped = users.map((u) => ({
    id: u.id,
    username: u.username,
    roles: u.roles.map((r) => r.role.name),
  }));
  /*
   * Prefer a NON-super-admin. SUPER_ADMIN short-circuits every permission
   * check, so probing as one shows sixteen green domains whether or not the
   * permission wiring works — which is the failure this probe exists to catch.
   */
  const caller = shaped.find((u) => !u.roles.includes('SUPER_ADMIN')) ?? shaped[0];
  if (!caller) {
    console.error('No active users; cannot probe.');
    process.exit(1);
  }
  console.log(`\n=== probing as ${caller.username} [${caller.roles.join(', ') || 'no roles'}] ===`);
  if (caller.roles.includes('SUPER_ADMIN')) {
    console.log('  NOTE: only a SUPER_ADMIN was available. It bypasses every permission');
    console.log('  check, so a green result below does NOT prove RBAC is wired up.');
  }
  const token = mint(caller);

  // --- 3. Capabilities ----------------------------------------------------
  const caps = await get('/operations/capabilities', token);
  console.log('\n=== GET /api/operations/capabilities ===');
  if (caps.status !== 200) {
    console.log(`  HTTP ${caps.status}:`, caps.body);
    console.log('  403 here means the account lacks console.view.');
  } else {
    const c = caps.body;
    console.log(`  contract ${c.contractVersion} · ${c.server.product} ${c.server.version} (${c.server.gitSha ?? 'unstamped'})`);
    console.log(`  channel: ${c.eventChannel} · cap ${c.limits.maxItemsPerDomain}/domain`);
    const missing = c.availableDomains.filter((d) => !c.permittedDomains.includes(d));
    console.log(`  permitted ${c.permittedDomains.length}/${c.availableDomains.length}`);
    if (missing.length) console.log(`  not permitted: ${missing.join(', ')}`);
  }

  // --- 4. Snapshot --------------------------------------------------------
  const snap = await get('/operations/snapshot', token);
  console.log('\n=== GET /api/operations/snapshot ===');
  if (snap.status !== 200) {
    console.log(`  HTTP ${snap.status}:`, snap.body);
  } else {
    const s = snap.body;
    console.log(`  built in ${s.durationMs}ms at ${s.generatedAt}`);
    for (const [key, d] of Object.entries(s.domains)) {
      if (d.available) {
        const n = Array.isArray(d.data) ? `${d.data.length} items` : Object.keys(d.data).slice(0, 4).join(',');
        console.log(`   OK       ${key.padEnd(15)} ${n}`);
      } else {
        console.log(`   ${String(d.reason).padEnd(8)} ${key.padEnd(15)} ${d.message ?? ''}`);
      }
    }
    const alerts = s.domains.alerts;
    if (alerts?.available && alerts.data.length) {
      console.log('\n  alerts:');
      for (const a of alerts.data) console.log(`   [${a.severity}] ${a.title}${a.detail ? ` — ${a.detail}` : ''}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
