import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createReleaseSigner, registerDaemonReleaseDownloads } from '../daemon-release-download.js';

const path = '/releases/v0.5.22/pocketctl_darwin_arm64';

it('returns a bodyless, uncached OSS V4 redirect for the requested method and release asset', async () => {
  const app = Fastify();
  const provider = { getCredentials: async () => ({
    accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret', securityToken: 'fixture-token', providerName: 'fixture',
  }) };
  const signer = vi.fn(createReleaseSigner(provider));
  registerDaemonReleaseDownloads(app, signer);
  try {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: path + '?untrusted=ignored' });
      expect(res.statusCode).toBe(302);
      expect(res.body).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
      const url = new URL(String(res.headers.location));
      expect(url.origin).toBe('https://pocketctl-daemon.oss-cn-beijing.aliyuncs.com');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get('x-oss-expires')).toBe('600');
      expect(url.searchParams.get('x-oss-security-token')).toBe('fixture-token');
      expect(url.searchParams.get('x-oss-signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.has('untrusted')).toBe(false);
      expect(signer).toHaveBeenLastCalledWith(method, path.slice(1));
    }
    for (const invalid of ['/releases/latest/pocketctl_linux_arm64', '/releases/v0.5.22/private.txt',
      '/releases/v0.5.22/pocketctl_linux_arm64%2Fprivate', '/releases/v0.5.22/pocketctl_linux_arm64%0A']) {
      expect((await app.inject(invalid)).statusCode).toBe(404);
    }
    expect(signer).toHaveBeenCalledTimes(2);
    for (const name of ['pocketctl_linux_amd64.sha256', 'release-candidate-manifest.json']) {
      expect((await app.inject('/releases/v1.2.3-rc1/' + name)).statusCode).toBe(302);
    }
  } finally {
    await app.close();
  }
});

it('does not disclose credential errors or a download location when signing fails', async () => {
  const app = Fastify();
  registerDaemonReleaseDownloads(app, async () => { throw new Error('private credential failure'); });
  try {
    const res = await app.inject(path);
    expect(res.statusCode).toBe(503);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toBe('');
  } finally {
    await app.close();
  }
});
