import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync, type ChromaFixtureDocument } from '../../../src/services/sync/ChromaSync.js';
import { chromaSourceHash } from '../../../src/services/sync/ChromaIndexPolicy.js';

describe('Chroma fixture audit and reconciliation', () => {
  it('reports quarantined documents then removes them and upgrades clean legacy metadata', async () => {
    const store = new SessionStore(new Database(':memory:'));
    store.recordChromaIndexPolicy('observation', 1, 'a'.repeat(64), ['pem']);
    const sessionId = store.createSDKSession('content-2', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-2');
    store.storeObservation('memory-2', 'project', {
      type: 'discovery', title: 'clean', subtitle: null, facts: [], narrative: 'clean',
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const observation = store.storeObservation('memory-2', 'project', {
      type: 'discovery', title: 'clean 2', subtitle: null, facts: [], narrative: 'clean 2',
      concepts: [], files_read: [], files_modified: [],
    }, 2);
    const sync = new ChromaSync('fixture', store);
    let docs: ChromaFixtureDocument[] = [
      { id: 'obs_1_text', metadata: { doc_type: 'observation', sqlite_id: 1, source_table: 'observations', project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local', content_sha256: 'a'.repeat(64) } },
      { id: 'obs_2_text', metadata: { doc_type: 'observation', sqlite_id: observation.id } },
    ];
    const deleted: string[][] = [];
    const updated: Array<{ ids: string[]; metadatas: Record<string, unknown>[] }> = [];
    const adapter = {
      list: async () => docs,
      delete: async (ids: string[]) => {
        deleted.push(ids);
        docs = docs.filter(doc => !ids.includes(doc.id));
      },
      update: async (ids: string[], metadatas: Record<string, unknown>[]) => {
        updated.push({ ids, metadatas });
        docs = docs.map(doc => {
          const index = ids.indexOf(doc.id);
          return index === -1 ? doc : { ...doc, metadata: metadatas[index] };
        });
      },
    };

    expect((await sync.auditIndex(adapter)).map(doc => doc.id)).toEqual(['obs_1_text', 'obs_2_text']);
    expect(await sync.reconcileIndex(adapter)).toEqual({ deleted: 1, updated: 1 });
    expect(deleted).toEqual([['obs_1_text']]);
    expect(updated[0].metadatas[0]).toMatchObject({
      source_table: 'observations', project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local',
    });
    expect(store.getChromaSourceStatus('observation', observation.id)).toBe('clean');
    expect(await sync.auditIndex(adapter)).toEqual([]);
    expect(await sync.reconcileIndex(adapter)).toEqual({ deleted: 0, updated: 0 });
  });

  it('does not promote a quarantined revision when a later revision is clean', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory');
    const observation = store.storeObservation('memory', 'project', {
      type: 'discovery', title: 'clean', subtitle: null, facts: [], narrative: 'clean',
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const current = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(observation.id);
    const cleanHash = chromaSourceHash(current);
    const quarantinedHash = 'a'.repeat(64);
    store.recordChromaIndexPolicy('observation', observation.id, quarantinedHash, ['pem']);
    store.recordChromaIndexPolicy('observation', observation.id, cleanHash, []);

    let docs: ChromaFixtureDocument[] = [{
      id: `obs_${observation.id}_text`,
      metadata: {
        doc_type: 'observation', sqlite_id: observation.id, source_table: 'observations',
        project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local',
        content_sha256: quarantinedHash,
      },
    }];
    const sync = new ChromaSync('fixture', store);
    const adapter = {
      list: async () => docs,
      delete: async (ids: string[]) => { docs = docs.filter(doc => !ids.includes(doc.id)); },
      update: async () => {},
    };

    expect((await sync.auditIndex(adapter)).map(doc => doc.id)).toEqual([`obs_${observation.id}_text`]);
    expect(await sync.reconcileIndex(adapter)).toEqual({ deleted: 1, updated: 0 });
    expect(await sync.auditIndex(adapter)).toEqual([]);
  });

  it('reports a clean historical vector when the current source revision is quarantined', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory');
    const observation = store.storeObservation('memory', 'project', {
      type: 'discovery', title: 'clean', subtitle: null, facts: [], narrative: 'clean',
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const current = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(observation.id);
    const cleanHash = chromaSourceHash(current);
    store.recordChromaIndexPolicy('observation', observation.id, cleanHash, []);
    store.db.prepare('UPDATE observations SET narrative = ? WHERE id = ?')
      .run('Authorization: Bearer current-secret', observation.id);
    const quarantined = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(observation.id);
    store.recordChromaIndexPolicy('observation', observation.id, chromaSourceHash(quarantined), ['bearer_token']);
    const sync = new ChromaSync('fixture', store);
    let docs: ChromaFixtureDocument[] = [{
      id: `obs_${observation.id}_narrative`,
      metadata: {
        doc_type: 'observation', sqlite_id: observation.id, source_table: 'observations',
        project: 'project', platform_source: 'claude', sensitivity: 'private', acl: 'owner_local',
        content_sha256: cleanHash,
      },
    }];
    const adapter = {
      list: async () => docs,
      delete: async (ids: string[]) => { docs = docs.filter(doc => !ids.includes(doc.id)); },
      update: async () => {},
    };

    expect((await sync.auditIndex(adapter)).map(doc => doc.id)).toEqual([`obs_${observation.id}_narrative`]);
    expect(await sync.reconcileIndex(adapter)).toEqual({ deleted: 1, updated: 0 });
  });
});
