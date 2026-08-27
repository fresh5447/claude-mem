import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
let observationMetadata: Record<string, unknown> = { sqlite_id: 9, doc_type: 'observation' };
let adoptedObservation = false;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'chroma_create_collection') return {};

        if (name === 'chroma_get_documents') {
          const where = args.where as { $and?: Array<Record<string, unknown>> };
          const docType = where.$and?.find(condition => condition.doc_type)?.doc_type;
          if (docType === 'observation') {
            return {
              ids: ['obs_9_narrative'],
              metadatas: [observationMetadata]
            };
          }
          if (docType === 'session_summary') {
            return {
              ids: ['summary_7_request'],
              metadatas: [{ sqlite_id: 7, doc_type: 'session_summary' }]
            };
          }
          return {
            ids: ['prompt_7'],
            metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt' }]
          };
        }

        return {};
      }
    })
  }
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { chromaSourceHash } from '../../../src/services/sync/ChromaIndexPolicy.js';

function newSync(): ChromaSync {
  const store = {
    db: {
      prepare: (sql: string) => ({
        get: (id: number) => sql.includes('SELECT *')
          ? { id, project: 'original', narrative: 'safe', ...(adoptedObservation ? { merged_into_project: 'parent' } : {}) }
          : { project: 'original', platform_source: 'claude' },
      }),
    },
    recordChromaIndexPolicy: () => {},
    getChromaSourceStatus: () => null,
    getChromaIndexStatus: () => 'clean',
  };
  return new ChromaSync('claude-mem', store as any);
}

afterEach(() => {
  calls.length = 0;
  observationMetadata = { sqlite_id: 9, doc_type: 'observation' };
  adoptedObservation = false;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

describe('ChromaSync merged project hydration', () => {
  it('patches session-summary documents for summary-only adoption', async () => {
    await newSync().updateMergedIntoProject(
      [{ docType: 'session_summary', sqliteId: 7 }],
      'parent'
    );

    const getCall = calls.find(call => call.name === 'chroma_get_documents');
    expect(getCall?.args.where).toEqual({
      $and: [
        { doc_type: 'session_summary' },
        { sqlite_id: { $in: [7] } }
      ]
    });

    const updateCall = calls.find(call => call.name === 'chroma_update_documents');
    expect(updateCall?.args.ids).toEqual(['summary_7_request']);
    expect(updateCall?.args.metadatas).toEqual([{
      sqlite_id: 7,
      doc_type: 'session_summary',
      source_table: 'session_summaries',
      project: 'original',
      platform_source: 'claude',
      sensitivity: 'private',
      acl: 'owner_local',
      content_sha256: chromaSourceHash({ id: 7, project: 'original', narrative: 'safe' }),
      merged_into_project: 'parent'
    }]);
  });

  it('does not update a prompt document with a colliding sqlite ID', async () => {
    await newSync().updateMergedIntoProject(
      [{ docType: 'session_summary', sqliteId: 7 }],
      'parent'
    );

    expect(calls.filter(call => call.name === 'chroma_update_documents')).toHaveLength(1);
    expect(calls.find(call => call.name === 'chroma_update_documents')?.args.ids)
      .toEqual(['summary_7_request']);
  });

  it('patches observation documents with an observation-typed lookup', async () => {
    await newSync().updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 9 }],
      'parent'
    );

    const getCall = calls.find(call => call.name === 'chroma_get_documents');
    expect(getCall?.args.where).toEqual({
      $and: [
        { doc_type: 'observation' },
        { sqlite_id: { $in: [9] } }
      ]
    });

    const updateCall = calls.find(call => call.name === 'chroma_update_documents');
    expect(updateCall?.args.ids).toEqual(['obs_9_narrative']);
    expect(updateCall?.args.metadatas).toEqual([{
      sqlite_id: 9,
      doc_type: 'observation',
      source_table: 'observations',
      project: 'original',
      platform_source: 'claude',
      sensitivity: 'private',
      acl: 'owner_local',
      content_sha256: chromaSourceHash({ id: 9, project: 'original', narrative: 'safe' }),
      merged_into_project: 'parent'
    }]);
  });

  it('reindexes an adopted current vector when its complete-row hash changes', async () => {
    observationMetadata = {
      sqlite_id: 9,
      doc_type: 'observation',
      content_sha256: chromaSourceHash({ id: 9, project: 'original', narrative: 'safe', merged_into_project: null }),
      source_table: 'observations',
      project: 'original',
      platform_source: 'claude',
      sensitivity: 'private',
      acl: 'owner_local',
    };
    adoptedObservation = true;

    await newSync().updateMergedIntoProject([{ docType: 'observation', sqliteId: 9 }], 'parent');

    expect(calls.some(call => call.name === 'chroma_delete_documents')).toBe(false);
    const freshWrite = calls.find(call => call.name === 'chroma_add_documents');
    expect(freshWrite?.args.ids).toEqual(['obs_9_narrative']);
    expect((freshWrite?.args.metadatas as Array<Record<string, unknown>>)[0].merged_into_project).toBe('parent');
  });
});
