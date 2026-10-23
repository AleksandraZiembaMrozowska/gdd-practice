import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from '../server.mjs';

class HttpClientSession {
  constructor() {
    this.cookie = '';
    this.baseUrl = '';
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';', 1)[0];

    const contentType = response.headers.get('content-type') ?? '';
    const responseBody = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, body: responseBody };
  }
}

let app;
let databasePath;
let tempDirectory;

before(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'domowe-obowiazki-'));
  databasePath = join(tempDirectory, 'households.sqlite');
  app = createServer({ databasePath });
  await app.listen();
});

after(async () => {
  if (app) await app.close();
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

test('independent client sessions share a household after code-based joining', async () => {
  const creator = new HttpClientSession();
  const partner = new HttpClientSession();
  creator.baseUrl = app.url;
  partner.baseUrl = app.url;

  const created = await creator.request('/api/households', {
    method: 'POST',
    body: { names: ['Ala', 'Marek'] },
  });

  assert.equal(created.status, 201);
  assert.match(created.body.inviteCode, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(created.body.profiles.map(({ name }) => name), ['Ala', 'Marek']);
  assert.match(created.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(created.headers.get('set-cookie'), /SameSite=Strict/i);

  const joined = await partner.request('/api/households/join', {
    method: 'POST',
    body: { code: created.body.inviteCode },
  });

  assert.equal(joined.status, 200);
  assert.equal(joined.body.household.id, created.body.household.id);
  assert.equal(joined.body.profile.name, 'Marek');

  const creatorView = await creator.request('/api/session');
  const partnerView = await partner.request('/api/session');
  assert.equal(creatorView.status, 200);
  assert.equal(partnerView.status, 200);
  assert.deepEqual(creatorView.body.household.profiles.map(({ name }) => name), ['Ala', 'Marek']);
  assert.equal(creatorView.body.profile.name, 'Ala');
  assert.equal(partnerView.body.profile.name, 'Marek');
  assert.equal(JSON.stringify(creatorView.body).includes(created.body.inviteCode), false);

  const selected = await creator.request('/api/session/profile', {
    method: 'PUT',
    body: { profileId: creatorView.body.household.profiles[1].id },
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.profile.name, 'Marek');
  assert.equal((await creator.request('/api/session')).body.profile.name, 'Marek');
  assert.equal((await partner.request('/api/session')).body.profile.name, 'Marek');

  const restored = await creator.request('/api/session/profile', {
    method: 'PUT',
    body: { profileId: creatorView.body.household.profiles[0].id },
  });
  assert.equal(restored.status, 200);
  assert.equal((await creator.request('/api/session')).body.profile.name, 'Ala');
  assert.equal((await partner.request('/api/session')).body.profile.name, 'Marek');

  await app.close();
  app = createServer({ databasePath });
  await app.listen();
  creator.baseUrl = app.url;
  partner.baseUrl = app.url;

  assert.equal((await creator.request('/api/session')).body.profile.name, 'Ala');
  assert.equal((await partner.request('/api/session')).body.profile.name, 'Marek');
});

test('invalid invite codes are rejected and repeated attempts are rate limited', async () => {
  const rateLimitDatabase = join(tempDirectory, 'rate-limit.sqlite');
  let rateLimitedApp = createServer({ databasePath: rateLimitDatabase });
  await rateLimitedApp.listen();
  try {
    const visitor = new HttpClientSession();
    visitor.baseUrl = rateLimitedApp.url;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await visitor.request('/api/households/join', {
        method: 'POST',
        body: { code: `not-a-valid-code-${attempt}` },
      });
      assert.equal(result.status, 401);
    }

    await rateLimitedApp.close();
    rateLimitedApp = createServer({ databasePath: rateLimitDatabase });
    await rateLimitedApp.listen();
    visitor.baseUrl = rateLimitedApp.url;

    const limited = await visitor.request('/api/households/join', {
      method: 'POST',
      body: { code: 'another-invalid-code' },
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(visitor.cookie, '');
  } finally {
    await rateLimitedApp.close();
  }
});

test('the home page offers household creation and code-based joining', async () => {
  const visitor = new HttpClientSession();
  visitor.baseUrl = app.url;
  const page = await visitor.request('/');

  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/i);
  assert.match(page.body, /Utwórz gospodarstwo/);
  assert.match(page.body, /Dołącz do gospodarstwa/);
  assert.match(page.body, /Twoje imię/);
  assert.match(page.body, /Kod gospodarstwa/);
});
