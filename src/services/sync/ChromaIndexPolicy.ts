import { createHash } from 'crypto';

export type ChromaDocType = 'observation' | 'session_summary' | 'user_prompt';
export type ChromaFindingKind = 'pem' | 'bearer_token' | 'json_credential' | 'yaml_credential' | 'key_value_credential';
export type ChromaPolicyStatus = 'clean' | 'quarantined' | 'deleted';

/**
 * Produce a deterministic, complete-row representation before any source text
 * is sent to an embedder. This value is deliberately only used to derive a
 * digest; it is never persisted in the quarantine ledger.
 */
export function canonicalizeChromaSourceRow(row: unknown): string {
  if (row === null || typeof row !== 'object') return JSON.stringify(row);
  if (Array.isArray(row)) return `[${row.map(canonicalizeChromaSourceRow).join(',')}]`;
  const value = row as Record<string, unknown>;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalizeChromaSourceRow(value[key])}`).join(',')}}`;
}

export function chromaSourceHash(row: unknown): string {
  return createHash('sha256').update(canonicalizeChromaSourceRow(row)).digest('hex');
}

export function isChromaContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function sourceStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(sourceStrings);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(sourceStrings);
  return [];
}

const credentialKey = '(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key)';
const patterns: Array<[ChromaFindingKind, RegExp]> = [
  // Certificate and public-key blocks are sensitive source material too;
  // accepting only PRIVATE KEY headers leaves a PEM-shaped bypass.
  ['pem', /-----BEGIN [A-Z0-9][A-Z0-9 ]*-----/i],
  // A bearer header is sensitive regardless of token length. Short test and
  // development tokens still must not create an embedding bypass.
  ['bearer_token', /\bbearer\s+[A-Za-z0-9._~+\/-]+/i],
  // Credential shape, rather than value length, controls quarantine. Short
  // development values are still credentials and must not bypass the gate.
  // JSON credential values are not necessarily strings. Numeric, boolean,
  // null, and nested values are still credential-bearing source rows and must
  // not bypass quarantine simply because their value is unquoted.
  ['json_credential', new RegExp(`"${credentialKey}"\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null|\\{|\\[)`, 'i')],
  // YAML accepts quoted mapping keys as well as bare ones. Keep this
  // line-anchored so ordinary prose such as "api_key: guidance" does not
  // accidentally become a cross-line match.
  ['yaml_credential', new RegExp(`^\\s*(?:["']${credentialKey}["']|${credentialKey})\\s*:\\s*[^\\s#][^\\n]*$`, 'im')],
  ['key_value_credential', new RegExp(`\\b${credentialKey}\\s*=\\s*[^\\s]+`, 'i')],
];

/** Finds classes only; no matching plaintext is returned or stored. */
export function detectChromaSecretFindings(row: unknown): ChromaFindingKind[] {
  // Scan the canonical row and its unescaped textual leaves. The former
  // catches credential-shaped keys; the latter preserves JSON/YAML syntax in
  // a field that would otherwise be escaped by canonical serialization.
  const sources = [canonicalizeChromaSourceRow(row), ...sourceStrings(row)];
  return patterns.filter(([, pattern]) => sources.some(source => pattern.test(source))).map(([kind]) => kind);
}

export function isOwnerLocalPrivateMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.sensitivity === 'private'
    && metadata?.acl === 'owner_local'
    && typeof metadata?.doc_type === 'string'
    && typeof metadata?.source_table === 'string'
    && Number.isInteger(metadata?.sqlite_id)
    && typeof metadata?.project === 'string'
    && metadata.project.length > 0
    && typeof metadata?.platform_source === 'string'
    && metadata.platform_source.length > 0
    && isChromaContentHash(metadata.content_sha256);
}
