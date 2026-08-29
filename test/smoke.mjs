// Test de fumée : on remplace fetch par une fausse API Netatmo, et on vérifie
// que le client, le mapping et la conversion des commandes se comportent bien.
import assert from 'node:assert/strict';

import { NetatmoClient } from '../src/netatmo.js';
import {
  buildDevice,
  coverStateToTargetPosition,
  featureKeyOf,
  platformId,
  platformIdOf,
  positionToCoverState,
  rfStrengthToQuality,
  COVER_STATE,
} from '../src/mapping.js';

const HOME = {
  id: '5a2fe8a5b48abcdef0123456',
  name: 'Maison',
  rooms: [{ id: '111', name: 'Salon' }],
  modules: [
    { id: '00:11:22:33:44:55', type: 'NBG', name: 'Passerelle iDiamant' },
    { id: '00:11:22:33:44:66', type: 'NBR', name: 'Volet salon', room_id: '111', bridge: '00:11:22:33:44:55' },
    { id: '00:11:22:33:44:77', type: 'NBO', name: 'BSO cuisine', bridge: '00:11:22:33:44:55' },
  ],
};

const calls = [];
let currentPosition = 40;

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  calls.push({ href, method: options.method || 'GET', body: options.body });

  if (href.includes('/oauth2/token')) {
    return new Response(
      JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 10800 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (href.includes('/api/homesdata')) {
    assert.ok(href.includes('gateway_types=NBG'), 'homesdata doit filtrer sur la passerelle NBG');
    return Response.json({ body: { homes: [HOME] } });
  }
  if (href.includes('/api/homestatus')) {
    return Response.json({
      body: {
        home: {
          id: HOME.id,
          modules: [
            { id: '00:11:22:33:44:66', type: 'NBR', current_position: currentPosition, rf_strength: 66, reachable: true },
            { id: '00:11:22:33:44:77', type: 'NBO', current_position: 100, rf_strength: 88, reachable: false, battery_level: 72 },
          ],
        },
      },
    });
  }
  if (href.includes('/api/setstate')) {
    const parsed = JSON.parse(options.body);
    currentPosition = parsed.home.modules[0].target_position;
    return Response.json({ status: 'ok' });
  }
  return new Response('{}', { status: 404 });
};

// --- Mapping pur ------------------------------------------------------------

assert.equal(positionToCoverState(100), COVER_STATE.OPEN);
assert.equal(positionToCoverState(0), COVER_STATE.CLOSE);
assert.equal(positionToCoverState(45), COVER_STATE.STOP);
assert.equal(coverStateToTargetPosition(COVER_STATE.OPEN), 100);
assert.equal(coverStateToTargetPosition(COVER_STATE.CLOSE), 0);
assert.equal(coverStateToTargetPosition(COVER_STATE.STOP), -1, 'stop => target_position -1');
assert.equal(rfStrengthToQuality(60), 100);
assert.equal(rfStrengthToQuality(90), 0);
assert.equal(rfStrengthToQuality(75), 50);
assert.equal(rfStrengthToQuality(undefined), null);
console.log('✔ mapping positions / états / signal');

// --- Construction d'un appareil --------------------------------------------

const fakeGladys = {
  externalIds: (type, pid) => ({
    device: `ext:netatmo-idiamant:${type}:${pid}`,
    feature: (key) => `ext:netatmo-idiamant:${type}:${pid}:${key}`,
  }),
};

const device = buildDevice({
  gladys: fakeGladys,
  module: HOME.modules[1],
  home: HOME,
  room: HOME.rooms[0],
  status: null,
});

assert.equal(device.name, 'Volet salon');
assert.equal(device.features.length, 3, 'pas de fonctionnalité batterie sans batterie remontée');
const stateFeature = device.features[0];
assert.equal(stateFeature.category, 'shutter');
assert.equal(stateFeature.type, 'state');
assert.equal(stateFeature.min, -1);
assert.equal(stateFeature.max, 1);
assert.equal(device.features[1].type, 'position');
assert.equal(device.features[1].max, 100);

const withBattery = buildDevice({
  gladys: fakeGladys,
  module: HOME.modules[2],
  home: HOME,
  room: null,
  status: { battery_level: 72 },
});
assert.equal(withBattery.features.length, 4, 'fonctionnalité batterie ajoutée quand le module en remonte une');
assert.equal(withBattery.name, 'BSO cuisine');
console.log('✔ construction des appareils et des fonctionnalités');

// --- Parsing des external_id ------------------------------------------------

const pid = platformId(HOME.id, '00:11:22:33:44:66');
assert.ok(!pid.includes(':'), "le platformId ne doit pas contenir de « : »");
assert.equal(platformIdOf(stateFeature.external_id), pid);
assert.equal(featureKeyOf(stateFeature.external_id), 'state');
console.log('✔ round-trip des external_id');

// --- Client Netatmo ---------------------------------------------------------

const persisted = [];
const client = new NetatmoClient({
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rt-old',
  onTokens: async (tokens) => persisted.push(tokens),
});

const homesData = await client.getHomesData();
assert.equal(homesData.homes[0].id, HOME.id);
assert.equal(persisted.length, 1, 'un refresh a eu lieu, les tokens ont été persistés');
assert.equal(persisted[0].refresh_token, 'rt-new', 'le refresh_token tournant est bien sauvegardé');
assert.equal(client.accessToken, 'at-new');

const status = await client.getHomeStatus(HOME.id);
assert.equal(status.home.modules[0].current_position, 40);

await client.setState(HOME.id, [{ id: '00:11:22:33:44:66', bridge: '00:11:22:33:44:55', target_position: 100 }]);
const setStateCall = calls.find((c) => c.href.includes('setstate'));
const sent = JSON.parse(setStateCall.body);
assert.equal(sent.home.id, HOME.id);
assert.equal(sent.home.modules[0].target_position, 100);
assert.equal(sent.home.modules[0].bridge, '00:11:22:33:44:55');
assert.equal(currentPosition, 100);
console.log('✔ client Netatmo : homesdata, homestatus, setstate, rotation des tokens');

// --- Rafraîchissement concurrent -------------------------------------------

const racy = new NetatmoClient({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rt', onTokens: async () => {} });
const before = calls.filter((c) => c.href.includes('/oauth2/token')).length;
await Promise.all([racy.refreshAccessToken(), racy.refreshAccessToken(), racy.refreshAccessToken()]);
const after = calls.filter((c) => c.href.includes('/oauth2/token')).length;
assert.equal(after - before, 1, 'trois refresh simultanés ne doivent produire qu’une seule requête');
console.log('✔ rafraîchissement de token sérialisé');

// --- URL d'autorisation -----------------------------------------------------

const authorizeUrl = new URL(client.buildAuthorizeUrl('https://oauth.gladysassistant.com/callback', 'state-123'));
assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://api.netatmo.com/oauth2/authorize');
assert.equal(authorizeUrl.searchParams.get('scope'), 'read_bubendorff write_bubendorff');
assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://oauth.gladysassistant.com/callback');
assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
console.log('✔ URL d’autorisation OAuth2');

console.log('\nTous les tests passent.');
