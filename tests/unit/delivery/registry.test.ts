import { InMemoryChannelRegistry } from '../../../src/engine/delivery/registry.js';
import { NotFoundError } from '../../../src/platform/http/errors.js';
import type { Channel, ChannelType } from '../../../src/ports/channel.js';

function stubChannel(type: ChannelType): Channel {
  return {
    type,
    capabilities: {
      subject: false,
      html: false,
      attachments: false,
      supportsDeliveryReceipts: false,
    },
    validate: () => ({ ok: true }),
    send: async () => ({ success: true }),
  };
}

describe('InMemoryChannelRegistry', () => {
  it('throws NotFoundError for an unregistered channel', () => {
    const registry = new InMemoryChannelRegistry();
    expect(() => registry.get('email')).toThrow(NotFoundError);
  });

  it('names the registered channels in the error, so the failure is diagnosable', () => {
    const registry = new InMemoryChannelRegistry();
    registry.register(stubChannel('sms'));
    try {
      registry.get('email');
      fail('expected a throw');
    } catch (error) {
      expect((error as NotFoundError).details).toEqual({ registered: ['sms'] });
    }
  });

  it('returns the registered channel', () => {
    const registry = new InMemoryChannelRegistry();
    const sms = stubChannel('sms');
    registry.register(sms);
    expect(registry.get('sms')).toBe(sms);
    expect(registry.has('sms')).toBe(true);
    expect(registry.has('email')).toBe(false);
  });

  it('lists every registered channel', () => {
    const registry = new InMemoryChannelRegistry();
    registry.register(stubChannel('sms'));
    registry.register(stubChannel('email'));
    registry.register(stubChannel('slack'));
    expect(registry.list()).toEqual(['email', 'slack', 'sms']);
  });

  it('lets a later registration replace an earlier one for the same type', () => {
    // SendGrid and SMTP both claim 'email'; the factory registers exactly one.
    const registry = new InMemoryChannelRegistry();
    const first = stubChannel('email');
    const second = stubChannel('email');
    registry.register(first);
    registry.register(second);
    expect(registry.get('email')).toBe(second);
    expect(registry.list()).toEqual(['email']);
  });
});
