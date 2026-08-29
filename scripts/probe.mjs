#!/usr/bin/env node
// Sonde autonome : interroge VOTRE compte Netatmo et affiche ce que
// l'intégration en ferait, sans Gladys, sans Docker, sans OAuth2.
//
// Usage le plus simple (token généré à la main sur dev.netatmo.com,
// section "Token generator", scopes read_bubendorff + write_bubendorff) :
//
//   NETATMO_ACCESS_TOKEN=xxx node scripts/probe.mjs
//
// Ou avec un refresh token, si l'access token a déjà expiré (3 h) :
//
//   NETATMO_CLIENT_ID=xxx NETATMO_CLIENT_SECRET=xxx \
//   NETATMO_REFRESH_TOKEN=xxx node scripts/probe.mjs
//
// Ajoutez --move pour envoyer une vraie commande de test au premier volet :
//
//   NETATMO_ACCESS_TOKEN=xxx node scripts/probe.mjs --move 50
//
// Attention : --move fait physiquement bouger un volet.

import { NetatmoClient, SHUTTER_MODULE_TYPES } from '../src/netatmo.js';
import { buildDevice, platformId, positionToCoverState, rfStrengthToQuality } from '../src/mapping.js';

const moveIndex = process.argv.indexOf('--move');
const movePosition = moveIndex !== -1 ? Number(process.argv[moveIndex + 1]) : null;

const client = new NetatmoClient({
  clientId: process.env.NETATMO_CLIENT_ID,
  clientSecret: process.env.NETATMO_CLIENT_SECRET,
  accessToken: process.env.NETATMO_ACCESS_TOKEN,
  refreshToken: process.env.NETATMO_REFRESH_TOKEN,
  // Un access token fourni à la main est considéré valide pour 3 h.
  expiresAt: process.env.NETATMO_ACCESS_TOKEN ? Date.now() + 3 * 3600 * 1000 : 0,
  onTokens: (tokens) => {
    console.log('\n⚠️  Nouveaux tokens émis. Le refresh token Netatmo est à usage unique,');
    console.log('    notez le nouveau si vous relancez ce script :');
    console.log(`    NETATMO_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  },
});

if (!client.accessToken && !client.refreshToken) {
  console.error('Il faut NETATMO_ACCESS_TOKEN, ou NETATMO_CLIENT_ID + NETATMO_CLIENT_SECRET + NETATMO_REFRESH_TOKEN.');
  process.exit(1);
}

// Un faux « gladys » : externalIds est la seule méthode dont buildDevice a besoin.
const fakeGladys = {
  externalIds: (type, pid) => ({
    device: `ext:netatmo-idiamant:${type}:${pid}`,
    feature: (key) => `ext:netatmo-idiamant:${type}:${pid}:${key}`,
  }),
};

const run = async () => {
  console.log('→ GET /api/homesdata');
  const homesData = await client.getHomesData();
  const homes = homesData.homes || [];
  console.log(`  ${homes.length} maison(s) retournée(s)\n`);

  let firstShutter = null;

  for (const home of homes) {
    const allModules = home.modules || [];
    const shutterModules = allModules.filter((m) => SHUTTER_MODULE_TYPES.includes(m.type));
    const roomsById = new Map((home.rooms || []).map((r) => [r.id, r]));

    console.log(`═══ Maison « ${home.name} » (${home.id})`);
    console.log(`    modules déclarés : ${allModules.map((m) => m.type).join(', ') || 'aucun'}`);

    if (shutterModules.length === 0) {
      console.log('    Aucun volet Bubendorff (NBR/NBO/NBS) ici.\n');
      continue;
    }

    console.log('\n→ GET /api/homestatus');
    const status = await client.getHomeStatus(home.id);
    const statusById = new Map(((status.home && status.home.modules) || []).map((m) => [m.id, m]));

    for (const module of shutterModules) {
      const moduleStatus = statusById.get(module.id) || {};
      const room = module.room_id ? roomsById.get(module.room_id) : null;
      const device = buildDevice({ gladys: fakeGladys, module, home, room, status: moduleStatus });

      if (!firstShutter) {
        firstShutter = { homeId: home.id, module };
      }

      console.log(`\n  ── ${device.name}  [${module.type}]`);
      console.log(`     module id      : ${module.id}`);
      console.log(`     bridge         : ${module.bridge || '(aucun)'}`);
      console.log(`     pièce          : ${room ? room.name : '(non assignée)'}`);
      console.log(`     platformId     : ${platformId(home.id, module.id)}`);
      console.log(`     position       : ${moduleStatus.current_position ?? '(non remontée)'}`);
      if (typeof moduleStatus.current_position === 'number') {
        console.log(`     → état Gladys  : ${positionToCoverState(moduleStatus.current_position)} (-1 fermé / 0 stop / 1 ouvert)`);
      }
      console.log(`     rf_strength    : ${moduleStatus.rf_strength ?? '—'} → qualité ${rfStrengthToQuality(moduleStatus.rf_strength) ?? '—'}%`);
      console.log(`     joignable      : ${moduleStatus.reachable ?? '—'}`);
      console.log(`     fonctionnalités: ${device.features.map((f) => `${f.category}/${f.type}`).join(', ')}`);

      // Champs que Netatmo remonte et que l'intégration n'exploite pas encore :
      // utile pour repérer l'orientation des lames sur un BSO, par exemple.
      const known = new Set([
        'id', 'type', 'current_position', 'target_position', 'rf_strength',
        'reachable', 'battery_level', 'battery_state', 'firmware_revision', 'bridge',
      ]);
      const extra = Object.keys(moduleStatus).filter((k) => !known.has(k));
      if (extra.length > 0) {
        console.log(`     champs non exploités : ${extra.join(', ')}`);
        extra.forEach((k) => console.log(`       ${k} = ${JSON.stringify(moduleStatus[k])}`));
      }
    }
    console.log('');
  }

  if (movePosition !== null) {
    if (!firstShutter) {
      console.log('Aucun volet à faire bouger.');
      return;
    }
    if (!Number.isFinite(movePosition) || movePosition < -2 || movePosition > 100) {
      console.error('--move attend une valeur entre 0 et 100 (ou -1 pour stop, -2 pour position préférée).');
      process.exit(1);
    }
    console.log(`→ POST /api/setstate  ${firstShutter.module.name || firstShutter.module.id} → ${movePosition}`);
    await client.setState(firstShutter.homeId, [
      {
        id: firstShutter.module.id,
        ...(firstShutter.module.bridge ? { bridge: firstShutter.module.bridge } : {}),
        target_position: movePosition,
      },
    ]);
    console.log('  Commande acceptée. Le volet devrait bouger dans les secondes qui viennent.');
    console.log('  Relancez la sonde dans ~30 s pour voir la nouvelle position.');
  }
};

run().catch((error) => {
  console.error(`\n✖ ${error.message}`);
  if (error.code) {
    console.error(`  code Netatmo : ${error.code}`);
  }
  process.exit(1);
});
