import { createLogger } from '@gladysassistant/integration-sdk';

const log = createLogger({ name: 'netatmo' });

export const NETATMO_BASE_URL = 'https://api.netatmo.com';

// iDiamant = passerelle Bubendorff (NBG) + volets pilotés derrière elle.
export const IDIAMANT_GATEWAY_TYPE = 'NBG';
export const SHUTTER_MODULE_TYPES = ['NBR', 'NBO', 'NBS'];

// Les deux seuls scopes nécessaires. Ne rien demander de plus : l'écran de
// consentement Netatmo liste ce qu'on demande, et un scope superflu fait peur.
export const SCOPES = ['read_bubendorff', 'write_bubendorff'];

// Marge avant expiration : on rafraîchit un peu en avance plutôt que de se
// prendre un 403 en plein milieu d'une commande de volet.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Erreur applicative Netatmo, avec le code d'erreur métier quand il existe.
 */
export class NetatmoError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'NetatmoError';
    this.status = status;
    this.code = code;
  }
}

const formBody = (params) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

/**
 * Client Netatmo Connect.
 *
 * Il ne persiste rien lui-même : `onTokens` est appelé à chaque nouveau jeu de
 * tokens, et c'est l'intégration qui les écrit via `gladys.setConfig()`. C'est
 * important côté Netatmo : le refresh_token est à usage unique et tourne à
 * chaque rafraîchissement. Perdre le nouveau, c'est devoir relier le compte.
 */
export class NetatmoClient {
  constructor({ clientId, clientSecret, accessToken, refreshToken, expiresAt, onTokens } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.expiresAt = expiresAt ? Number(expiresAt) : 0;
    this.onTokens = onTokens || (async () => {});
    this.refreshPromise = null;
  }

  setCredentials({ clientId, clientSecret }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  setTokens({ accessToken, refreshToken, expiresAt }) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.expiresAt = expiresAt || 0;
  }

  get isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  get isLinked() {
    return Boolean(this.refreshToken);
  }

  /**
   * URL d'autorisation OAuth2. `redirectUri` vient de Gladys, jamais codé en
   * dur : c'est l'URL HTTPS fixe qui renvoie ensuite vers l'instance.
   */
  buildAuthorizeUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      response_type: 'code',
    });
    return `${NETATMO_BASE_URL}/oauth2/authorize?${params.toString()}`;
  }

  async requestTokens(params) {
    const response = await fetch(`${NETATMO_BASE_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(params),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload.error_description || payload.error || `HTTP ${response.status}`;
      throw new NetatmoError(`Échec de l'échange de tokens Netatmo : ${message}`, {
        status: response.status,
        code: payload.error || null,
      });
    }

    // expires_in (documenté) / expire_in (renvoyé historiquement) : les deux existent.
    const expiresIn = Number(payload.expires_in || payload.expire_in || 10800);
    this.accessToken = payload.access_token;
    this.refreshToken = payload.refresh_token || this.refreshToken;
    this.expiresAt = Date.now() + expiresIn * 1000;

    await this.onTokens({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      token_expires_at: this.expiresAt,
    });

    return payload;
  }

  async exchangeCode(code, redirectUri) {
    return this.requestTokens({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
    });
  }

  /**
   * Rafraîchit l'access_token. Sérialisé : si trois commandes de volets partent
   * en même temps sur un token expiré, une seule requête de refresh est émise.
   * Sinon Netatmo invalide le refresh_token consommé par la course perdante.
   */
  async refreshAccessToken() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    if (!this.refreshToken) {
      throw new NetatmoError('Compte Netatmo non relié : aucun refresh_token disponible.');
    }

    this.refreshPromise = this.requestTokens({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    }).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async ensureAccessToken() {
    if (!this.accessToken || Date.now() > this.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      log.debug('Access token absent ou proche de l’expiration, rafraîchissement');
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
   * Appel authentifié. Un 401/403 déclenche un rafraîchissement et un seul
   * rejeu : au-delà, c'est le lien de compte qui est cassé, pas le token.
   */
  async request(path, { method = 'GET', query = null, body = null, retryOnAuthError = true } = {}) {
    await this.ensureAccessToken();

    const url = new URL(`${NETATMO_BASE_URL}${path}`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      });
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));

    if ((response.status === 401 || response.status === 403) && retryOnAuthError) {
      log.warn(`Netatmo a répondu ${response.status}, tentative de rafraîchissement du token`);
      await this.refreshAccessToken();
      return this.request(path, { method, query, body, retryOnAuthError: false });
    }

    if (!response.ok || payload.error) {
      const error = payload.error || {};
      const message = error.message || error.error_description || error || `HTTP ${response.status}`;
      throw new NetatmoError(`Netatmo ${path} : ${message}`, {
        status: response.status,
        code: error.code || null,
      });
    }

    return payload.body !== undefined ? payload.body : payload;
  }

  /** Topologie : maisons, pièces, passerelles et volets déclarés. */
  async getHomesData() {
    return this.request('/api/homesdata', { query: { gateway_types: IDIAMANT_GATEWAY_TYPE } });
  }

  /** État courant : positions, joignabilité, firmware, signal. */
  async getHomeStatus(homeId) {
    return this.request('/api/homestatus', {
      query: { home_id: homeId, device_types: IDIAMANT_GATEWAY_TYPE },
    });
  }

  /**
   * Écriture. `modules` est un tableau `{ id, bridge, target_position }`.
   * target_position : 0 = fermé, 100 = ouvert, -1 = stop, -2 = position préférée.
   */
  async setState(homeId, modules) {
    return this.request('/api/setstate', {
      method: 'POST',
      body: { home: { id: homeId, modules } },
    });
  }
}
