import { expect } from 'chai';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { createApp, MAX_TEXT, MAX_NICKNAME } from '../src/server.js';
import { buildMessage } from '../src/auth.js';
import { newKeys, signed, sign, primaryQuery } from './helpers.js';

let server, base, dataDir;
let alice, bob, carol;

const send = (method, route, body) => fetch(base + route, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const setStatus = (keys, { state = 'purple', ttlSeconds = 3600, nickname = 'Al', text = '', allow = [] } = {}) => {
  const body = { pubKey: keys.pubKey, state, ttlSeconds, nickname, text, allow };
  return send('PUT', '/status', { ...body, ...signed(keys, 'status', [keys.pubKey, state, ttlSeconds, nickname, text, allow.join(',')]) });
};

const setAllow = (keys, allow) =>
  send('PUT', '/allow', { pubKey: keys.pubKey, allow, ...signed(keys, 'allow', [keys.pubKey, allow.join(',')]) });

const feed = async (keys) => (await fetch(`${base}/feed?${primaryQuery(keys, 'feed')}`)).json();

describe('statuses with text, the primary feed, and allow-list updates', () => {
  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-'));
    server = createApp({ dataDir }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    [alice, bob, carol] = await Promise.all([newKeys(), newKeys(), newKeys()]);
  });

  after(async () => {
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('states and text', () => {
    it('accepts each of the four colours', async () => {
      for(const state of ['purple', 'green', 'blue', 'orange']) {
        expect((await setStatus(alice, { state })).status).to.equal(200);
      }
    });

    it('rejects the old colours and unknown states (400)', async () => {
      for(const state of ['red', 'yellow', 'unknown', '']) {
        expect((await setStatus(alice, { state })).status, state).to.equal(400);
      }
    });

    it('accepts exactly 255 characters and rejects 256 (400)', async () => {
      expect((await setStatus(alice, { text: 'x'.repeat(MAX_TEXT) })).status).to.equal(200);
      expect((await setStatus(alice, { text: 'x'.repeat(MAX_TEXT + 1) })).status).to.equal(400);
    });

    it('counts an emoji as one character, like the app does', async () => {
      expect((await setStatus(alice, { text: '🎉'.repeat(MAX_TEXT) })).status).to.equal(200);
      expect((await setStatus(alice, { text: '🎉'.repeat(MAX_TEXT + 1) })).status).to.equal(400);
    });

    it('limits the nickname', async () => {
      expect((await setStatus(alice, { nickname: 'n'.repeat(MAX_NICKNAME + 1) })).status).to.equal(400);
    });

    it('signs text unambiguously: moving a "|" between nickname and text breaks the signature (401)', async () => {
      const ts = Date.now() + '';
      const signedFor = sign(alice.privateKey, buildMessage('status', ts, [alice.pubKey, 'purple', 3600, 'a|b', 'c', '']));
      const body = { pubKey: alice.pubKey, state: 'purple', ttlSeconds: 3600, nickname: 'a', text: 'b|c', allow: [], timestamp: ts, signature: signedFor };
      expect((await send('PUT', '/status', body)).status).to.equal(401);
      expect((await send('PUT', '/status', { ...body, nickname: 'a|b', text: 'c' })).status).to.equal(200);
    });

    it('rejects a status whose text was changed after signing (401)', async () => {
      const body = { pubKey: alice.pubKey, state: 'blue', ttlSeconds: 3600, nickname: 'Al', text: 'original', allow: [] };
      const sig = signed(alice, 'status', [alice.pubKey, 'blue', 3600, 'Al', 'original', '']);
      expect((await send('PUT', '/status', { ...body, text: 'tampered', ...sig })).status).to.equal(401);
    });
  });

  describe('feed', () => {
    it('shows a friend colour, nickname and text; shows nothing to someone not allowed', async () => {
      await setStatus(alice, { state: 'green', nickname: 'Alice', text: 'at the park', allow: [bob.pubKey] });
      const seen = (await feed(bob)).statuses[alice.pubKey];
      expect(seen.state).to.equal('green');
      expect(seen.nickname).to.equal('Alice');
      expect(seen.text).to.equal('at the park');
      expect((await feed(carol)).statuses).to.deep.equal({});
    });

    it('never includes the caller\'s own status', async () => {
      await setStatus(alice, { state: 'green', allow: [alice.pubKey, bob.pubKey] });
      expect((await feed(alice)).statuses).to.deep.equal({});
    });

    it('hides the text of an expired status', async () => {
      await fs.writeFile(path.join(dataDir, 'status', `${alice.pubKey}.json`), JSON.stringify({
        pubKey: alice.pubKey, state: 'green', ttlSeconds: 60, updatedAt: Date.now() - 61000,
        nickname: 'Alice', text: 'old news', allow: [bob.pubKey]
      }));
      const seen = (await feed(bob)).statuses[alice.pubKey];
      expect(seen.state).to.equal('unknown');
      expect(seen.text).to.equal('');
    });

    it('rejects forged, stale and wrong-route requests (401)', async () => {
      const forged = primaryQuery(bob, 'feed', { signature: 'ab'.repeat(64) });
      expect((await fetch(`${base}/feed?${forged}`)).status).to.equal(401);
      const stale = new URLSearchParams({ pubKey: bob.pubKey, ...signed(bob, 'feed', [bob.pubKey], (Date.now() - 120000) + '') });
      expect((await fetch(`${base}/feed?${stale}`)).status).to.equal(401);
      expect((await fetch(`${base}/feed?${primaryQuery(bob, 'mystatus')}`)).status).to.equal(401);
    });

    it('does not let one user read the feed as another (401)', async () => {
      const q = new URLSearchParams({ ...Object.fromEntries(primaryQuery(carol, 'feed')), pubKey: bob.pubKey });
      expect((await fetch(`${base}/feed?${q}`)).status).to.equal(401);
    });
  });

  describe('own status', () => {
    it('is null before the first status, then returns it without the allow-list', async () => {
      const res = await (await fetch(`${base}/status?${primaryQuery(carol, 'mystatus')}`)).json();
      expect(res.status).to.equal(null);

      await setStatus(carol, { state: 'orange', nickname: 'Cy', text: 'busy', allow: [bob.pubKey] });
      const mine = (await (await fetch(`${base}/status?${primaryQuery(carol, 'mystatus')}`)).json()).status;
      expect(mine).to.include({ state: 'orange', nickname: 'Cy', text: 'busy', ttlSeconds: 3600 });
      expect(mine).to.not.have.property('allow');
    });
  });

  describe('allow-list updates', () => {
    it('changes who can see a status without touching the status or extending its life', async () => {
      await setStatus(alice, { state: 'blue', nickname: 'Alice', text: 'hello', allow: [bob.pubKey] });
      const before = (await feed(bob)).statuses[alice.pubKey];

      await new Promise(r => setTimeout(r, 15));
      expect((await setAllow(alice, [carol.pubKey])).status).to.equal(200);

      expect((await feed(bob)).statuses).to.not.have.property(alice.pubKey);
      const after = (await feed(carol)).statuses[alice.pubKey];
      expect(after).to.deep.equal(before);
    });

    it('returns 404 when there is no status yet', async () => {
      const dave = await newKeys();
      expect((await setAllow(dave, [bob.pubKey])).status).to.equal(404);
    });

    it('rejects an allow-list update signed by someone else (401)', async () => {
      const body = { pubKey: alice.pubKey, allow: [bob.pubKey], ...signed(bob, 'allow', [alice.pubKey, bob.pubKey]) };
      expect((await send('PUT', '/allow', body)).status).to.equal(401);
    });
  });
});
