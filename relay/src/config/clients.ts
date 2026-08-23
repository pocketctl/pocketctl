/**
 * OAuth 2.0 Client Registry
 *
 * Hardcoded first-party clients for the minimal OAuth Device Flow.
 * When third-party client support is needed, this becomes a database table
 * with these entries as seed data.
 */

export interface ClientConfig {
  name: string;
  grant_types: string[];
  redirect_uris?: string[];
  scope: string;
  token_endpoint_auth_method: 'none';
}

export const CLIENTS: Record<string, ClientConfig> = {
  'pocketctl-cli': {
    name: 'pocketctl CLI',
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none',
  },
  'pocketctl-web': {
    name: 'pocketctl Web',
    grant_types: ['authorization_code'],
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none',
  },
  'pocketctl-ios': {
    name: 'pocketctl iOS',
    grant_types: ['authorization_code'],
    redirect_uris: ['pocketctl://oauth/callback'],
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none',
  },
};

export function getClient(clientId: string): ClientConfig | undefined {
  return CLIENTS[clientId];
}

export function validateClient(clientId: string): ClientConfig | null {
  const client = CLIENTS[clientId];
  if (!client) return null;
  return client;
}
