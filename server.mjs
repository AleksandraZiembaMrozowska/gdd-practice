import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_COOKIE = 'household_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 60;
const JOIN_ATTEMPT_LIMIT = 5;
const JOIN_ATTEMPT_WINDOW_MS = 15 * 60_000;
const PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createInviteCode() {
  return randomBytes(16).toString('base64url');
}

function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      invite_code_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
      UNIQUE (household_id, slot)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS join_attempts (
      ip_hash TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS join_attempts_by_ip_and_time
      ON join_attempts (ip_hash, attempted_at);

    CREATE TABLE IF NOT EXISTS application_secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return database;
}

function loadRateLimitHashKey(database) {
  const configuredKey = process.env.RATE_LIMIT_HMAC_KEY;
  if (typeof configuredKey === 'string' && configuredKey.length >= 32) {
    return createHash('sha256').update(configuredKey).digest();
  }

  database.prepare(`
    INSERT OR IGNORE INTO application_secrets (name, value) VALUES ('rate_limit_hmac_key', ?)
  `).run(randomBytes(32).toString('base64url'));
  const stored = database.prepare(
    "SELECT value FROM application_secrets WHERE name = 'rate_limit_hmac_key'",
  ).get();
  return Buffer.from(stored.value, 'base64url');
}

function setHeaders(response, extra = {}) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  for (const [name, value] of Object.entries(extra)) response.setHeader(name, value);
}

function sendJson(response, status, body, headers = {}) {
  setHeaders(response, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function sendStatic(response, fileName, contentType) {
  const body = readFileSync(resolve(PUBLIC_DIRECTORY, fileName));
  setHeaders(response, { 'Content-Type': contentType });
  response.writeHead(200);
  response.end(body);
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  };
}

function getSessionToken(request) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=', 2);
    if (name === SESSION_COOKIE && /^[A-Za-z0-9_-]{43}$/.test(value ?? '')) return value;
  }
  return null;
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      rejectBody(Object.assign(new Error('Expected a JSON request body.'), { statusCode: 415 }));
      request.resume();
      return;
    }

    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        rejectBody(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(text.length ? JSON.parse(text) : {});
      } catch {
        rejectBody(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', rejectBody);
  });
}

function normalizeNames(names) {
  if (!Array.isArray(names) || names.length !== 2) return null;
  const normalized = names.map((name) => typeof name === 'string' ? name.normalize('NFC').trim() : '');
  if (normalized.some((name) => !name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name))) return null;
  return normalized;
}

function readProfiles(database, householdId) {
  return database.prepare(
    'SELECT id, name, slot FROM profiles WHERE household_id = ? ORDER BY slot',
  ).all(householdId).map(({ id, name, slot }) => ({ id, name, slot }));
}

function findSession(database, request) {
  const token = getSessionToken(request);
  if (!token) return null;
  return database.prepare(`
    SELECT sessions.household_id, sessions.profile_id, households.created_at
    FROM sessions
    JOIN households ON households.id = sessions.household_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(sha256(token), Date.now()) ?? null;
}

function clientIp(request) {
  if (process.env.TRUST_CF_CONNECTING_IP === 'true') {
    const forwardedIp = request.headers['cf-connecting-ip'];
    if (typeof forwardedIp === 'string' && isIP(forwardedIp.trim())) return forwardedIp.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function recordJoinAttempt(database, ipAddress, now, hashKey) {
  const ipHash = createHmac('sha256', hashKey).update(ipAddress).digest('hex');
  const windowStart = now - JOIN_ATTEMPT_WINDOW_MS;
  return withTransaction(database, () => {
    database.prepare('DELETE FROM join_attempts WHERE attempted_at <= ?').run(windowStart);
    const attempts = database.prepare(`
      SELECT attempted_at FROM join_attempts
      WHERE ip_hash = ? AND attempted_at > ?
      ORDER BY attempted_at
    `).all(ipHash, windowStart);
    if (attempts.length >= JOIN_ATTEMPT_LIMIT) {
      const waitMs = attempts[0].attempted_at + JOIN_ATTEMPT_WINDOW_MS - now;
      return Math.max(1, Math.ceil(waitMs / 1000));
    }
    database.prepare('INSERT INTO join_attempts (ip_hash, attempted_at) VALUES (?, ?)').run(ipHash, now);
    return 0;
  });
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function withTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function createHousehold(database, names) {
  const householdId = randomUUID();
  const inviteCode = createInviteCode();
  const profileIds = [randomUUID(), randomUUID()];
  const token = createSessionToken();
  const now = Date.now();

  withTransaction(database, () => {
    database.prepare(`
      INSERT INTO households (id, invite_code_hash, created_at)
      VALUES (?, ?, ?)
    `).run(householdId, sha256(inviteCode), now);
    const insertProfile = database.prepare(`
      INSERT INTO profiles (id, household_id, name, slot) VALUES (?, ?, ?, ?)
    `);
    insertProfile.run(profileIds[0], householdId, names[0], 0);
    insertProfile.run(profileIds[1], householdId, names[1], 1);
    database.prepare(`
      INSERT INTO sessions (token_hash, household_id, profile_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sha256(token), householdId, profileIds[0], now, now + SESSION_MAX_AGE_SECONDS * 1000);
  });

  return {
    inviteCode,
    token,
    household: { id: householdId },
    profiles: readProfiles(database, householdId),
  };
}

function joinHousehold(database, inviteCode) {
  if (typeof inviteCode !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(inviteCode)) return null;
  const household = database.prepare(
    'SELECT id FROM households WHERE invite_code_hash = ?',
  ).get(sha256(inviteCode));
  if (!household) return null;

  const profile = database.prepare(
    'SELECT id, name, slot FROM profiles WHERE household_id = ? AND slot = 1',
  ).get(household.id);
  if (!profile) return null;

  const token = createSessionToken();
  const now = Date.now();
  database.prepare(`
    INSERT INTO sessions (token_hash, household_id, profile_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), household.id, profile.id, now, now + SESSION_MAX_AGE_SECONDS * 1000);

  return {
    token,
    household: { id: household.id },
    profile: { id: profile.id, name: profile.name, slot: profile.slot },
    profiles: readProfiles(database, household.id),
  };
}

function jsonError(request, response, error) {
  if (response.headersSent || response.destroyed) return;
  const status = error.statusCode ?? 500;
  sendJson(response, status, {
    error: status >= 500 ? 'Wewnętrzny błąd serwera.' : error.message,
  });
}

export function createServer({ databasePath = process.env.DATABASE_PATH ?? resolve('data/households.sqlite') } = {}) {
  const database = openDatabase(resolve(databasePath));
  const rateLimitHashKey = loadRateLimitHashKey(database);
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/api/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/household')) {
        sendStatic(response, 'index.html', 'text/html; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        sendStatic(response, 'app.js', 'text/javascript; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        sendStatic(response, 'styles.css', 'text/css; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/session') {
        const session = findSession(database, request);
        if (!session) {
          sendJson(response, 200, { household: null, profile: null });
          return;
        }
        sendJson(response, 200, {
          household: { id: session.household_id, profiles: readProfiles(database, session.household_id) },
          profile: readProfiles(database, session.household_id).find(({ id }) => id === session.profile_id),
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/api/session/profile') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'Żądanie pochodzi z niedozwolonej strony.' });
          return;
        }
        const session = findSession(database, request);
        if (!session) {
          sendJson(response, 401, { error: 'Sesja wygasła. Dołącz ponownie do gospodarstwa.' });
          return;
        }
        const body = await readJson(request);
        const profileId = typeof body?.profileId === 'string' ? body.profileId : '';
        const profile = database.prepare(`
          SELECT id, name, slot FROM profiles
          WHERE id = ? AND household_id = ?
        `).get(profileId, session.household_id);
        if (!profile) {
          sendJson(response, 400, { error: 'Wybierz profil należący do tego gospodarstwa.' });
          return;
        }
        const token = getSessionToken(request);
        database.prepare('UPDATE sessions SET profile_id = ? WHERE token_hash = ?')
          .run(profile.id, sha256(token));
        sendJson(response, 200, {
          household: { id: session.household_id, profiles: readProfiles(database, session.household_id) },
          profile,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/households') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'Żądanie pochodzi z niedozwolonej strony.' });
          return;
        }
        const body = await readJson(request);
        const names = normalizeNames(body?.names);
        if (!names) {
          sendJson(response, 400, { error: 'Podaj dokładnie dwa imiona, maksymalnie po 60 znaków.' });
          return;
        }
        const created = createHousehold(database, names);
        sendJson(response, 201, {
          inviteCode: created.inviteCode,
          household: created.household,
          profile: created.profiles[0],
          profiles: created.profiles,
        }, setSessionCookie(response, created.token));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/households/join') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'Żądanie pochodzi z niedozwolonej strony.' });
          return;
        }
        const retryAfter = recordJoinAttempt(database, clientIp(request), Date.now(), rateLimitHashKey);
        if (retryAfter > 0) {
          sendJson(response, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie później.' }, {
            'Retry-After': String(retryAfter),
          });
          return;
        }
        const body = await readJson(request);
        const joined = joinHousehold(database, typeof body?.code === 'string' ? body.code.trim() : '');
        if (!joined) {
          sendJson(response, 401, { error: 'Nie udało się dołączyć. Sprawdź kod i spróbuj ponownie.' });
          return;
        }
        sendJson(response, 200, {
          household: joined.household,
          profile: joined.profile,
          profiles: joined.profiles,
        }, setSessionCookie(response, joined.token));
        return;
      }

      sendJson(response, 404, { error: 'Nie znaleziono strony.' });
    } catch (error) {
      jsonError(request, response, error);
    }
  });

  let listening = false;
  return {
    get url() {
      if (!listening) throw new Error('Server is not listening.');
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          listening = true;
          server.removeListener('error', rejectListen);
          resolveListen();
        });
      });
    },
    close() {
      return new Promise((resolveClose, rejectClose) => {
        const closeDatabase = () => {
          try {
            database.close();
            listening = false;
            resolveClose();
          } catch (error) {
            rejectClose(error);
          }
        };
        if (!listening) {
          closeDatabase();
          return;
        }
        server.close((error) => error ? rejectClose(error) : closeDatabase());
      });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createServer();
  app.listen(port, '0.0.0.0').then(() => {
    process.stdout.write(`Domowe obowiązki listening on ${port}\n`);
  }).catch(() => {
    process.stderr.write('Failed to start the application server.\n');
    process.exitCode = 1;
  });
}
