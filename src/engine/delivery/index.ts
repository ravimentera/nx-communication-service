export {
  ChannelConfigService,
  type AgentChannelConfig,
  type TenantChannelConfig,
} from './channel-config.service.js';
export {
  type CredentialMapper,
  type CredentialMappers,
  type EnvChannelCredentials,
  type MappedCredential,
} from './credential-mapper.js';
export {
  ChannelNotConfiguredError,
  CredentialResolver,
  type ResolveScope,
} from './credential-resolver.js';
export {
  Dispatcher,
  type DispatchResult,
  type DispatcherDeps,
  type OutboundMessage,
} from './dispatcher.js';
export {
  BullEventQueue,
  createStubEventProcessor,
  DisabledEventQueue,
  type EventProcessor,
  type EventQueue,
  type OutreachEventJob,
} from './event-processing-queue.js';
export {
  BullNotificationQueue,
  DisabledNotificationQueue,
  QUEUE_NAMES,
  type EnqueueResult,
  type NotificationQueue,
  type QueueRetryConfig,
  type SendJob,
} from './notification-queue.js';
export { createResultRecorder } from './record-result.js';
export { InMemoryChannelRegistry } from './registry.js';
