/**
 * Which URLs an outbound webhook may reach.
 *
 * `WebhookChannel` fetches a URL a tenant user supplies, from inside the
 * cluster, and reports the status back — so without a guard it is a
 * request-forgery gadget with the service's own network position, reachable
 * through `POST /v1/channels/test`.
 *
 * The DNS cases are the ones that matter. A literal `127.0.0.1` is the easy
 * half; a NAME that resolves to it is the half an attacker actually uses, and
 * no amount of string inspection catches that.
 */
import { assertSafeWebhookUrl, isBlockedAddress } from '../../../src/adapters/channels/url-guard.js';

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, the whole /8'],
    ['169.254.169.254', 'link-local — cloud instance metadata'],
    ['10.0.0.1', 'RFC1918'],
    ['172.16.5.4', 'RFC1918, low end'],
    ['172.31.255.255', 'RFC1918, high end'],
    ['192.168.1.1', 'RFC1918'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback — the obvious bypass'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['2606:4700:4700::1111']])(
    'allows the public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('refuses anything that is not an address at all', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertSafeWebhookUrl', () => {
  it('refuses a non-http protocol', async () => {
    const verdict = await assertSafeWebhookUrl('file:///etc/passwd');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/protocol/);
  });

  it('refuses a literal private address', async () => {
    const verdict = await assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/private or reserved/);
  });

  /**
   * The case a string check cannot see. `localhost` is an ordinary hostname
   * until it is resolved, and every managed DNS provider will happily point a
   * name an attacker controls at 127.0.0.1.
   */
  it('refuses a NAME that resolves to a private address', async () => {
    const verdict = await assertSafeWebhookUrl('https://localhost/hook');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/resolves to the private or reserved address/);
  });

  it('refuses a name that does not resolve at all', async () => {
    const verdict = await assertSafeWebhookUrl(
      'https://this-name-does-not-exist.invalid/hook',
    );
    expect(verdict.ok).toBe(false);
  });

  it('lets an explicit allow-list admit a host the default rules would block', async () => {
    // An operator who names an internal host meant it. The allow-list is
    // absolute, which is also the only complete answer to DNS rebinding.
    const verdict = await assertSafeWebhookUrl('http://localhost:9000/hook', {
      allowedHosts: ['localhost'],
    });
    expect(verdict.ok).toBe(true);
  });

  it('suffix-matches the allow-list, so a subdomain is covered', async () => {
    expect(
      (await assertSafeWebhookUrl('https://hooks.example.com/x', { allowedHosts: ['example.com'] }))
        .ok,
    ).toBe(true);

    // And does not admit a lookalike that merely ends with the same letters.
    expect(
      (await assertSafeWebhookUrl('https://notexample.com/x', { allowedHosts: ['example.com'] }))
        .ok,
    ).toBe(false);
  });

  it('honours the development escape hatch', async () => {
    const verdict = await assertSafeWebhookUrl('http://127.0.0.1:3000/hook', {
      allowPrivateAddresses: true,
    });
    expect(verdict.ok).toBe(true);
  });
});
