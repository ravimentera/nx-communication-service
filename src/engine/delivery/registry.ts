import { NotFoundError } from '../../platform/http/errors.js';
import type { Channel, ChannelRegistry, ChannelType } from '../../ports/channel.js';

/**
 * The registry that replaces the dispatch switch. Populated by the composition
 * root; nothing here is a module-scope singleton.
 */
export class InMemoryChannelRegistry implements ChannelRegistry {
  private readonly channels = new Map<ChannelType, Channel>();

  register(channel: Channel): void {
    this.channels.set(channel.type, channel);
  }

  get(type: ChannelType): Channel {
    const channel = this.channels.get(type);
    if (!channel) {
      throw new NotFoundError(`No channel registered for '${type}'`, {
        registered: this.list(),
      });
    }
    return channel;
  }

  has(type: ChannelType): boolean {
    return this.channels.has(type);
  }

  list(): ChannelType[] {
    return [...this.channels.keys()].sort();
  }
}
