import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getAttachmentInput = {
  sys_id: z.string().describe('The attachment sys_id (from sys_attachment).'),
};

export interface GetAttachmentTool {
  name: 'get_attachment';
  description: string;
  inputShape: typeof getAttachmentInput;
  handler(input: { sys_id: string }): Promise<McpResult>;
}

export function createGetAttachmentTool(client: ServiceNowClient): GetAttachmentTool {
  return {
    name: 'get_attachment',
    description:
      'Download a ServiceNow attachment by sys_id. Returns metadata plus base64-encoded content.',
    inputShape: getAttachmentInput,
    handler: (input) => runTool(() => client.attachment.getAttachment(input.sys_id)),
  };
}
