import type { FastifyInstance } from 'fastify';
import OSS from 'ali-oss';
import { ECSRAMRoleCredentialsProvider, type CredentialsProvider } from '@alicloud/credentials';

const versionPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc[0-9]+)?$/;
const assetPattern = /^(?:pocketctl_(?:darwin|linux)_(?:amd64|arm64)(?:\.sha256)?|release-candidate-manifest\.json)$/;

function signRelease(method: 'GET' | 'HEAD', key: string, accessKeyId: string, accessKeySecret: string, stsToken?: string) {
  const oss = new OSS({
    accessKeyId, accessKeySecret, region: 'oss-cn-beijing', bucket: 'pocketctl-daemon', secure: true, authorizationV4: true,
    ...(stsToken && { stsToken, refreshSTSToken: async () => ({ accessKeyId, accessKeySecret, stsToken }) }),
  });
  // The SDK signs the verb verbatim. Its external typings omit HEAD.
  return oss.signatureUrlV4(method as OSS.HTTPMethods, 600, {}, key);
}

export function createReleaseSigner(provider: Pick<CredentialsProvider, 'getCredentials'>) {
  return async (method: 'GET' | 'HEAD', key: string) => {
    // Take one snapshot for the whole signature, including during role rotation.
    const { accessKeyId, accessKeySecret, securityToken } = await provider.getCredentials();
    if (!securityToken) throw new Error('Missing release reader session token');
    return signRelease(method, key, accessKeyId, accessKeySecret, securityToken);
  };
}

export function registerDaemonReleaseDownloads(app: FastifyInstance, sign = configuredReleaseSigner()) {
  app.get<{ Params: { version: string; asset: string } }>('/releases/:version/:asset', async (request, reply) => {
    const { version, asset } = request.params;
    reply.header('Cache-Control', 'no-store');
    if (!sign || !versionPattern.test(version) || !assetPattern.test(asset)) {
      return reply.code(404).send();
    }
    try {
      const location = await sign(request.method === 'HEAD' ? 'HEAD' : 'GET', `releases/${version}/${asset}`);
      return reply.code(302).header('Location', location).send();
    } catch {
      request.log.warn('Unable to sign daemon release download');
      return reply.code(503).send();
    }
  });
}

function configuredReleaseSigner() {
  const accessKeyId = process.env.POCKETCTL_RELEASE_OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.POCKETCTL_RELEASE_OSS_ACCESS_KEY_SECRET?.trim();
  if (accessKeyId || accessKeySecret) {
    if (!accessKeyId || !accessKeySecret) return undefined;
    return (method: 'GET' | 'HEAD', key: string) => signRelease(method, key, accessKeyId, accessKeySecret);
  }

  const role = process.env.POCKETCTL_RELEASE_OSS_READ_ROLE?.trim();
  if (!role) return undefined;
  const provider = ECSRAMRoleCredentialsProvider.builder()
    .withRoleName(role)
    .withDisableIMDSv1(true)
    .build();
  return createReleaseSigner(provider);
}
