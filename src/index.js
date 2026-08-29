import crypto from 'node:crypto';

import { GladysIntegration, DEVICE_TRANSPORTS, logger } from '@gladysassistant/integration-sdk';

import { NetatmoClient, NetatmoError } from './netatmo.js';
import {
  buildDevice,
  coverStateToTargetPosition,
  featureKeyOf,
  isShutterModule,
  platformId,
  platformIdOf,
  positionToCoverState,
  rfStrengthToQuality,
  FEATURE_KEYS,
  NETATMO_POSITION,
} from './mapping.js';

const gladys = new GladysIntegration();

const DEFAULT_POLL_INTERVAL_SECONDS = 60;

// Un volet met 15 à 30 secondes à parcourir sa course. Netatmo ne pousse rien,
// donc après une commande on va rechercher l'état à ces échéances plutôt que
// d'attendre le prochain tour de boucle.
const POST_COMMAND_REFRESH_DELAYS_MS = [4000, 12000, 30000];

/** Cache des volets connus, indexé par platformId. */
const shutters = new Map();

/** Dernière valeur publiée par fonctionnalité, pour ne publier que les changements. */
const lastPublished = new Map();

let netatmo = null;
let pollTimer = null;
let oauthState = null;
let refreshInFlight = null;
const pendingRefreshTimers = new Set();

const parsePollInterval = (config) => {
  const value = Number(config.poll_interval);
  return Number.isFinite(value) && value >= 15 ? value : DEFAULT_POLL_INTERVAL_SECONDS;
};

/**
 * (Re)construit le client Netatmo à partir de la configuration courante.
 * Appelé au démarrage et à chaque sauvegarde du formulaire.
 */
const buildClient = (config) =>
  new NetatmoClient({
    clientId: config.client_id,
    clientSecret: config.client_secret,
    accessToken: config.access_token,
    refreshToken: config.refresh_token,
    expiresAt: config.token_expires_at,
    onTokens: async (tokens) => {
      // Le refresh_token Netatmo est à usage unique : on le persiste
      // immédiatement, avant même de s'en servir.
      await gladys.setConfig(tokens);
    },
  });

/**
 * Récupère la topologie complète et met à jour le cache des volets.
 * Retourne la liste des appareils au format Gladys.
 */
const loadShutters = async () => {
  const homesData = await netatmo.getHomesData();
  const homes = homesData.homes || [];
  const devices = [];

  shutters.clear();

  for (const home of homes) {
    const modules = (home.modules || []).filter(isShutterModule);
    if (modules.length === 0) {
      continue;
    }

    const roomsById = new Map((home.rooms || []).map((room) => [room.id, room]));

    // /homestatus n'est pas indispensable ici, mais il nous dit si le volet
    // remonte une batterie — donc s'il faut déclarer la fonctionnalité.
    let statusByModuleId = new Map();
    try {
      const status = await netatmo.getHomeStatus(home.id);
      const statusHome = (status.home && status.home.modules) || [];
      statusByModuleId = new Map(statusHome.map((module) => [module.id, module]));
    } catch (error) {
      logger.warn(`Impossible de lire l'état de la maison ${home.id} pendant le scan : ${error.message}`);
    }

    for (const module of modules) {
      const room = module.room_id ? roomsById.get(module.room_id) : null;
      const status = statusByModuleId.get(module.id) || null;
      const device = buildDevice({ gladys, module, home, room, status });

      shutters.set(platformId(home.id, module.id), {
        homeId: home.id,
        moduleId: module.id,
        bridgeId: module.bridge || null,
        type: module.type,
        externalIds: {
          device: device.external_id,
          state: device.features.find((f) => featureKeyOf(f.external_id) === FEATURE_KEYS.STATE).external_id,
          position: device.features.find((f) => featureKeyOf(f.external_id) === FEATURE_KEYS.POSITION).external_id,
          signal: device.features.find((f) => featureKeyOf(f.external_id) === FEATURE_KEYS.SIGNAL).external_id,
          battery: (device.features.find((f) => featureKeyOf(f.external_id) === FEATURE_KEYS.BATTERY) || {}).external_id,
        },
      });

      devices.push(device);
    }
  }

  return devices;
};

/** Empile un état seulement s'il a réellement bougé (limite : 300 états/minute). */
const pushIfChanged = (batch, externalId, value) => {
  if (!externalId || value === null || value === undefined || Number.isNaN(value)) {
    return;
  }
  if (lastPublished.get(externalId) === value) {
    return;
  }
  lastPublished.set(externalId, value);
  batch.push({ device_feature_external_id: externalId, state: value });
};

/**
 * Interroge /homestatus pour chaque maison et publie les états qui ont changé.
 * Sérialisé : deux rafraîchissements simultanés ne servent à rien et comptent
 * double dans le quota Netatmo (500 requêtes/heure/utilisateur).
 */
const refreshStates = async () => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    if (!netatmo || !netatmo.isLinked) {
      return;
    }
    if (shutters.size === 0) {
      await loadShutters();
    }

    const homeIds = [...new Set([...shutters.values()].map((shutter) => shutter.homeId))];
    const batch = [];
    const transports = [];

    for (const homeId of homeIds) {
      const status = await netatmo.getHomeStatus(homeId);
      const modules = (status.home && status.home.modules) || [];

      for (const module of modules) {
        const shutter = shutters.get(platformId(homeId, module.id));
        if (!shutter) {
          continue;
        }

        transports.push({
          external_id: shutter.externalIds.device,
          transport: module.reachable === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD,
        });

        if (typeof module.current_position === 'number') {
          const position = Math.max(0, Math.min(100, module.current_position));
          pushIfChanged(batch, shutter.externalIds.position, position);
          pushIfChanged(batch, shutter.externalIds.state, positionToCoverState(position));
        }
        pushIfChanged(batch, shutter.externalIds.signal, rfStrengthToQuality(module.rf_strength));
        if (typeof module.battery_level === 'number') {
          pushIfChanged(batch, shutter.externalIds.battery, module.battery_level);
        }
      }
    }

    if (batch.length > 0) {
      // publishStates plafonne à 100 états par requête.
      for (let i = 0; i < batch.length; i += 100) {
        await gladys.publishStates(batch.slice(i, i + 100));
      }
      logger.debug(`${batch.length} état(s) publié(s)`);
    }
    if (transports.length > 0) {
      await gladys.publishTransports(transports);
    }

    await gladys.setConnectionStatus(true);
  })()
    .catch(async (error) => {
      logger.error(`Rafraîchissement des états impossible : ${error.message}`);
      await gladys
        .setConnectionStatus(false, {
          en: 'Cannot reach the Netatmo API. Check your credentials and reconnect your account.',
          fr: "API Netatmo injoignable. Vérifiez vos identifiants et reconnectez votre compte.",
        })
        .catch(() => {});
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
};

/** Replanifie quelques relectures après une commande, le temps que le volet bouge. */
const schedulePostCommandRefresh = () => {
  POST_COMMAND_REFRESH_DELAYS_MS.forEach((delay) => {
    const timer = setTimeout(() => {
      pendingRefreshTimers.delete(timer);
      refreshStates().catch(() => {});
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    pendingRefreshTimers.add(timer);
  });
};

const startPolling = (config) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const intervalSeconds = parsePollInterval(config);
  pollTimer = setInterval(() => refreshStates().catch(() => {}), intervalSeconds * 1000);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
  logger.info(`Interrogation de l'API Netatmo toutes les ${intervalSeconds} secondes`);
};

/**
 * Échappatoire de développement : permet d'injecter des identifiants par
 * variables d'environnement pour tester la partie appareils sans passer par le
 * flux OAuth2. Inerte en production — Gladys n'injecte que ses propres
 * variables dans le conteneur, l'utilisateur ne peut pas en ajouter.
 */
const applyDevOverrides = (config) => {
  const { NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN } = process.env;
  if (!NETATMO_REFRESH_TOKEN) {
    return config;
  }
  logger.warn('Identifiants Netatmo repris des variables d’environnement (mode développement)');
  return {
    ...config,
    client_id: NETATMO_CLIENT_ID || config.client_id,
    client_secret: NETATMO_CLIENT_SECRET || config.client_secret,
    refresh_token: config.refresh_token || NETATMO_REFRESH_TOKEN,
  };
};

/** Applique une configuration : reconstruit le client, relance la boucle. */
const applyConfig = async (rawConfig) => {
  const config = applyDevOverrides(rawConfig);
  netatmo = buildClient(config);
  startPolling(config);

  if (!netatmo.isConfigured) {
    await gladys.setConnectionStatus(false, {
      en: 'Enter your Netatmo client ID and client secret to get started.',
      fr: 'Renseignez votre client ID et votre client secret Netatmo pour commencer.',
    });
    return;
  }
  if (!netatmo.isLinked) {
    await gladys.setConnectionStatus(false, {
      en: 'Netatmo account not linked yet. Click "Connect".',
      fr: 'Compte Netatmo non relié. Cliquez sur « Connecter ».',
    });
    return;
  }

  await refreshStates();
};

// --- Découverte -------------------------------------------------------------

gladys.onScanRequest(async () => {
  if (!netatmo || !netatmo.isLinked) {
    throw new Error("Reliez d'abord votre compte Netatmo depuis l'onglet Configuration.");
  }
  const devices = await loadShutters();
  logger.info(`${devices.length} volet(s) iDiamant découvert(s)`);
  await gladys.publishDiscoveredDevices(devices);
  await refreshStates();
});

// --- Commandes --------------------------------------------------------------

gladys.onSetValue(async (device, feature, value) => {
  const shutter = shutters.get(platformIdOf(feature.external_id));
  if (!shutter) {
    // Cache vide après un redémarrage : on le reconstruit et on réessaie.
    await loadShutters();
  }
  const target = shutters.get(platformIdOf(feature.external_id));
  if (!target) {
    throw new Error(`Volet inconnu pour la fonctionnalité ${feature.external_id}`);
  }

  const key = featureKeyOf(feature.external_id);
  let targetPosition;

  if (key === FEATURE_KEYS.POSITION) {
    targetPosition = Math.max(0, Math.min(100, Math.round(Number(value))));
  } else if (key === FEATURE_KEYS.STATE) {
    targetPosition = coverStateToTargetPosition(Number(value));
  } else {
    throw new Error(`Fonctionnalité non pilotable : ${key}`);
  }

  await netatmo.setState(target.homeId, [
    {
      id: target.moduleId,
      ...(target.bridgeId ? { bridge: target.bridgeId } : {}),
      target_position: targetPosition,
    },
  ]);

  // Retour optimiste immédiat pour que l'interface réagisse, sauf sur un stop
  // où seule la relecture nous dira où le volet s'est réellement arrêté.
  if (targetPosition >= 0) {
    const batch = [];
    pushIfChanged(batch, target.externalIds.position, targetPosition);
    pushIfChanged(batch, target.externalIds.state, positionToCoverState(targetPosition));
    if (batch.length > 0) {
      await gladys.publishStates(batch);
    }
  }

  schedulePostCommandRefresh();
});

gladys.onPoll(async () => {
  await refreshStates();
});

// --- Configuration et OAuth2 ------------------------------------------------

gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration mise à jour');
  await applyConfig(config);
});

gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
  if (!netatmo || !netatmo.isConfigured) {
    throw new Error('Renseignez et enregistrez votre client ID et votre client secret Netatmo avant de connecter le compte.');
  }
  oauthState = crypto.randomUUID();
  return netatmo.buildAuthorizeUrl(redirectUri, oauthState);
});

gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
  if (!oauthState || state !== oauthState) {
    throw new Error('État OAuth2 invalide, relancez la connexion.');
  }
  oauthState = null;

  // redirectUri est renvoyé à l'octet près : Netatmo compare la chaîne exacte.
  await netatmo.exchangeCode(code, redirectUri);
  await gladys.setConnectionStatus(true);

  const devices = await loadShutters();
  await gladys.publishDiscoveredDevices(devices);
  await refreshStates();
});

// --- Boutons d'action -------------------------------------------------------

gladys.onAction('test_connection', async () => {
  if (!netatmo || !netatmo.isLinked) {
    throw new NetatmoError('Compte Netatmo non relié.');
  }
  const devices = await loadShutters();
  return {
    en: `Connection OK — ${devices.length} shutter(s) found.`,
    fr: `Connexion OK — ${devices.length} volet(s) trouvé(s).`,
  };
});

gladys.onAction('refresh_now', async () => {
  await refreshStates();
  return { en: 'States refreshed.', fr: 'États rafraîchis.' };
});

gladys.onAction('preferred_position', async () => {
  if (shutters.size === 0) {
    await loadShutters();
  }
  const byHome = new Map();
  for (const shutter of shutters.values()) {
    if (!byHome.has(shutter.homeId)) {
      byHome.set(shutter.homeId, []);
    }
    byHome.get(shutter.homeId).push({
      id: shutter.moduleId,
      ...(shutter.bridgeId ? { bridge: shutter.bridgeId } : {}),
      target_position: NETATMO_POSITION.PREFERRED,
    });
  }
  for (const [homeId, modules] of byHome) {
    await netatmo.setState(homeId, modules);
  }
  schedulePostCommandRefresh();
  return {
    en: `Preferred position sent to ${shutters.size} shutter(s).`,
    fr: `Position préférée envoyée à ${shutters.size} volet(s).`,
  };
});

// --- Cycle de vie -----------------------------------------------------------

gladys.handleShutdown(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pendingRefreshTimers.forEach((timer) => clearTimeout(timer));
  pendingRefreshTimers.clear();
});

await gladys.connect();
await applyConfig(await gladys.getConfig());
logger.info('Intégration Netatmo iDiamant démarrée');
