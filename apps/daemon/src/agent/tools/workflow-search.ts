import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

import type { WorkflowDto, WorkflowStatus } from '@computer-history/protocol';

export interface WorkflowSearchPort {
  searchWorkflows(filters: {
    query?: string;
    status?: WorkflowStatus;
    limit?: number;
  }): WorkflowDto[];
}

/**
 * workflow_search custom tool (spec §3.19): mined repeating procedures.
 * Backed by LIKE matching over name/purpose (documented deviation — no
 * workflows_fts table exists; see workflows-repository.ts).
 */
export function createWorkflowSearchTool(port: WorkflowSearchPort) {
  return defineTool({
    name: 'workflow_search',
    label: 'Search workflows',
    description:
      'Search detected recurring workflows (mined procedures with stable step patterns). ' +
      'Query matches workflow name/purpose case-insensitively.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: 'Substring of workflow name or purpose', maxLength: 512 })),
      status: Type.Optional(
        Type.Union([Type.Literal('candidate'), Type.Literal('confirmed'), Type.Literal('rejected')]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (_toolCallId, params) => {
      const result = port.searchWorkflows({
        query: params.query,
        status: params.status,
        limit: params.limit,
      });
      const text = JSON.stringify({ workflows: result });
      return { content: [{ type: 'text', text }], details: result };
    },
  });
}
