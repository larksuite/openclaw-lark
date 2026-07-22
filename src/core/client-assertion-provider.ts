// Maps a Feishu account's keyless config (authMethod / keyRef) to a client
// assertion provider backed by the lark-keyless-signer (core/keyless-signer).
//
// The node-sdk calls retrieveToken(aud) for every token exchange. The provider
// delegates to the platform signer so no app secret or private-key material
// enters this process.
import { KeylessSigner, type KeylessSignerOptions } from './keyless-signer';

export type AuthMethod = 'app_secret' | 'private_key_jwt';

/** Minimal account shape this module reads; a subset of FeishuAccountConfig. */
export interface AccountAuthConfig {
  appId?: string;
  authMethod?: AuthMethod;
  keyRef?: string;
}

/** Effective auth method for an account; defaults to "app_secret". */
export function resolveAuthMethod(account: AccountAuthConfig): AuthMethod {
  return account.authMethod === 'private_key_jwt' ? 'private_key_jwt' : 'app_secret';
}

/** Whether the account is configured for keyless (private_key_jwt) auth. */
export function isKeyless(account: AccountAuthConfig): boolean {
  return resolveAuthMethod(account) === 'private_key_jwt';
}

/** Produces short-lived client assertions for the token endpoint. */
export interface ClientAssertionProvider {
  /** Mint a client_assertion for the SDK's requested token endpoint audience. */
  retrieveToken(aud: string): Promise<{ value: string }>;
}

/**
 * Build a client assertion provider for a configured keyless account, or return
 * null when the account is not keyless or has no appId. Construction never
 * resolves or starts the signer; provider verification and subprocess errors
 * surface when the SDK requests an assertion. The platform optional dependency
 * is resolved and rechecked for every call, and never falls back to app_secret.
 */
export function createClientAssertionProvider(
  account: AccountAuthConfig,
  opts: Pick<KeylessSignerOptions, 'binaryPath'> = {},
): ClientAssertionProvider | null {
  if (!isKeyless(account) || !account.appId) return null;
  const signer = new KeylessSigner({ binaryPath: opts.binaryPath, keyRef: account.keyRef });
  return {
    retrieveToken: async (aud) => ({ value: await signer.signAssertion(account.appId!, aud) }),
  };
}
