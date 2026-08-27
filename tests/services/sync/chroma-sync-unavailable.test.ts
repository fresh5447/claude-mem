import { afterAll, describe, it, expect, mock } from 'bun:test';
import { ChromaUnavailableError } from '../../../src/services/worker/search/errors.js';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

let callCount = 0;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => {
        callCount += 1;
        throw new ChromaUnavailableError('chroma-mcp connection in backoff');
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

describe('ChromaSync unavailable degradation', () => {
  it('returns without throwing when a source-gated write hits a known unavailable state', async () => {
    callCount = 0;
    const store = {
      db: {
        prepare: () => ({
          get: () => ({
            id: 1,
            content_session_id: 'content-1',
            prompt_number: 1,
            prompt_text: 'hello',
            created_at_epoch: 1,
            memory_session_id: 'mem-1',
            project: 'project',
            platform_source: 'claude',
          }),
        }),
      },
      recordChromaIndexPolicy: () => {},
      getChromaSourceStatus: () => null,
    };
    const sync = new ChromaSync('project', store as any);

    await expect(sync.syncUserPrompt(
      1,
      'mem-1',
      'project',
      'hello',
      1,
      Date.now(),
    )).resolves.toBeUndefined();

    expect(callCount).toBe(1);
  });
});
