/**
 * The seven tools tera-orchestrator knows about.
 *
 * **These names are a contract.** `service-mcp-tools.ts:116` prefixes them
 * `comm_` and lists `sendEmail`/`sendSMS`/`sendSlack` as mutation tools, which
 * is what gates them behind a confirmation in the orchestrator. Renaming one
 * silently removes that gate. New tools (`generateDraft`, `listPendingApprovals`,
 * `approveMessage`) arrive in P12, not here.
 *
 * The schemas are the source's, with two corrections:
 *
 *  - **`medspaId` is gone from every input schema.** The source advertises it
 *    as a parameter and then overrides whatever the caller sends with the
 *    `x-medspa-id` header (`mcp/index.ts:70-80`) — a fix for a real
 *    cross-tenant send. Advertising a parameter that is ignored invites a
 *    caller to rely on it; the tenant comes from the request, always.
 *  - `sendEmail` gains `message`, because the source's schema offers only
 *    `templateId` + `variables` and the underlying send accepts either.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const PRIORITY = {
  type: 'string',
  description: 'Priority of the message',
  enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'sendEmail',
    description: 'Send an email message to a recipient',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email address of the recipient' },
        subject: { type: 'string', description: 'Subject of the email' },
        message: { type: 'string', description: 'Body, when not using a template' },
        templateId: { type: 'string', description: 'Template id or key to render' },
        variables: { type: 'object', description: 'Variables to populate the template with' },
        providerId: { type: 'string', description: 'Provider sending on behalf of' },
        priority: PRIORITY,
      },
      required: ['to'],
    },
  },
  {
    name: 'sendSMS',
    description: 'Send an SMS message to a phone number',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Phone number of the recipient (with country code, e.g., +1234567890)',
        },
        message: { type: 'string', description: 'SMS message content' },
        templateId: { type: 'string', description: 'Optional template id or key' },
        variables: { type: 'object', description: 'Variables to populate the template with' },
        providerId: {
          type: 'string',
          description: 'Provider ID for provider-specific phone numbers',
        },
        priority: PRIORITY,
      },
      required: ['to'],
    },
  },
  {
    name: 'sendSlackMessage',
    description: 'Send a message to a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel to send the message to' },
        text: { type: 'string', description: 'Message content' },
        blocks: { type: 'array', description: 'Slack message blocks for rich formatting' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'sendUrgentSlackAlert',
    description: 'Send an urgent alert to Slack',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Alert title' },
        message: { type: 'string', description: 'Alert message' },
        severity: {
          type: 'string',
          description: 'Severity level of the alert',
          enum: ['low', 'medium', 'high', 'critical'],
        },
        channel: { type: 'string', description: 'Optional specific channel for the alert' },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'getQueueStatus',
    description: 'Get the status of notification queues',
    inputSchema: {
      type: 'object',
      properties: {
        queueName: { type: 'string', description: 'Optional specific queue name to check' },
      },
    },
  },
  {
    name: 'addNotificationToQueue',
    description: 'Add a notification to the queue for processing',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Type of notification',
          enum: ['EMAIL', 'SMS', 'SLACK', 'PUSH', 'WEBHOOK', 'IN_APP'],
        },
        payload: { type: 'object', description: 'Notification payload' },
        metadata: {
          type: 'object',
          description: 'Notification metadata including priority and scheduling',
          properties: {
            priority: PRIORITY,
            scheduledFor: { type: 'string' },
          },
        },
      },
      required: ['type', 'payload'],
    },
  },
  {
    name: 'clearFailedJobs',
    description: 'Clear failed jobs from the notification queue',
    inputSchema: {
      type: 'object',
      properties: {
        olderThan: {
          type: 'string',
          description: 'Clear jobs older than this timestamp (ISO format)',
        },
        limit: { type: 'number', description: 'Maximum number of jobs to clear' },
      },
    },
  },
];

export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name);
