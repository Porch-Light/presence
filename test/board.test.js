import { expect } from 'chai';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { createApp, DELEGATE_TTL_MS } from '../src/server.js';
import { newKeys, signed } from './helpers.js';

let server, base, dataDir;
let alice, bob, carol, bobWeb, carolWeb, aliceWeb;

const json = (method, route, body) => fetch(base + route, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const setStatus = (keys, { state = 'green', ttlSeconds = 3600, nickname = '', text = '', allow = [] } = {}) => {
  const body = { pubKey: keys.pubKey, state, ttlSeconds, nickname, text, allow };
  return json('PUT', '/status', { ...body, ...signed(keys, 'status', [keys.pubKey, state, ttlSeconds, nickname, text, allow.join(',')]) });
};

const delegate = (primary, web) =>
  json('PUT', '/delegate', { primaryPubKey: primary.pubKey, webPubKey: web.pubKey, ...signed(primary, 'delegate', [primary.pubKey, web.pubKey]) });

const revoke = (primary, web) =>
  json('DELETE', `/delegate/${web.pubKey}`, { primaryPubKey: primary.pubKey, ...signed(primary, 'undelegate', [primary.pubKey, web.pubKey]) });

const webGet = (route, web, tag = route.slice(1), overrides = {}) => {
  const { timestamp, signature } = signed(web, tag, [web.pubKey]);
  const q = new URLSearchParams({ webPubKey: web.pubKey, timestamp, signature, ...overrides });
  return fetch(`${base}${route}?${q}`);
};

const writeRaw = async (collection, key, value) => {
  await fs.mkdir(path.join(dataDir, collection), { recursive: true });
  await fs.writeFile(path.join(dataDir, collection, `${key}.json`), JSON.stringify(value));
};

describe('delegates, whoami and statuses', () => {
  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-'));
    server = createApp({ dataDir }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    [alice, bob, carol, bobWeb, carolWeb, aliceWeb] = await Promise.all(Array.from({ length: 6 }, newKeys));
  });

  after(async () => {
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('delegates', () => {
    it('registers a delegate and resolves it with /whoami', async () => {
      expect((await delegate(bob, bobWeb)).status).to.equal(200);
      const res = await webGet('/whoami', bobWeb);
      expect(res.status).to.equal(200);
      expect((await res.json()).primaryPubKey).to.equal(bob.pubKey);
    });

    it('rejects a delegate request not signed by the primary (401)', async () => {
      const body = { primaryPubKey: alice.pubKey, webPubKey: aliceWeb.pubKey, ...signed(aliceWeb, 'delegate', [alice.pubKey, aliceWeb.pubKey]) };
      expect((await json('PUT', '/delegate', body)).status).to.equal(401);
      expect((await webGet('/whoami', aliceWeb)).status).to.equal(401);
    });

    it('does not let another primary take over a delegated web key (409)', async () => {
      expect((await delegate(carol, bobWeb)).status).to.equal(409);
      expect((await (await webGet('/whoami', bobWeb)).json()).primaryPubKey).to.equal(bob.pubKey);
    });

    it('rejects /whoami with a forged or stale web signature (401)', async () => {
      expect((await webGet('/whoami', bobWeb, 'whoami', { signature: 'ab'.repeat(64) })).status).to.equal(401);
      const stale = signed(bobWeb, 'whoami', [bobWeb.pubKey], (Date.now() - 120000) + '');
      const q = new URLSearchParams({ webPubKey: bobWeb.pubKey, ...stale });
      expect((await fetch(`${base}/whoami?${q}`)).status).to.equal(401);
    });

    it('rejects a signature made for a different route (401)', async () => {
      expect((await webGet('/whoami', bobWeb, 'statuses')).status).to.equal(401);
    });

    it('only the owner can revoke; after revoking the web key is rejected (401)', async () => {
      await delegate(carol, carolWeb);
      await revoke(bob, carolWeb); // not the owner: silently ignored
      expect((await webGet('/whoami', carolWeb)).status).to.equal(200);

      expect((await revoke(carol, carolWeb)).status).to.equal(200);
      expect((await webGet('/whoami', carolWeb)).status).to.equal(401);
      expect((await webGet('/statuses', carolWeb)).status).to.equal(401);
    });

    it('rejects an expired delegate (401)', async () => {
      await delegate(carol, carolWeb);
      const old = Date.now() - DELEGATE_TTL_MS - 1000;
      await writeRaw('delegates', carolWeb.pubKey, { webPubKey: carolWeb.pubKey, primaryPubKey: carol.pubKey, createdAt: old, lastSeenAt: old });
      expect((await webGet('/whoami', carolWeb)).status).to.equal(401);
    });
  });

  describe('statuses', () => {
    before(async () => {
      await delegate(carol, carolWeb);
      await setStatus(alice, { state: 'orange', nickname: 'Alice', allow: [bob.pubKey] });
    });

    it('shows a status to a viewer on the allow-list', async () => {
      const { statuses } = await (await webGet('/statuses', bobWeb)).json();
      expect(statuses[alice.pubKey].state).to.equal('orange');
      expect(statuses[alice.pubKey].nickname).to.equal('Alice');
      expect(statuses[alice.pubKey].updatedAt).to.be.a('number');
    });

    it('omits owners who have not allowed the viewer, with no sign they exist', async () => {
      const res = await webGet('/statuses', carolWeb);
      expect(res.status).to.equal(200);
      expect((await res.json()).statuses).to.deep.equal({});
    });

    it('applies an updated allow-list immediately', async () => {
      await setStatus(alice, { state: 'blue', nickname: 'Alice', allow: [bob.pubKey, carol.pubKey] });
      expect((await (await webGet('/statuses', carolWeb)).json()).statuses[alice.pubKey].state).to.equal('blue');
      await setStatus(alice, { state: 'blue', nickname: 'Alice', allow: [carol.pubKey] });
      expect((await (await webGet('/statuses', bobWeb)).json()).statuses).to.deep.equal({});
    });

    it('returns unknown once the ttl has passed', async () => {
      await writeRaw('status', alice.pubKey, {
        pubKey: alice.pubKey, state: 'green', ttlSeconds: 60, updatedAt: Date.now() - 61000, nickname: 'Alice', text: 'secret', allow: [bob.pubKey]
      });
      expect((await (await webGet('/statuses', bobWeb)).json()).statuses[alice.pubKey].state).to.equal('unknown');
    });

    it('keeps returning the status while within the ttl', async () => {
      await writeRaw('status', alice.pubKey, {
        pubKey: alice.pubKey, state: 'green', ttlSeconds: 60, updatedAt: Date.now() - 30000, nickname: 'Alice', text: 'secret', allow: [bob.pubKey]
      });
      expect((await (await webGet('/statuses', bobWeb)).json()).statuses[alice.pubKey].state).to.equal('green');
    });
  });
});
