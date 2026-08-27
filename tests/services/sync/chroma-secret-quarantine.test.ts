import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { chromaSourceHash, detectChromaSecretFindings } from '../../../src/services/sync/ChromaIndexPolicy.js';

describe('Chroma secret quarantine policy', () => {
  it('classifies complete rows without retaining plaintext in the ledger', () => {
    const store = new SessionStore(new Database(':memory:'));
    const source = {
      title: 'otherwise harmless',
      narrative: 'Authorization: Bearer very-secret-token-value',
      facts: ['fact'],
    };
    const findings = detectChromaSecretFindings(source);
    expect(findings).toContain('bearer_token');

    store.recordChromaIndexPolicy('observation', 12, chromaSourceHash(source), findings);
    expect(store.isChromaSourceEligible('observation', 12)).toBe(false);
    const persisted = store.db.prepare('SELECT finding_kinds, content_sha256, updated_at_epoch FROM chroma_index_ledger').get() as any;
    expect(persisted.finding_kinds).toBe(JSON.stringify(['bearer_token']));
    expect(JSON.stringify(persisted)).not.toContain('very-secret-token-value');
    store.recordChromaIndexPolicy('observation', 12, chromaSourceHash(source), findings);
    expect(store.db.prepare('SELECT updated_at_epoch FROM chroma_index_ledger').get()).toEqual({ updated_at_epoch: persisted.updated_at_epoch });
  });

  it('recognizes PEM, credential JSON/YAML, and key-value forms', () => {
    expect(detectChromaSecretFindings({ body: '-----BEGIN PRIVATE KEY-----' })).toContain('pem');
    expect(detectChromaSecretFindings({ body: '-----BEGIN CERTIFICATE-----' })).toContain('pem');
    expect(detectChromaSecretFindings({ body: 'Authorization: Bearer abc123' })).toContain('bearer_token');
    expect(detectChromaSecretFindings({ body: '{"api_key":"abcdefghi"}' })).toContain('json_credential');
    expect(detectChromaSecretFindings({ body: 'client_secret: abcdefghi' })).toContain('yaml_credential');
    expect(detectChromaSecretFindings({ body: '"api_key": abcdefghi' })).toContain('yaml_credential');
    expect(detectChromaSecretFindings({ body: 'token=abcdefghi' })).toContain('key_value_credential');
  });

  it('quarantines short credential-shaped values', () => {
    expect(detectChromaSecretFindings({ body: '{"password":"x"}' })).toContain('json_credential');
    expect(detectChromaSecretFindings({ body: '{"token":123456}' })).toContain('json_credential');
    expect(detectChromaSecretFindings({ password: 1234 })).toContain('json_credential');
    expect(detectChromaSecretFindings({ body: 'password: x' })).toContain('yaml_credential');
    expect(detectChromaSecretFindings({ body: 'token=abc' })).toContain('key_value_credential');
  });

  it('refuses direct writes that bypass a complete source-row policy decision', async () => {
    const sync = new ChromaSync('fixture');
    expect(await sync.addDocuments([{
      id: 'obs_1_text', document: 'untrusted', metadata: { sqlite_id: 1, doc_type: 'observation' },
    }])).toBe(0);
  });

  it('refuses storeless public sync instead of trusting a caller-built DTO', async () => {
    const sync = new ChromaSync('fixture') as any;
    let attempted = 0;
    sync.writeDocuments = async (documents: unknown[]) => {
      attempted += documents.length;
      return documents.length;
    };

    await sync.syncUserPrompt(1, 'memory-1', 'project', 'safe-looking text', 1, Date.now());

    expect(attempted).toBe(0);
  });

  it('admits zero-document backfill rows before advancing their watermark', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content-backfill', 'fixture', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-backfill');
    const inserted = store.storeObservation('memory-backfill', 'fixture', {
      type: 'discovery', title: 'metadata-only secret', subtitle: null,
      facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
      metadata: 'Authorization: Bearer backfill-secret',
    }, 1);
    const sync = new ChromaSync('fixture') as any;
    const bumped: Array<{ kind: string; sqliteId: number }> = [];
    const originalBump = ChromaSyncState.bump;
    const originalClearPending = ChromaSyncState.clearPending;
    const originalMarkPending = ChromaSyncState.markPending;
    sync.deleteSourceDocuments = async () => {};
    (ChromaSyncState as any).bump = (_project: string, kind: string, sqliteId: number) => {
      bumped.push({ kind, sqliteId });
    };
    (ChromaSyncState as any).clearPending = () => {};
    (ChromaSyncState as any).markPending = () => {};

    try {
      await sync.backfillKind(store, [{ id: inserted.id }], () => [], 'observation', 'observations', 'fixture');
    } finally {
      (ChromaSyncState as any).bump = originalBump;
      (ChromaSyncState as any).clearPending = originalClearPending;
      (ChromaSyncState as any).markPending = originalMarkPending;
    }

    expect(store.getChromaSourceStatus('observation', inserted.id)).toBe('quarantined');
    expect(bumped).toEqual([{ kind: 'observations', sqliteId: inserted.id }]);
  });

  it('blocks every generated document when an unembedded source column contains a secret', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content-1', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-1');
    const inserted = store.storeObservation('memory-1', 'project', {
      type: 'discovery', title: 'safe title', subtitle: null, facts: ['safe fact'], narrative: 'safe narrative',
      concepts: [], files_read: [], files_modified: [], metadata: '{"api_key":"abcdefghijk"}',
    }, 1);
    const sync = new ChromaSync('project', store) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
      deleteSourceDocuments: (docType: 'observation', sqliteId: number) => Promise<void>;
    };
    let attempted = 0;
    sync.addDocuments = async documents => {
      attempted += documents.length;
      return documents.length;
    };
    sync.deleteSourceDocuments = async () => {};

    await sync.syncObservation(inserted.id, 'memory-1', 'project', {
      type: 'discovery', title: 'safe title', subtitle: null, facts: ['safe fact'], narrative: 'safe narrative',
      concepts: [], files_read: [], files_modified: [],
    }, 1, inserted.createdAtEpoch);

    expect(attempted).toBe(0);
    expect(store.getChromaSourceStatus('observation', inserted.id)).toBe('quarantined');
  });

  it('stamps every admitted document with the exact complete-row hash', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content-2', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-2');
    const inserted = store.storeObservation('memory-2', 'project', {
      type: 'discovery', title: 'safe title', subtitle: null, facts: ['safe fact'], narrative: 'safe narrative',
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const sync = new ChromaSync('project', store) as any;
    let indexed: Array<{ metadata: Record<string, unknown> }> = [];
    sync.writeDocuments = async (documents: Array<{ metadata: Record<string, unknown> }>) => {
      indexed = documents;
      return documents.length;
    };

    await sync.syncObservation(inserted.id, 'memory-2', 'project', {
      type: 'discovery', title: 'safe title', subtitle: null, facts: ['safe fact'], narrative: 'safe narrative',
      concepts: [], files_read: [], files_modified: [],
    }, 1, inserted.createdAtEpoch);

    const sourceRow = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(inserted.id);
    expect(indexed.length).toBeGreaterThan(0);
    expect(indexed.every(document => document.metadata.content_sha256 === chromaSourceHash(sourceRow))).toBe(true);
    expect(store.isChromaEmbeddingEligible('observation', inserted.id, chromaSourceHash(sourceRow))).toBe(true);
  });

  it('formats admitted documents from the persisted row, never a caller DTO', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content-3', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-3');
    const inserted = store.storeObservation('memory-3', 'project', {
      type: 'discovery', title: 'persisted title', subtitle: null, facts: ['persisted fact'], narrative: 'persisted narrative',
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    const sync = new ChromaSync('project', store) as any;
    let indexed: Array<{ document: string }> = [];
    sync.writeDocuments = async (documents: Array<{ document: string }>) => {
      indexed = documents;
      return documents.length;
    };

    await sync.syncObservation(inserted.id, 'memory-3', 'project', {
      type: 'discovery', title: 'caller title', subtitle: null, facts: [],
      narrative: 'Authorization: Bearer caller-secret', concepts: [], files_read: [], files_modified: [],
    }, 1, inserted.createdAtEpoch);

    expect(indexed.map(document => document.document)).toEqual(['persisted narrative', 'persisted fact']);
    expect(store.getChromaSourceStatus('observation', inserted.id)).toBe('clean');
  });

  it('uses persisted summaries and prompts rather than caller DTO text', async () => {
    const store = new SessionStore(new Database(':memory:'));
    const sessionId = store.createSDKSession('content-4', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-4');
    const summary = store.storeSummary('memory-4', 'project', {
      request: 'persisted request', investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1);
    const promptId = store.saveUserPrompt('content-4', 1, 'persisted prompt', sessionId);
    const sync = new ChromaSync('project', store) as any;
    const indexed: string[] = [];
    sync.writeDocuments = async (documents: Array<{ document: string }>) => {
      indexed.push(...documents.map(document => document.document));
      return documents.length;
    };

    await sync.syncSummary(summary.id, 'memory-4', 'project', {
      request: 'Authorization: Bearer caller-secret', investigated: null, learned: null,
      completed: null, next_steps: null, notes: null,
    }, 1, summary.createdAtEpoch);
    await sync.syncUserPrompt(promptId, 'memory-4', 'project', 'Authorization: Bearer caller-secret', 1, Date.now());

    expect(indexed).toEqual(['persisted request', 'persisted prompt']);
    expect(store.getChromaSourceStatus('session_summary', summary.id)).toBe('clean');
    expect(store.getChromaSourceStatus('user_prompt', promptId)).toBe('clean');
  });
});
