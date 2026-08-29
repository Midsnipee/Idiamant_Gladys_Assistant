import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES, DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';

import { SHUTTER_MODULE_TYPES } from './netatmo.js';

// Valeurs de la fonctionnalité shutter/state du cœur de Gladys (COVER_STATE).
export const COVER_STATE = {
  CLOSE: -1,
  STOP: 0,
  OPEN: 1,
};

// Valeurs acceptées par target_position côté Netatmo.
export const NETATMO_POSITION = {
  CLOSED: 0,
  OPEN: 100,
  STOP: -1,
  PREFERRED: -2,
};

export const FEATURE_KEYS = {
  STATE: 'state',
  POSITION: 'position',
  SIGNAL: 'signal',
  BATTERY: 'battery',
};

const MODULE_LABELS = {
  NBR: 'Volet roulant',
  NBO: 'Volet orientable',
  NBS: 'Volet battant',
};

/** Un id de plateforme stable et sans « : » (le séparateur des external_id). */
export const platformId = (homeId, moduleId) => `${homeId}-${moduleId.replace(/:/g, '')}`;

/** Dernier segment d'un external_id de fonctionnalité : la clé de feature. */
export const featureKeyOf = (externalId) => externalId.split(':').pop();

/** Avant-dernier segment : le platformId, qui identifie le volet. */
export const platformIdOf = (externalId) => {
  const parts = externalId.split(':');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
};

export const isShutterModule = (module) => SHUTTER_MODULE_TYPES.includes(module.type);

/**
 * Netatmo renvoie un rf_strength où *plus bas = meilleur* (≈60 excellent,
 * ≈90 limite). Gladys attend une qualité croissante en pourcentage, donc on
 * inverse l'échelle plutôt que d'afficher un chiffre qui se lit à l'envers.
 */
export const rfStrengthToQuality = (rfStrength) => {
  if (typeof rfStrength !== 'number') {
    return null;
  }
  const quality = ((90 - rfStrength) / 30) * 100;
  return Math.max(0, Math.min(100, Math.round(quality)));
};

/**
 * Construit un appareil Gladys à partir d'un module Netatmo.
 *
 * `status` est l'entrée correspondante de /homestatus quand on l'a : elle sert
 * uniquement à décider si le volet remonte une batterie, ce que /homesdata ne
 * dit pas. Les fonctionnalités déclarées doivent refléter le matériel réel,
 * pas le catalogue théorique.
 */
export const buildDevice = ({ gladys, module, home, room, status }) => {
  const ids = gladys.externalIds('shutter', platformId(home.id, module.id));
  const label = MODULE_LABELS[module.type] || 'Volet';
  const name = module.name || (room && room.name ? `${label} ${room.name}` : `${label} ${module.id}`);

  const features = [
    {
      name: 'Ouverture / Fermeture',
      external_id: ids.feature(FEATURE_KEYS.STATE),
      category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
      type: DEVICE_FEATURE_TYPES.SHUTTER.STATE,
      min: COVER_STATE.CLOSE,
      max: COVER_STATE.OPEN,
      read_only: false,
      has_feedback: true,
      keep_history: false,
    },
    {
      name: 'Position',
      external_id: ids.feature(FEATURE_KEYS.POSITION),
      category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
      type: DEVICE_FEATURE_TYPES.SHUTTER.POSITION,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Qualité du signal',
      external_id: ids.feature(FEATURE_KEYS.SIGNAL),
      category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
      type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: true,
      keep_history: false,
    },
  ];

  if (status && typeof status.battery_level === 'number') {
    features.push({
      name: 'Batterie',
      external_id: ids.feature(FEATURE_KEYS.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    });
  }

  return {
    name,
    external_id: ids.device,
    features,
    params: [
      { name: 'NETATMO_HOME_ID', value: home.id },
      { name: 'NETATMO_MODULE_ID', value: module.id },
      { name: 'NETATMO_BRIDGE_ID', value: module.bridge || '' },
      { name: 'NETATMO_MODULE_TYPE', value: module.type },
      { name: 'NETATMO_ROOM', value: room && room.name ? room.name : '' },
    ],
  };
};

/**
 * Position Netatmo -> état shutter Gladys. Entre les deux butées, le volet est
 * ni ouvert ni fermé : STOP est la seule valeur honnête de l'énumération.
 */
export const positionToCoverState = (position) => {
  if (position >= 100) {
    return COVER_STATE.OPEN;
  }
  if (position <= 0) {
    return COVER_STATE.CLOSE;
  }
  return COVER_STATE.STOP;
};

/** Commande shutter/state de Gladys -> target_position Netatmo. */
export const coverStateToTargetPosition = (value) => {
  if (value === COVER_STATE.OPEN) {
    return NETATMO_POSITION.OPEN;
  }
  if (value === COVER_STATE.CLOSE) {
    return NETATMO_POSITION.CLOSED;
  }
  return NETATMO_POSITION.STOP;
};
