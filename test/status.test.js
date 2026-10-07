import { expect } from 'chai';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { createApp } from '../src/server.js';
import { newKeys, signed, sign } from './helpers.js';
import { buildMessage } from '../src/auth.js';

let server, base, dataDir;
let alice, bob;

const put = (route, body) => fetch(base + route, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const statusBody = (keys, overrides = {}, timestamp) => {
  const b = { pubKey: keys.pubKey, state: 'green', ttlSeconds: 3600, nickname: 'Al', text: 'hi', allow: [bob.pubKey], ...overrides };
  return { ...b, ...signed(keys, 'status', [b.pubKey, b.state, b.ttlSeconds, b.nickname, b.text, b.allow.join(',')], timestamp) };
};

describe('presence skeleton', () => {
  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-'));
    server = createApp({ dataDir }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    alice = await newKeys();
    bob = await newKeys();
  });

  after(async () => {
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('responds to /health', async () => {
    const res = await fetch(base + '/health');
    expect((await res.json()).ok).to.equal(true);
  });

  it('stores a validly signed status', async () => {
    const res = await put('/status', statusBody(alice));
    expect(res.status).to.equal(200);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'status', `${alice.pubKey}.json`), 'utf8'));
    expect(saved.state).to.equal('green');
    expect(saved.allow).to.deep.equal([bob.pubKey]);
  });

  it('rejects a forged signature (401)', async () => {
    const body = statusBody(alice);
    const forged = { ...body, ...signed(bob, 'status', [alice.pubKey, 'green', 3600, 'Al', 'hi', bob.pubKey]) };
    expect((await put('/status', forged)).status).to.equal(401);
  });

  it('rejects a tampered body (401)', async () => {
    const body = statusBody(alice);
    expect((await put('/status', { ...body, state: 'orange' })).status).to.equal(401);
  });

  it('rejects a stale timestamp (401)', async () => {
    const stale = (Date.now() - 120000) + '';
    expect((await put('/status', statusBody(alice, {}, stale))).status).to.equal(401);
  });

  it('rejects a signature made for a different route tag (401)', async () => {
    const body = statusBody(alice);
    const ts = Date.now() + '';
    const wrongTag = sign(alice.privateKey, buildMessage('delegate', ts, [alice.pubKey, 'green', 3600, 'Al', 'hi', bob.pubKey]));
    expect((await put('/status', { ...body, timestamp: ts, signature: wrongTag })).status).to.equal(401);
  });

  it('rejects invalid input (400)', async () => {
    expect((await put('/status', statusBody(alice, { state: 'red' }))).status).to.equal(400);
    expect((await put('/status', statusBody(alice, { ttlSeconds: 999999 }))).status).to.equal(400);
    expect((await put('/status', statusBody(alice, { allow: ['not-a-key'] }))).status).to.equal(400);
  });
});
