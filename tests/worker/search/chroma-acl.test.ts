import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { isOwnerLocalPrivateMetadata } from '../../../src/services/sync/ChromaIndexPolicy.js';
import { PaginationHelper } from '../../../src/services/worker/PaginationHelper.js';

describe('Chroma ACL predicate', () => {
  it('fails closed for missing or unknown policy metadata', () => {
    expect(isOwnerLocalPrivateMetadata({ doc_type: 'observation', source_table: 'observations', sqlite_id: 1 })).toBe(false);
    expect(isOwnerLocalPrivateMetadata({ doc_type: 'observation', source_table: 'observations', sqlite_id: 1, sensitivity: 'private', acl: 'shared' })).toBe(false);
    expect(isOwnerLocalPrivateMetadata({ doc_type: 'observation', source_table: 'observations', sqlite_id: 1, sensitivity: 'private', acl: 'owner_local' })).toBe(false);
    expect(isOwnerLocalPrivateMetadata({ doc_type: 'observation', source_table: 'observations', sqlite_id: 1, project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local' })).toBe(false);
    expect(isOwnerLocalPrivateMetadata({ doc_type: 'observation', source_table: 'observations', sqlite_id: 1, project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local', content_sha256: 'a'.repeat(64) })).toBe(true);
  });

  it('rejects a metadata-valid vector when its ledger state is quarantined', () => {
    const store = new SessionStore(new Database(':memory:'));
    store.recordChromaIndexPolicy('observation', 7, 'a'.repeat(64), ['pem']);
    store.recordChromaIndexPolicy('observation', 7, 'b'.repeat(64), []);
    const sync = new ChromaSync('fixture', store) as any;
    const result = sync.deduplicateQueryResults({
      ids: [['obs_7_text']],
      metadatas: [[{ doc_type: 'observation', source_table: 'observations', sqlite_id: 7, project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local', content_sha256: 'a'.repeat(64) }]],
      distances: [[0.1]],
    });
    expect(result.ids).toEqual([]);
  });

  it('rejects a clean historical vector after a newer source revision is quarantined', () => {
    const store = new SessionStore(new Database(':memory:'));
    store.recordChromaIndexPolicy('observation', 8, 'a'.repeat(64), []);
    store.recordChromaIndexPolicy('observation', 8, 'b'.repeat(64), ['pem']);
    const sync = new ChromaSync('fixture', store) as any;
    const result = sync.deduplicateQueryResults({
      ids: [['obs_8_text']],
      metadatas: [[{ doc_type: 'observation', source_table: 'observations', sqlite_id: 8, project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local', content_sha256: 'a'.repeat(64) }]],
      distances: [[0.1]],
    });
    expect(result.ids).toEqual([]);
  });

  it('rejects metadata-valid vectors when the source policy store is unavailable', () => {
    const sync = new ChromaSync('fixture') as any;
    const result = sync.deduplicateQueryResults({
      ids: [['obs_7_text']],
      metadatas: [[{ doc_type: 'observation', source_table: 'observations', sqlite_id: 7, project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local', content_sha256: 'a'.repeat(64) }]],
      distances: [[0.1]],
    });
    expect(result.ids).toEqual([]);
  });

  it('fails closed in project-scoped observation pagination', () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory');
    const insert = (title: string) => store.storeObservation('memory', 'project', {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title,
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const clean = insert('clean');
    const quarantined = insert('quarantined');
    insert('unknown');
    store.recordChromaIndexPolicy('observation', clean.id, 'a'.repeat(64), []);
    store.recordChromaIndexPolicy('observation', quarantined.id, 'b'.repeat(64), ['pem']);

    const helper = new PaginationHelper({ getSessionStore: () => store } as any);
    expect(helper.getObservations(0, 10, 'project').items.map(row => row.id)).toEqual([clean.id]);
  });
});
