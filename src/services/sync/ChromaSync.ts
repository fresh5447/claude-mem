
import { ChromaMcpManager } from './ChromaMcpManager.js';
import { ChromaSyncState, ProjectWatermarks } from './ChromaSyncState.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
// cmem-sdk: keep SessionStore + parseFileList off the SDK's import graph.
// Both come from the SQLite layer (`bun:sqlite`). The SDK never calls the
// SQLite-only methods of ChromaSync, so a TYPE-ONLY import is sufficient —
// the value-level use (parseFileList(...)) is loaded lazily inside the
// methods that need it. Plan §3 anti-pattern: do NOT add `bun:sqlite` to
// the SDK bundle externals — fix the import chain.
import type { SessionStore as SessionStoreType } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { ChromaUnavailableError } from '../worker/search/errors.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import {
  chromaSourceHash,
  detectChromaSecretFindings,
  isChromaContentHash,
  isOwnerLocalPrivateMetadata,
  type ChromaDocType,
} from './ChromaIndexPolicy.js';
import type * as SqliteFilesModule from '../sqlite/observations/files.js';

type SessionStore = SessionStoreType;

// Lazy CJS require so tsup (used by the cmem-sdk build) does not follow
// these SQLite-coupled modules into the SDK bundle. Worker/Bun runtime
// reaches them at first call; the SDK never calls the methods that
// trigger these loads, so they never load in SDK consumers.
const lazyCreateRequire = (): ((id: string) => unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('module') as typeof import('module');
  return mod.createRequire(import.meta.url);
};

let _filesHelper: typeof SqliteFilesModule | undefined;
function loadFilesHelper(): typeof SqliteFilesModule {
  if (!_filesHelper) {
    const req = lazyCreateRequire();
    _filesHelper = req('../sqlite/observations/files.js') as typeof SqliteFilesModule;
  }
  return _filesHelper;
}

// Exported for cmem-sdk Phase 6: the SDK builds ChromaDocument values from
// Postgres observations (UUID id, content string, metadata bag) and calls
// the now-public addDocuments() to index them. Shape is unchanged.
export interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

export interface MergedIntoProjectTarget {
  docType: 'observation' | 'session_summary';
  sqliteId: number;
}

export interface ChromaFixtureDocument {
  id: string;
  metadata: Record<string, unknown>;
}

/** Small injected surface used by fixture-only audit/reconciliation tests. */
export interface ChromaIndexAdapter {
  list(): Promise<ChromaFixtureDocument[]>;
  delete(ids: string[]): Promise<void>;
  update(ids: string[], metadatas: Record<string, unknown>[]): Promise<void>;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null; 
  narrative: string | null;
  concepts: string | null; 
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
  platform_source: string;
}

export class ChromaSync {
  private project: string;
  private collectionName: string;
  private collectionCreated = false;
  private collectionCreation: Promise<void> | null = null;
  private readonly BATCH_SIZE = 100;

  constructor(project: string, private readonly sessionStore?: SessionStore) {
    this.project = project;
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');  
    this.collectionName = `cm__${sanitized || 'unknown'}`;
  }

  /** Public: cmem-sdk reuses the per-tenant collection name for raw queries. */
  public getCollectionName(): string {
    return this.collectionName;
  }

  // Public: cmem-sdk requires Chroma at construction. Plan §3 line 192.
  public async ensureCollectionExists(): Promise<void> {
    if (this.collectionCreated) {
      return;
    }

    if (!this.collectionCreation) {
      this.collectionCreation = this.createCollection().finally(() => {
        this.collectionCreation = null;
      });
    }
    await this.collectionCreation;
  }

  private async createCollection(): Promise<void> {
    const chromaMcp = ChromaMcpManager.getInstance();
    try {
      await chromaMcp.callTool('chroma_create_collection', {
        collection_name: this.collectionName
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        throw error;
      }
      // Collection already exists - this is the expected path after first creation
    }

    this.collectionCreated = true;

    logger.debug('CHROMA_SYNC', 'Collection ready', {
      collection: this.collectionName
    });
  }

  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    // parseFileList is SQLite-shaped (`bun:sqlite` in the import chain) —
    // resolve it through the deferred loader so this method stays out of
    // the SDK bundle's import graph. Plan §3.
    const filesHelper = loadFilesHelper();
    const files_read = filesHelper.parseFileList(obs.files_read);
    const files_modified = filesHelper.parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      source_table: 'observations',
      sensitivity: 'private',
      acl: 'owner_local',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      merged_into_project: obs.merged_into_project ?? null,
      platform_source: obs.platform_source
        ? normalizePlatformSource(obs.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (files_read.length > 0) {
      baseMetadata.files_read = files_read.join(',');
    }
    if (files_modified.length > 0) {
      baseMetadata.files_modified = files_modified.join(',');
    }

    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      source_table: 'session_summaries',
      sensitivity: 'private',
      acl: 'owner_local',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      merged_into_project: summary.merged_into_project ?? null,
      platform_source: summary.platform_source
        ? normalizePlatformSource(summary.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    if (summary.request) {
      documents.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      documents.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      documents.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      documents.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      documents.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      documents.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }

    return documents;
  }

  /**
   * The former storage-agnostic entry point is intentionally fail-closed.
   * Chroma writes must carry a private source row through indexSourceRow(),
   * which is the one policy boundary that has the complete row to scan.
   */
  public async addDocuments(_documents: ChromaDocument[]): Promise<number> {
    logger.warn('CHROMA_SYNC', 'Refused direct Chroma write outside the source policy gate');
    return 0;
  }

  /** Write policy-admitted documents to Chroma in BATCH_SIZE-sized batches. */
  private async writeDocuments(documents: ChromaDocument[]): Promise<number> {
    if (documents.length === 0) {
      return 0;
    }

    try {
      await this.ensureCollectionExists();
    } catch (error) {
      if (error instanceof ChromaUnavailableError) {
        logger.warn('CHROMA_SYNC', 'Chroma unavailable before write; leaving documents unsynced', {
          collection: this.collectionName,
          requested: documents.length,
          error: error.message
        });
        return 0;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('CHROMA_SYNC', 'Unexpected error ensuring collection before write', {
        collection: this.collectionName,
        requested: documents.length
      }, err);
      throw error;
    }

    const chromaMcp = ChromaMcpManager.getInstance();

    let written = 0;
    for (let i = 0; i < documents.length; i += this.BATCH_SIZE) {
      const batch = documents.slice(i, i + this.BATCH_SIZE);

      const cleanMetadatas = batch.map(d =>
        Object.fromEntries(
          Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        )
      );

      try {
        await chromaMcp.callTool('chroma_add_documents', {
          collection_name: this.collectionName,
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: cleanMetadatas
        });
        written += batch.length;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('already exist')) {
          try {
            // Reconcile without delete+add. Document IDs are deterministic
            // (e.g. obs_<sqlite_id>_narrative), so every resync, backfill,
            // retry, or interruption collides on the same IDs. HNSW deletions
            // are soft-deletes: a delete+add cycle leaves the old graph nodes
            // in link_lists.bin while appending new ones, so the on-disk index
            // grows without bound and can exhaust disk/RAM.
            //
            // chroma_add_documents rejects the WHOLE batch when any single ID
            // already exists, so a mixed batch may contain both colliding IDs
            // and genuinely-new IDs. chroma_update_documents silently ignores
            // IDs that are not already present, so a blanket update would
            // overwrite the duplicates but never insert the new docs — while
            // still advancing the watermark past them (data loss). So split
            // the batch: update the existing IDs in place, add only the new
            // ones, and count each part only if it actually succeeds.
            const existing = await chromaMcp.callTool('chroma_get_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id),
              include: []
            }) as { ids?: string[] };
            const existingIds = new Set(existing?.ids ?? []);

            const toUpdate = batch.filter(d => existingIds.has(d.id));
            const toAdd = batch.filter(d => !existingIds.has(d.id));
            const cleanFor = (docs: ChromaDocument[]) => docs.map(d =>
              Object.fromEntries(
                Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
              )
            );

            if (toUpdate.length > 0) {
              await chromaMcp.callTool('chroma_update_documents', {
                collection_name: this.collectionName,
                ids: toUpdate.map(d => d.id),
                documents: toUpdate.map(d => d.document),
                metadatas: cleanFor(toUpdate)
              });
              written += toUpdate.length;
            }

            if (toAdd.length > 0) {
              await chromaMcp.callTool('chroma_add_documents', {
                collection_name: this.collectionName,
                ids: toAdd.map(d => d.id),
                documents: toAdd.map(d => d.document),
                metadatas: cleanFor(toAdd)
              });
              written += toAdd.length;
            }

            logger.info('CHROMA_SYNC', 'Batch reconciled via in-place update + add after duplicate conflict', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length,
              updated: toUpdate.length,
              added: toAdd.length
            });
          } catch (reconcileError) {
            logger.error('CHROMA_SYNC', 'Batch reconcile (update+add) failed — watermark will not advance for this batch', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            }, reconcileError as Error);
          }
        } else {
          logger.error('CHROMA_SYNC', 'Batch add failed — watermark will not advance for this batch, continuing with remaining batches', {
            collection: this.collectionName,
            batchStart: i,
            batchSize: batch.length
          }, error as Error);
        }
      }
    }

    logger.debug('CHROMA_SYNC', 'Documents added', {
      collection: this.collectionName,
      requested: documents.length,
      written
    });
    return written;
  }

  /**
   * Single row-atomic boundary for every SQLite-originated add/update. Secret
   * scanning deliberately uses the complete serialized source row, rather than
   * just a generated document field, so one finding suppresses all siblings.
   */
  private async indexSourceRow(
    store: SessionStore | undefined,
    docType: ChromaDocType,
    sqliteId: number,
  ): Promise<{ written: number; documents: number; quarantined: boolean }> {
    // There is deliberately no DTO-only fallback. Both the admission decision
    // and every embedded document come from the same persisted source row, so
    // a caller cannot pair a clean stored revision with secret-bearing DTO
    // text (or vice versa).
    if (!store) {
      logger.warn('CHROMA_SYNC', 'Refused source indexing without a private source policy store', { docType, sqliteId });
      return { written: 0, documents: 0, quarantined: false };
    }
    const completeSourceRow = this.loadCompleteSourceRow(store, docType, sqliteId);
    if (completeSourceRow === undefined) {
      logger.warn('CHROMA_SYNC', 'Source row missing before index; refusing to embed', { docType, sqliteId });
      return { written: 0, documents: 0, quarantined: true };
    }
    const contentSha256 = chromaSourceHash(completeSourceRow);
    if (!await this.admitSourceRow(store, docType, sqliteId, completeSourceRow, contentSha256)) {
      return { written: 0, documents: 0, quarantined: true };
    }
    const documents = this.formatDocumentsFromSourceRow(store, docType, sqliteId, completeSourceRow);
    if (!documents) {
      logger.warn('CHROMA_SYNC', 'Source provenance missing before index; refusing to embed', { docType, sqliteId });
      return { written: 0, documents: 0, quarantined: false };
    }
    // The ledger key travels with every vector. This lets fixture audit and
    // retrieval distinguish a quarantined historical source revision from a
    // later clean revision for the same SQLite row.
    const admittedDocuments = documents.map(document => ({
      ...document,
      metadata: { ...document.metadata, content_sha256: contentSha256 },
    }));
    if (!admittedDocuments.every(document => this.isPolicyAdmittedDocument(document, docType, sqliteId))) {
      logger.warn('CHROMA_SYNC', 'Refused malformed source documents at policy gate', { docType, sqliteId });
      return { written: 0, documents: documents.length, quarantined: true };
    }
    return { written: await this.writeDocuments(admittedDocuments), documents: admittedDocuments.length, quarantined: false };
  }

  /**
   * Format only the source row that was just scanned and hashed. Provenance is
   * loaded from its owning session solely to populate required vector metadata.
   */
  private formatDocumentsFromSourceRow(
    store: SessionStore,
    docType: ChromaDocType,
    sqliteId: number,
    completeSourceRow: unknown,
  ): ChromaDocument[] | undefined {
    if (!completeSourceRow || typeof completeSourceRow !== 'object' || Array.isArray(completeSourceRow)) return undefined;
    const provenance = this.loadSourceProvenance(store, docType, sqliteId);
    if (!provenance) return undefined;
    const source = completeSourceRow as Record<string, unknown>;
    if (docType === 'observation') {
      return this.formatObservationDocs({
        ...source,
        project: provenance.project,
        platform_source: provenance.platform_source,
      } as StoredObservation);
    }
    if (docType === 'session_summary') {
      return this.formatSummaryDocs({
        ...source,
        project: provenance.project,
        platform_source: provenance.platform_source,
      } as StoredSummary);
    }
    // user_prompts own their text, while session identity/provenance lives in
    // sdk_sessions. Read that association after the complete prompt row is
    // scanned; it is never accepted from the caller DTO.
    const promptSession = store.db.prepare(`SELECT s.memory_session_id
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id WHERE up.id = ?`).get(sqliteId);
    if (!promptSession || typeof (promptSession as { memory_session_id?: unknown }).memory_session_id !== 'string') return undefined;
    return [this.formatUserPromptDoc({
      ...source,
      memory_session_id: (promptSession as { memory_session_id: string }).memory_session_id,
      project: provenance.project,
      platform_source: provenance.platform_source,
    } as StoredUserPrompt)];
  }

  /** Admit one complete source row before any add or update for its identity. */
  private async admitSourceRow(
    store: SessionStore | undefined,
    docType: ChromaDocType,
    sqliteId: number,
    completeSourceRow: unknown,
    contentSha256 = chromaSourceHash(completeSourceRow),
  ): Promise<boolean> {
    if (!store) return false;
    const findings = detectChromaSecretFindings(completeSourceRow);
    if (findings.length > 0) {
      store.recordChromaIndexPolicy(docType, sqliteId, contentSha256, findings, 'quarantined');
      // A rescan also reconciles any legacy documents for this exact source.
      await this.deleteSourceDocuments(docType, sqliteId).catch(error => {
        logger.warn('CHROMA_SYNC', 'Could not reconcile quarantined source documents', { docType, sqliteId }, error as Error);
      });
      return false;
    }
    const sourceStatus = store.getChromaSourceStatus(docType, sqliteId);
    if (sourceStatus === 'deleted') return false;
    store.recordChromaIndexPolicy(docType, sqliteId, contentSha256, [], 'clean');
    return true;
  }

  private isPolicyAdmittedDocument(document: ChromaDocument, docType: ChromaDocType, sqliteId: number): boolean {
    return document.metadata.doc_type === docType
      && document.metadata.sqlite_id === sqliteId
      && isOwnerLocalPrivateMetadata(document.metadata);
  }

  private loadCompleteSourceRow(store: SessionStore, docType: ChromaDocType, sqliteId: number): unknown | undefined {
    const table = docType === 'observation'
      ? 'observations'
      : docType === 'session_summary'
        ? 'session_summaries'
        : 'user_prompts';
    return store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sqliteId) ?? undefined;
  }

  private loadSourceProvenance(
    store: SessionStore,
    docType: ChromaDocType,
    sqliteId: number,
  ): { source_table: string; project: string; platform_source: string } | undefined {
    const sourceTable = docType === 'observation'
      ? 'observations'
      : docType === 'session_summary'
        ? 'session_summaries'
        : 'user_prompts';
    const row = (docType === 'observation'
      ? store.db.prepare(`SELECT o.project, COALESCE(NULLIF(s.platform_source, ''), 'claude') AS platform_source
          FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.id = ?`).get(sqliteId)
      : docType === 'session_summary'
        ? store.db.prepare(`SELECT ss.project, COALESCE(NULLIF(s.platform_source, ''), 'claude') AS platform_source
            FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id WHERE ss.id = ?`).get(sqliteId)
        : store.db.prepare(`SELECT s.project, COALESCE(NULLIF(s.platform_source, ''), 'claude') AS platform_source
            FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id WHERE up.id = ?`).get(sqliteId)) as { project?: unknown; platform_source?: unknown } | undefined;
    if (!row || typeof row.project !== 'string' || !row.project) return undefined;
    return {
      source_table: sourceTable,
      project: row.project,
      platform_source: normalizePlatformSource(typeof row.platform_source === 'string' ? row.platform_source : undefined),
    };
  }

  /** Delete every document for one exact source identity; no document text is read. */
  async deleteSourceDocuments(docType: ChromaDocType, sqliteId: number): Promise<void> {
    await this.ensureCollectionExists();
    await ChromaMcpManager.getInstance().callTool('chroma_delete_documents', {
      collection_name: this.collectionName,
      where: { $and: [{ doc_type: docType }, { sqlite_id: sqliteId }] },
    });
  }

  async deleteSource(docType: ChromaDocType, sqliteId: number, store = this.sessionStore): Promise<void> {
    if (store?.getChromaSourceStatus(docType, sqliteId) !== 'deleted') {
      store?.markChromaSourceDeleted(docType, sqliteId);
    }
    await this.deleteSourceDocuments(docType, sqliteId);
  }

  /** Retry durable tombstones after an interrupted or unavailable deletion. */
  async reconcileDeletedSources(store = this.sessionStore): Promise<number> {
    if (!store) return 0;
    let deleted = 0;
    for (const { docType, sqliteId } of store.getChromaDeletedSources()) {
      await this.deleteSourceDocuments(docType, sqliteId);
      deleted++;
    }
    return deleted;
  }

  /** Read-only fixture audit; callers provide an adapter so this never opens Chroma. */
  async auditIndex(adapter: Pick<ChromaIndexAdapter, 'list'>): Promise<ChromaFixtureDocument[]> {
    const documents = await adapter.list();
    return documents.filter(document => {
      const metadata = document.metadata;
      const docType = metadata.doc_type;
      const sqliteId = metadata.sqlite_id;
      if (docType !== 'observation' && docType !== 'session_summary' && docType !== 'user_prompt') return true;
      if (!Number.isInteger(sqliteId) || !isOwnerLocalPrivateMetadata(metadata)) return true;
      // A vector has no standing without a store decision for its exact source
      // revision. In particular, do not collapse a quarantined hash A into a
      // later clean hash B for the same (doc_type, sqlite_id) pair.
      return !this.sessionStore
        || !this.sessionStore.isChromaEmbeddingEligible(docType, sqliteId as number, metadata.content_sha256 as string);
    });
  }

  /**
   * Idempotently removes quarantined/deleted fixture documents and supplies
   * missing provenance for known-clean legacy rows. The caller owns the
   * adapter; production code does not invoke this during validation.
   */
  async reconcileIndex(adapter: ChromaIndexAdapter): Promise<{ deleted: number; updated: number }> {
    const documents = await adapter.list();
    const deleteIds: string[] = [];
    const updateIds: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    for (const document of documents) {
      const metadata = document.metadata;
      const docType = metadata.doc_type;
      const sqliteId = metadata.sqlite_id;
      if (docType !== 'observation' && docType !== 'session_summary' && docType !== 'user_prompt' || !Number.isInteger(sqliteId)) {
        deleteIds.push(document.id);
        continue;
      }
      const contentSha256 = metadata.content_sha256;
      const exactStatus = this.sessionStore && isChromaContentHash(contentSha256)
        ? this.sessionStore.getChromaIndexStatus(docType, sqliteId as number, contentSha256)
        : null;
      if (!this.sessionStore || exactStatus === 'quarantined' || exactStatus === 'deleted') {
        deleteIds.push(document.id);
      } else {
        const sourceRow = this.sessionStore
          ? this.loadCompleteSourceRow(this.sessionStore, docType, sqliteId as number)
          : undefined;
        const findings = sourceRow === undefined ? [] : detectChromaSecretFindings(sourceRow);
        // Reconciliation is an update path too, so it re-scans the complete
        // current row. Its adapter-only deletion keeps fixture validation from
        // opening a live collection.
        if (sourceRow === undefined || findings.length > 0) {
          if (sourceRow !== undefined) {
            this.sessionStore?.recordChromaIndexPolicy(
              docType,
              sqliteId as number,
              chromaSourceHash(sourceRow),
              findings,
              'quarantined',
            );
          }
          deleteIds.push(document.id);
          continue;
        }
        // A metadata-bearing document with no exact ledger entry cannot be
        // authenticated as clean. Only hashless legacy documents may be
        // upgraded from the current complete source row.
        const sourceSha256 = chromaSourceHash(sourceRow);
        if (isChromaContentHash(contentSha256) && (
          exactStatus !== 'clean' || contentSha256 !== sourceSha256
        )) {
          // A known historical hash is never upgraded to the current hash.
          // Its document text may be an older (or quarantined) revision, so
          // only a fresh source-gated write may create the current vector.
          deleteIds.push(document.id);
          continue;
        }
        // Pre-v50 embeddings have no ledger entry. Re-scan their current
        // private source row before upgrading metadata, then record the clean
        // decision so retrieval can fail closed until this reconciliation.
        this.sessionStore?.recordChromaIndexPolicy(
          docType,
          sqliteId as number,
          sourceSha256,
          [],
          'clean',
        );
        const provenance = this.sessionStore
          ? this.loadSourceProvenance(this.sessionStore, docType, sqliteId as number)
          : undefined;
        // A clean ledger alone cannot authenticate a legacy vector. If its
        // private source row is gone, remove the incomplete metadata rather
        // than inventing project/platform provenance.
        if (!provenance) {
          deleteIds.push(document.id);
          continue;
        }
        const upgraded = {
          ...metadata,
          doc_type: docType,
          sqlite_id: sqliteId,
          ...provenance,
          sensitivity: 'private',
          acl: 'owner_local',
          content_sha256: isChromaContentHash(contentSha256) ? contentSha256 : sourceSha256,
        };
        if (JSON.stringify(upgraded) !== JSON.stringify(metadata)) {
          updateIds.push(document.id);
          metadatas.push(upgraded);
        }
      }
    }
    if (deleteIds.length) await adapter.delete(deleteIds);
    if (updateIds.length) await adapter.update(updateIds, metadatas);
    return { deleted: deleteIds.length, updated: updateIds.length };
  }

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    logger.info('CHROMA_SYNC', 'Syncing observation', {
      observationId,
      documentSource: 'persisted_row',
      project
    });

    // Only advance the watermark on a confirmed full write. addDocuments() now
    // returns a written count and tolerates per-batch failures, so a transient
    // Chroma error must NOT mark this observation as synced — otherwise the
    // backfill pass on next boot will skip past it (CodeRabbit review on PR
    // #2282).
    const outcome = await this.indexSourceRow(this.sessionStore, 'observation', observationId);
    if (outcome.quarantined || (this.sessionStore && outcome.written === outcome.documents)) {
      ChromaSyncState.bump(project, 'observations', observationId);
    } else {
      logger.warn('CHROMA_SYNC', 'Observation watermark bump skipped — partial write', {
        observationId,
        project,
        requested: outcome.documents,
        written: outcome.written
      });
    }
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    logger.info('CHROMA_SYNC', 'Syncing summary', {
      summaryId,
      documentSource: 'persisted_row',
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const outcome = await this.indexSourceRow(this.sessionStore, 'session_summary', summaryId);
    if (outcome.quarantined || (this.sessionStore && outcome.written === outcome.documents)) {
      ChromaSyncState.bump(project, 'summaries', summaryId);
    } else {
      logger.warn('CHROMA_SYNC', 'Summary watermark bump skipped — partial write', {
        summaryId,
        project,
        requested: outcome.documents,
        written: outcome.written
      });
    }
  }

  private formatUserPromptDoc(prompt: StoredUserPrompt): ChromaDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        source_table: 'user_prompts',
        sensitivity: 'private',
        acl: 'owner_local',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        platform_source: prompt.platform_source,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    logger.info('CHROMA_SYNC', 'Syncing user prompt', {
      promptId,
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const outcome = await this.indexSourceRow(this.sessionStore, 'user_prompt', promptId);
    if (outcome.quarantined || (this.sessionStore && outcome.documents > 0 && outcome.written === outcome.documents)) {
      ChromaSyncState.bump(project, 'prompts', promptId);
    } else {
      logger.warn('CHROMA_SYNC', 'Prompt watermark bump skipped — write failed', {
        promptId,
        project,
        written: outcome.written
      });
    }
  }

  private mergeRowsById<T extends { id: number }>(rows: T[], pendingRows: T[]): T[] {
    const merged = new Map<number, T>();
    for (const row of rows) {
      merged.set(row.id, row);
    }
    for (const row of pendingRows) {
      merged.set(row.id, row);
    }
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }

  private summarizeBootstrapPending(
    sourceIds: number[],
    existingIds: Set<number>
  ): { watermark: number; pending: number[] } {
    const watermark = existingIds.size ? Math.max(...existingIds) : 0;
    return {
      watermark,
      pending: sourceIds.filter(id => id <= watermark && !existingIds.has(id)),
    };
  }

  private async getExistingChromaIds(project: string): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; 

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project });

    while (true) {
      const result = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        limit: limit,
        offset: offset,
        where: { project },
        include: ['metadatas']
      }) as any;

      const metadatas = result?.metadatas || [];

      if (metadatas.length === 0) {
        break; 
      }

      for (const meta of metadatas) {
        if (meta && meta.sqlite_id) {
          const sqliteId = meta.sqlite_id as number;
          if (meta.doc_type === 'observation') {
            observationIds.add(sqliteId);
          } else if (meta.doc_type === 'session_summary') {
            summaryIds.add(sqliteId);
          } else if (meta.doc_type === 'user_prompt') {
            promptIds.add(sqliteId);
          }
        }
      }

      offset += limit;

      logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
        project,
        offset,
        batchSize: metadatas.length
      });
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size,
      total: observationIds.size + summaryIds.size + promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  async bootstrapWatermarksFromChroma(project: string, store: SessionStore): Promise<void> {
    const existing = await this.getExistingChromaIds(project);
    const observationIds = store.db.prepare(`
      SELECT id
      FROM observations
      WHERE project = ?
      ORDER BY id ASC
    `).all(project) as Array<{ id: number }>;
    const summaryIds = store.db.prepare(`
      SELECT id
      FROM session_summaries
      WHERE project = ?
      ORDER BY id ASC
    `).all(project) as Array<{ id: number }>;
    const promptIds = store.db.prepare(`
      SELECT up.id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
      ORDER BY up.id ASC
    `).all(project) as Array<{ id: number }>;
    const observationBootstrap = this.summarizeBootstrapPending(observationIds.map(row => row.id), existing.observations);
    const summaryBootstrap = this.summarizeBootstrapPending(summaryIds.map(row => row.id), existing.summaries);
    const promptBootstrap = this.summarizeBootstrapPending(promptIds.map(row => row.id), existing.prompts);

    ChromaSyncState.replace(project, {
      observations: observationBootstrap.watermark,
      summaries: summaryBootstrap.watermark,
      prompts: promptBootstrap.watermark,
      pending: {
        observations: observationBootstrap.pending,
        summaries: summaryBootstrap.pending,
        prompts: promptBootstrap.pending,
      }
    });
    logger.info('CHROMA_SYNC', 'Bootstrapped watermarks from Chroma', {
      project,
      watermarks: ChromaSyncState.get(project)
    });
  }

  async ensureBackfilled(project: string, store: SessionStore): Promise<void> {
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project });

    await this.ensureCollectionExists();

    const watermarks = ChromaSyncState.get(project);

    try {
      await this.runBackfillPipeline(store, project, watermarks);
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Backfill failed', { project }, error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runBackfillPipeline(
    db: SessionStore,
    backfillProject: string,
    watermarks: ProjectWatermarks
  ): Promise<void> {
    const observationDocs = await this.backfillObservations(db, backfillProject, watermarks.observations);
    const summaryDocs = await this.backfillSummaries(db, backfillProject, watermarks.summaries);
    const promptDocs = await this.backfillPrompts(db, backfillProject, watermarks.prompts);

    logger.info('CHROMA_SYNC', 'Smart backfill complete', {
      project: backfillProject,
      synced: { observationDocs, summaryDocs, promptDocs },
      watermarks: ChromaSyncState.get(backfillProject)
    });
  }

  /**
   * Shared batch/watermark loop for all three backfill kinds. Returns the
   * number of documents produced from `rows`.
   *
   * Watermark durability is row-atomic, not batch-atomic: one observation or
   * summary can expand into several Chroma documents and span multiple
   * BATCH_SIZE writes. We only clear pending state and bump the row watermark
   * after every document for that row lands, otherwise a later batch failure or
   * restart can strand the tail of a split row forever.
   */
  private async backfillKind<T extends { id: number }>(
    store: SessionStore,
    rows: T[],
    formatDocs: (row: T) => ChromaDocument[],
    docType: ChromaDocType,
    kind: 'observations' | 'summaries' | 'prompts',
    backfillProject: string
  ): Promise<number> {
    const rowsWithDocs = rows.map(row => ({ row, docs: formatDocs(row) }));
    const totalDocs = rowsWithDocs.reduce((sum, { docs }) => sum + docs.length, 0);
    let processedDocs = 0;

    for (const { row, docs } of rowsWithDocs) {
      let rowComplete = true;
      // indexSourceRow formats the persisted row itself and writeDocuments()
      // owns batching. This keeps one source-row decision bound to all of its
      // generated documents even when a row spans multiple Chroma batches.
      // Do not skip a zero-document preliminary format: its complete source
      // row can still contain a secret in an unembedded column, and must get
      // a durable admission decision before its watermark advances.
      const outcome = await this.indexSourceRow(store, docType, row.id);
      processedDocs += docs.length;
      if (!outcome.quarantined && outcome.written < outcome.documents) {
        ChromaSyncState.markPending(backfillProject, kind, [row.id]);
        logger.debug('CHROMA_SYNC', 'Recorded pending watermark gap for failed/partial row', {
          project: backfillProject,
          kind,
          rowId: row.id,
          requested: outcome.documents,
          written: outcome.written
        });
        rowComplete = false;
      }

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        project: backfillProject,
        progress: `${Math.min(processedDocs, totalDocs)}/${totalDocs}`
      });

      if (!rowComplete) {
        continue;
      }

      ChromaSyncState.clearPending(backfillProject, kind, [row.id]);
      ChromaSyncState.bump(backfillProject, kind, row.id);
    }

    return totalDocs;
  }

  private async backfillObservations(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'observations');
    const observations = db.db.prepare(`
      SELECT
        o.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.project = ? AND o.id > ?
      ORDER BY o.id ASC
    `).all(backfillProject, watermark) as StoredObservation[];
    let pendingRows: StoredObservation[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          o.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM observations o
        LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
        WHERE o.project = ? AND o.id IN (${placeholders})
        ORDER BY o.id ASC
      `).all(backfillProject, ...pendingIds) as StoredObservation[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'observations', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(observations, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalObsCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling observations', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalObsCount.count
    });

    return this.backfillKind(db, rows, obs => this.formatObservationDocs(obs), 'observation', 'observations', backfillProject);
  }

  private async backfillSummaries(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'summaries');
    const summaries = db.db.prepare(`
      SELECT
        ss.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.project = ? AND ss.id > ?
      ORDER BY ss.id ASC
    `).all(backfillProject, watermark) as StoredSummary[];
    let pendingRows: StoredSummary[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          ss.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM session_summaries ss
        LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
        WHERE ss.project = ? AND ss.id IN (${placeholders})
        ORDER BY ss.id ASC
      `).all(backfillProject, ...pendingIds) as StoredSummary[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'summaries', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(summaries, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalSummaryCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling summaries', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalSummaryCount.count
    });

    return this.backfillKind(db, rows, summary => this.formatSummaryDocs(summary), 'session_summary', 'summaries', backfillProject);
  }

  private async backfillPrompts(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'prompts');
    const prompts = db.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ? AND up.id > ?
      ORDER BY up.id ASC
    `).all(backfillProject, watermark) as StoredUserPrompt[];
    let pendingRows: StoredUserPrompt[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        WHERE s.project = ? AND up.id IN (${placeholders})
        ORDER BY up.id ASC
      `).all(backfillProject, ...pendingIds) as StoredUserPrompt[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'prompts', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(prompts, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalPromptCount = db.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalPromptCount.count
    });

    return this.backfillKind(db, rows, prompt => [this.formatUserPromptDoc(prompt)], 'user_prompt', 'prompts', backfillProject);
  }

  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    if (!this.sessionStore) {
      logger.warn('CHROMA_SYNC', 'Refused Chroma retrieval without a source policy store');
      return { ids: [], distances: [], metadatas: [] };
    }
    await this.ensureCollectionExists();

    let results: any;
    const privateAclFilter = { $and: [
      { sensitivity: 'private' },
      { acl: 'owner_local' },
    ] };
    const enforcedFilter = whereFilter
      ? { $and: [privateAclFilter, whereFilter] }
      : privateAclFilter;
    try {
      const chromaMcp = ChromaMcpManager.getInstance();
      results = await chromaMcp.callTool('chroma_query_documents', {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: limit,
        where: enforcedFilter,
        include: ['documents', 'metadatas', 'distances']
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || // [ANTI-PATTERN IGNORED]: ChromaMcpManager.callTool re-wraps transport failures as plain Errors, so the Node error code only survives in the message text; the full error object is logged below.
        errorMessage.includes('ENOTFOUND') || // [ANTI-PATTERN IGNORED]: same MCP transport re-wrapping as above; no structured code field is available on the re-wrapped error.
        errorMessage.includes('fetch failed') || 
        errorMessage.includes('subprocess closed') || 
        errorMessage.includes('timed out'); 

      if (isConnectionError) {
        this.collectionCreated = false;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { project: this.project, query }, error as Error);
      throw error;
    }

    return this.deduplicateQueryResults(results);
  }

  private deduplicateQueryResults(results: any): { ids: number[]; distances: number[]; metadatas: any[] } {
    if (!this.sessionStore) return { ids: [], distances: [], metadatas: [] };
    const ids: number[] = [];
    const seen = new Set<string>();
    const docIds = results?.ids?.[0] || [];
    const rawMetadatas = results?.metadatas?.[0] || [];
    const rawDistances = results?.distances?.[0] || [];

    const metadatas: any[] = [];
    const distances: number[] = [];

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      const metadata = rawMetadatas[i] ?? null;
      // Chroma filtering alone cannot protect against malformed legacy data or
      // adapters with partial where support. Treat absent/unknown policy as
      // ineligible before ID parsing/hydration.
      if (!isOwnerLocalPrivateMetadata(metadata)) continue;
      const obsMatch = docId.match(/obs_(\d+)_/);
      const summaryMatch = docId.match(/summary_(\d+)_/);
      const promptMatch = docId.match(/prompt_(\d+)/);

      let sqliteId: number | null = null;
      let entityType: ChromaDocType | null = null;
      if (obsMatch) {
        sqliteId = parseInt(obsMatch[1], 10);
        entityType = 'observation';
      } else if (summaryMatch) {
        sqliteId = parseInt(summaryMatch[1], 10);
        entityType = 'session_summary';
      } else if (promptMatch) {
        sqliteId = parseInt(promptMatch[1], 10);
        entityType = 'user_prompt';
      }

      if (sqliteId !== null && entityType) {
        if (metadata.doc_type !== entityType) continue;
        if (!this.sessionStore.isChromaEmbeddingEligible(entityType, sqliteId, metadata.content_sha256)) continue;
        const dedupeKey = `${entityType}:${sqliteId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        ids.push(sqliteId);
        metadatas.push(metadata);
        distances.push(rawDistances[i] ?? 0);
      }
    }

    return { ids, distances, metadatas };
  }

  /** Maximum number of concurrent project backfills to run at once. */
  private static readonly BACKFILL_CONCURRENCY_LIMIT = 3;

  /** Guard flag to prevent overlapping backfill runs from fire-and-forget callers. */
  private static backfillInProgress = false;

  /**
   * Backfill all projects that have observations in SQLite but may be missing from Chroma.
   * Uses a single shared ChromaSync('claude-mem') instance and Chroma connection.
   * Per-project scoping is passed as a parameter to ensureBackfilled(), avoiding
   * instance state mutation. All documents land in the cm__claude-mem collection
   * with project scoped via metadata, matching how DatabaseManager and SearchManager operate.
   * Designed to be called fire-and-forget on worker startup.
   *
   * Concurrency: processes at most BACKFILL_CONCURRENCY_LIMIT projects in parallel
   * to bound CPU and memory pressure from concurrent Chroma embedding operations.
   * A re-entrant guard prevents overlapping backfill runs from accumulating.
   */
  static async backfillAllProjects(store: SessionStore): Promise<void> {
    if (ChromaSync.backfillInProgress) {
      logger.info('CHROMA_SYNC', 'Backfill already in progress, skipping duplicate run');
      return;
    }

    const sync = new ChromaSync('claude-mem', store);

    ChromaSync.backfillInProgress = true;
    try {
      const projects = store.db.prepare(
        'SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ?'
      ).all('') as { project: string }[];

      logger.info('CHROMA_SYNC', `Backfill check for ${projects.length} projects`);

      if (!ChromaSyncState.exists()) {
        logger.info('CHROMA_SYNC', 'Watermark cache missing — bootstrapping from Chroma (one-time)');
        for (const { project } of projects) {
          try {
            await sync.bootstrapWatermarksFromChroma(project, store);
          } catch (error) {
            logger.error('CHROMA_SYNC', `Bootstrap failed for project: ${project}`,
              {}, error instanceof Error ? error : new Error(String(error)));
          }
        }
        logger.info('CHROMA_SYNC', 'Bootstrap complete — incremental backfills will use watermarks');
      }

      // Process projects in chunks of BACKFILL_CONCURRENCY_LIMIT to bound
      // CPU/memory pressure from concurrent Chroma embedding operations.
      // Each chunk runs its projects in parallel; we wait for the entire chunk
      // before starting the next one. Simple and predictable — no semaphore
      // overhead, no unbounded fan-out.
      const concurrency = ChromaSync.BACKFILL_CONCURRENCY_LIMIT;
      for (let i = 0; i < projects.length; i += concurrency) {
        const chunk = projects.slice(i, i + concurrency);
        const chunkResults = await Promise.allSettled(
          chunk.map(({ project }) => sync.ensureBackfilled(project, store))
        );

        for (let j = 0; j < chunkResults.length; j++) {
          const result = chunkResults[j];
          if (result.status === 'rejected') {
            const project = chunk[j].project;
            const error = result.reason;
            if (error instanceof Error) {
              logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, {}, error);
            } else {
              logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, { error: String(error) });
            }
            // Continue to next chunk — don't let one failure stop others
          }
        }
      }
    } finally {
      ChromaSync.backfillInProgress = false;
    }
  }

  async updateMergedIntoProject(
    targets: MergedIntoProjectTarget[],
    mergedIntoProject: string
  ): Promise<void> {
    if (targets.length === 0) return;
    if (!this.sessionStore) {
      logger.warn('CHROMA_SYNC', 'Refused merged-project Chroma update without a source policy store');
      return;
    }

    await this.ensureCollectionExists();
    const chromaMcp = ChromaMcpManager.getInstance();

    let totalPatched = 0;

    for (const docType of ['observation', 'session_summary'] as const) {
      const sqliteIds = targets
        .filter(target => target.docType === docType)
        .map(target => target.sqliteId);

      for (let i = 0; i < sqliteIds.length; i += this.BATCH_SIZE) {
        const candidates = sqliteIds.slice(i, i + this.BATCH_SIZE);
        const provenanceById = new Map<number, {
          source_table: string;
          project: string;
          platform_source: string;
          content_sha256: string;
        }>();
        for (const sqliteId of candidates) {
          const row = this.loadCompleteSourceRow(this.sessionStore, docType, sqliteId);
          if (row === undefined || !await this.admitSourceRow(this.sessionStore, docType, sqliteId, row)) continue;
          const provenance = this.loadSourceProvenance(this.sessionStore, docType, sqliteId);
          if (provenance) {
            provenanceById.set(sqliteId, { ...provenance, content_sha256: chromaSourceHash(row) });
          }
        }
        const idBatch = [...provenanceById.keys()];
        if (idBatch.length === 0) continue;

        const existing = await chromaMcp.callTool('chroma_get_documents', {
          collection_name: this.collectionName,
          where: {
            $and: [
              { doc_type: docType },
              { sqlite_id: { $in: idBatch } }
            ]
          },
          include: ['metadatas']
        }) as { ids?: string[]; metadatas?: Array<Record<string, any> | null> };

        const docIds: string[] = existing?.ids ?? [];
        if (docIds.length === 0) continue;

        const updates = docIds.map((id, index) => {
          const m = existing?.metadatas?.[index];
          const sqliteId = m?.sqlite_id;
          const provenance = typeof sqliteId === 'number' ? provenanceById.get(sqliteId) : undefined;
          if (!provenance) return undefined;
          const existingHash = m?.content_sha256;
          // This is a metadata-only operation. It must never relabel an old
          // vector as the current source revision: that would turn a
          // quarantined historical embedding into an apparently clean one.
          if (isChromaContentHash(existingHash) && (
            existingHash !== provenance.content_sha256
            || this.sessionStore!.getChromaIndexStatus(docType, sqliteId, existingHash) !== 'clean'
          )) {
            // Adoption changes merged_into_project in the persisted row, so
            // its complete-row hash is expected to change. Do not delete a
            // current vector and leave the source absent from semantic
            // retrieval: replace it through the same source-row gate that
            // produced the original vector.
            return { id, reindex: true as const, sqliteId };
          }
          const merged: Record<string, any> = {
            ...(m ?? {}),
            ...provenance,
            doc_type: docType,
            sqlite_id: sqliteId,
            sensitivity: 'private',
            acl: 'owner_local',
            merged_into_project: mergedIntoProject
          };
          return { id, metadata: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
        }).filter((update): update is { id: string; metadata: Record<string, any>; reindex?: never } | { id: string; reindex: true; sqliteId: number } => update !== undefined);
        const reindexIds = [...new Set(updates
          .filter((update): update is { id: string; reindex: true; sqliteId: number } => 'reindex' in update)
          .map(update => update.sqliteId))];
        const metadataUpdates = updates.filter((update): update is { id: string; metadata: Record<string, any>; delete?: never } => 'metadata' in update);
        if (metadataUpdates.length) {
          await chromaMcp.callTool('chroma_update_documents', {
            collection_name: this.collectionName,
            ids: metadataUpdates.map(update => update.id),
            metadatas: metadataUpdates.map(update => update.metadata)
          });
          totalPatched += metadataUpdates.length;
        }
        for (const sqliteId of reindexIds) {
          const outcome = await this.indexSourceRow(this.sessionStore, docType, sqliteId);
          if (outcome.documents === 0 && !outcome.quarantined) {
            await this.deleteSourceDocuments(docType, sqliteId);
          }
          totalPatched += outcome.written;
        }
      }
    }

    logger.info('CHROMA_SYNC', 'merged_into_project metadata patched', {
      collection: this.collectionName,
      mergedIntoProject,
      sqliteIdCount: targets.length,
      chromaDocsPatched: totalPatched
    });
  }
}
