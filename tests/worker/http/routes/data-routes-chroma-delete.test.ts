import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

describe('Chroma deletion ledger', () => {
  it('keeps only a metadata-only tombstone and prevents re-index eligibility', () => {
    const store = new SessionStore(new Database(':memory:'));
    store.recordChromaIndexPolicy('session_summary', 42, 'a'.repeat(64), []);
    store.markChromaSourceDeleted('session_summary', 42);
    const row = store.db.prepare(`SELECT status, content_sha256, finding_kinds, deleted_at_epoch
      FROM chroma_index_ledger WHERE doc_type = 'session_summary' AND sqlite_id = 42`).get() as any;
    expect(row).toMatchObject({ status: 'deleted', content_sha256: '0'.repeat(64), finding_kinds: '[]' });
    expect(row.deleted_at_epoch).toEqual(expect.any(Number));
    expect(store.isChromaSourceEligible('session_summary', 42)).toBe(false);
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM chroma_index_ledger
      WHERE doc_type = 'session_summary' AND sqlite_id = 42`).get()).toEqual({ count: 1 });
  });

  it('deletes the exact Chroma source after atomically recording its tombstone', async () => {
    const store = new SessionStore(new Database(':memory:'));
    store.db.prepare(`INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('content-delete', 'memory-delete', 'project', '2026-01-01T00:00:00.000Z', 1, 'completed')`).run();
    store.db.prepare(`INSERT INTO session_summaries
      (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('memory-delete', 'project', 'delete me', '2026-01-01T00:00:00.000Z', 1)`).run();
    const deleted: Array<[string, number]> = [];
    const routes = new DataRoutes(
      {} as any,
      {
        getSessionStore: () => store,
        getCloudSync: () => null,
        getChromaSync: () => ({
          deleteSource: async (docType: string, sqliteId: number) => { deleted.push([docType, sqliteId]); },
        }),
      } as any,
      {} as any, {} as any, {} as any, Date.now(),
    );
    let status = 200;
    let body: unknown;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; },
    } as any;

    await (routes as any).deleteSyncedContent({ params: { id: '1' } }, response, 'summary', 'session_summaries');

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, id: '1', kind: 'summary' });
    expect(deleted).toEqual([['session_summary', 1]]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM session_summaries').get()).toEqual({ count: 0 });
    expect(store.getChromaSourceStatus('session_summary', 1)).toBe('deleted');
  });

  it('does not delete the source while Chroma deletion is disabled', async () => {
    const store = new SessionStore(new Database(':memory:'));
    store.db.prepare(`INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('content-unavailable', 'memory-unavailable', 'project', '2026-01-01T00:00:00.000Z', 1, 'completed')`).run();
    store.db.prepare(`INSERT INTO session_summaries
      (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('memory-unavailable', 'project', 'keep me', '2026-01-01T00:00:00.000Z', 1)`).run();
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now(),
    );
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; },
    } as any;

    await (routes as any).deleteSyncedContent({ params: { id: '1' } }, response, 'summary', 'session_summaries');

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'Chroma deletion unavailable; source was not deleted' });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM session_summaries').get()).toEqual({ count: 1 });
    expect(store.getChromaSourceStatus('session_summary', 1)).toBeNull();
  });
});
