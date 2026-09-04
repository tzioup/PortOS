/**
 * Boundary tests for the Beeper attachment byte mirror (#37).
 *
 * Postgres is mocked at `query()` and the Beeper client at `headAsset` /
 * `fetchAssetStream`, but the FILESYSTEM is real (a temp `PATHS.data`): the
 * behaviour under test is what lands on disk and what the store does when
 * asked to give bytes back, and a mocked `fs` would only prove the mock. The
 * behavioural acceptance path against a real database is not covered here —
 * these are the byte-level contracts.
 *
 * Every fixture value is invented (placeholder ids, `example` names) per root
 * AGENTS.md Sensitive Data & Privacy — no value here came from a running
 * instance, and nothing here sends anything through a messaging API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-beeper-attachments-');

vi.mock('../lib/db.js', () => ({ query: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
// The client is mocked WHOLE rather than partially: importing the real module
// pulls in the vault-backed credential store, which reads `PATHS` at import
// time — before the hoisted temp-root mock below can answer. The service only
// ever branches on `err.code === 'ASSET_UNAVAILABLE'`, and that mapping (a 502
// from `serve` for media the network aged out) is pinned where it is decided,
// in `beeperClient.test.js`.
vi.mock('./beeperClient.js', () => {
  class MockBeeperApiError extends Error {
    constructor(message, { status = 500, code, retryable = false } = {}) {
      super(message);
      this.name = 'BeeperApiError';
      this.status = status;
      this.code = code;
      this.retryable = retryable;
    }
  }
  return { BeeperApiError: MockBeeperApiError, headAsset: vi.fn(), fetchAssetStream: vi.fn() };
});
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));

import { query } from '../lib/db.js';
import { getSettings } from './settings.js';
import { BeeperApiError, headAsset, fetchAssetStream } from './beeperClient.js';
import {
  attachmentsRoot,
  backfillAttachments,
  ensureAttachmentBytes,
  evictToBudget,
  getAttachmentSummary,
  purgeConversationAttachments,
  shapeAttachment,
  sweepAttachmentOrphans,
} from './beeperAttachments.js';

const CONV = '11111111-1111-4111-8111-111111111111';

const attachmentRow = (overrides = {}) => ({
  conversation_id: CONV,
  message_id: 'msg-example-1',
  idx: 0,
  mxc_id: 'mxc://example.invalid/abc',
  sha256: null,
  mime_type: 'image/png',
  byte_length: null,
  file_name: 'example.png',
  width: null,
  height: null,
  last_viewed_at: null,
  keep: false,
  local_path: null,
  fetched_at: null,
  unavailable_at: null,
  fetch_error: null,
  ...overrides,
});

// A `Response`-shaped fake whose `body` is a real web ReadableStream, because
// the mirror consumes it through `Readable.fromWeb` — a fake array would not
// exercise the byte counter that enforces the mid-stream ceiling.
const streamResponse = (chunks) => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
});

const unavailableError = () => new BeeperApiError('Failed to download asset: Transfer failed', {
  status: 502, code: 'ASSET_UNAVAILABLE', retryable: false,
});

/**
 * Answer `query()` from a table of SQL fragment → result, so a test states the
 * three or four statements it cares about instead of ordering every call.
 */
const respondTo = (table, fallback = { rows: [] }) => {
  vi.mocked(query).mockImplementation(async (sql) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    for (const [fragment, result] of table) {
      if (flat.includes(fragment)) return typeof result === 'function' ? result(flat) : result;
    }
    return fallback;
  });
};

const storedFiles = () => {
  const root = attachmentsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.tmp')
    .flatMap((entry) => readdirSync(join(root, entry.name)).map((name) => `${entry.name}/${name}`));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue({ beeper: { attachmentBudgetGb: 5 } });
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('ensureAttachmentBytes — the lazy mirror', () => {
  it('downloads on first view, stores content-addressed, and serves from disk on the second', async () => {
    let row = attachmentRow();
    vi.mocked(query).mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('FROM beeper_attachments WHERE message_id')) return { rows: [row] };
      if (flat.includes('SET local_path = $3')) {
        row = { ...row, local_path: params[2], sha256: params[3], byte_length: params[4] };
        return { rows: [] };
      }
      return { rows: [] };
    });
    vi.mocked(headAsset).mockResolvedValue({ bytes: 5 });
    vi.mocked(fetchAssetStream).mockResolvedValue(streamResponse([new Uint8Array([1, 2, 3, 4, 5])]));

    const first = await ensureAttachmentBytes('msg-example-1', 0);
    expect(first.cached).toBe(false);
    expect(first.mimeType).toBe('image/png');
    // `<sha256[0..2]>/<sha256>.png` — one file, addressed by content.
    expect(storedFiles()).toHaveLength(1);
    expect(storedFiles()[0]).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);

    const second = await ensureAttachmentBytes('msg-example-1', 0);
    expect(second.cached).toBe(true);
    // The second open costs nothing upstream — no HEAD, no stream.
    expect(vi.mocked(fetchAssetStream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(headAsset)).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-cap attachment at the HEAD pre-flight, before a byte moves', async () => {
    respondTo([['FROM beeper_attachments WHERE message_id', { rows: [attachmentRow()] }]]);
    vi.mocked(headAsset).mockResolvedValue({ bytes: 40 * 1024 * 1024 });

    await expect(ensureAttachmentBytes('msg-example-1', 0)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE', status: 413, context: { bytes: 40 * 1024 * 1024, maxBytes: 32 * 1024 * 1024 },
    });
    expect(vi.mocked(fetchAssetStream)).not.toHaveBeenCalled();
    expect(storedFiles()).toEqual([]);
  });

  it('records the size the HEAD reported when it refuses, so the next render is the real placeholder', async () => {
    // A row the bridge never reported a size for is NOT `overCap`, so the
    // thread renders an <img>, takes the 413, and would otherwise fall into the
    // generic retry — whose retry forces an unbounded download behind a button
    // that names neither the size nor the ceiling.
    respondTo([['FROM beeper_attachments WHERE message_id', { rows: [attachmentRow({ byte_length: null })] }]]);
    vi.mocked(headAsset).mockResolvedValue({ bytes: 41 * 1024 * 1024 });

    await expect(ensureAttachmentBytes('msg-example-1', 0)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    const write = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('SET byte_length = $3'));
    expect(write).toBeTruthy();
    expect(write[1]).toEqual(['msg-example-1', 0, 41 * 1024 * 1024]);
  });

  it('abandons a transfer that goes silent mid-stream instead of holding the file open', async () => {
    respondTo([['FROM beeper_attachments WHERE message_id', { rows: [attachmentRow()] }]]);
    vi.mocked(headAsset).mockResolvedValue({ bytes: 8 });
    // A body that emits one chunk and then never resolves again — the shape the
    // header-only fetch budget cannot see. The mirror's own idle abort is what
    // ends it; the signal it passes is the one under test.
    vi.mocked(fetchAssetStream).mockImplementation(async (_id, { signal } = {}) => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      }),
    }));
    vi.useFakeTimers();
    const pending = ensureAttachmentBytes('msg-example-1', 0);
    const settled = pending.then(() => null).catch((err) => err);
    await vi.advanceTimersByTimeAsync(61_000);
    const failure = await settled;
    vi.useRealTimers();

    expect(failure).toMatchObject({ code: 'ATTACHMENT_DOWNLOAD_FAILED' });
    expect(storedFiles()).toEqual([]);
    expect(readdirSync(join(attachmentsRoot(), '.tmp'))).toEqual([]);
  });

  it('aborts mid-stream when the source declines to report a size and overruns the ceiling', async () => {
    respondTo([['FROM beeper_attachments WHERE message_id', { rows: [attachmentRow()] }]]);
    // `bytes: null` is "the server would not say" — which must not read as
    // zero and sail under the ceiling.
    vi.mocked(headAsset).mockResolvedValue({ bytes: null });
    const oversized = () => streamResponse(
      Array.from({ length: 34 }, () => new Uint8Array(1024 * 1024)),
    );
    vi.mocked(fetchAssetStream).mockImplementation(async () => oversized());

    await expect(ensureAttachmentBytes('msg-example-1', 0)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
    });
    // Nothing finalized, and the partial is cleaned up rather than left to
    // count against the budget.
    expect(storedFiles()).toEqual([]);
    expect(readdirSync(join(attachmentsRoot(), '.tmp'))).toEqual([]);
  });

  it('lifts the ceiling only for an explicit "fetch anyway"', async () => {
    respondTo([['FROM beeper_attachments WHERE message_id', { rows: [attachmentRow({ byte_length: 40 * 1024 * 1024 })] }]]);
    vi.mocked(headAsset).mockResolvedValue({ bytes: 40 * 1024 * 1024 });
    vi.mocked(fetchAssetStream).mockResolvedValue(streamResponse([new Uint8Array(16)]));

    const result = await ensureAttachmentBytes('msg-example-1', 0, { force: true });
    expect(result.cached).toBe(false);
    expect(storedFiles()).toHaveLength(1);
  });

  it('stamps a 502 as terminal and never re-requests it on the next view', async () => {
    const calls = [];
    let row = attachmentRow();
    vi.mocked(query).mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      calls.push(flat);
      if (flat.includes('FROM beeper_attachments WHERE message_id')) return { rows: [row] };
      if (flat.includes('SET unavailable_at = NOW()')) {
        row = { ...row, unavailable_at: '2026-09-03T00:00:00.000Z', fetch_error: params[2] };
        return { rows: [] };
      }
      return { rows: [] };
    });
    vi.mocked(headAsset).mockRejectedValue(unavailableError());

    await expect(ensureAttachmentBytes('msg-example-1', 0)).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    expect(calls.some((sql) => sql.includes('SET unavailable_at = NOW()'))).toBe(true);

    await expect(ensureAttachmentBytes('msg-example-1', 0)).rejects.toMatchObject({
      code: 'ASSET_UNAVAILABLE', status: 404,
    });
    // The second view short-circuits on the stamp — one probe, not a loop.
    expect(vi.mocked(headAsset)).toHaveBeenCalledTimes(1);
  });

  it('never turns a malformed stored path into a filesystem read — it re-acquires instead', async () => {
    // `local_path` is a DB column that becomes a path, and a mirror row may have
    // been written by any past version of PortOS. A value that is not this
    // layout's own `<sha256[0..2]>/<sha256>.<ext>` is refused as a path outright
    // rather than resolved and stat-ed.
    let row = attachmentRow({ local_path: '../../../etc/hosts' });
    vi.mocked(query).mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('FROM beeper_attachments WHERE message_id')) return { rows: [row] };
      if (flat.includes('SET local_path = $3')) {
        row = { ...row, local_path: params[2] };
        return { rows: [] };
      }
      return { rows: [] };
    });
    vi.mocked(headAsset).mockResolvedValue({ bytes: 2 });
    vi.mocked(fetchAssetStream).mockResolvedValue(streamResponse([new Uint8Array([1, 2])]));

    const result = await ensureAttachmentBytes('msg-example-1', 0);
    expect(result.filePath.startsWith(attachmentsRoot())).toBe(true);
    expect(result.filePath).not.toContain('etc/hosts');
  });

  it('heals a row whose file was removed from under it instead of 404ing', async () => {
    let row = attachmentRow({ local_path: `aa/${'a'.repeat(64)}.png`, fetched_at: '2026-09-01T00:00:00.000Z' });
    const cleared = [];
    vi.mocked(query).mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('FROM beeper_attachments WHERE message_id')) return { rows: [row] };
      if (flat.includes('SET local_path = NULL')) {
        cleared.push(flat);
        row = { ...row, local_path: null };
        return { rows: [] };
      }
      if (flat.includes('SET local_path = $3')) return { rows: [] };
      return { rows: [] };
    });
    vi.mocked(headAsset).mockResolvedValue({ bytes: 3 });
    vi.mocked(fetchAssetStream).mockResolvedValue(streamResponse([new Uint8Array([9, 9, 9])]));

    const result = await ensureAttachmentBytes('msg-example-1', 0);
    expect(cleared.length).toBe(1);
    expect(result.cached).toBe(false);
    expect(storedFiles()).toHaveLength(1);
  });
});

describe('evictToBudget — least-recently-viewed, guarded by a HEAD', () => {
  const relPath = `aa/${'a'.repeat(64)}.png`;

  const seedFile = (relativePath, bytes = 16) => {
    mkdirSync(join(attachmentsRoot(), relativePath.split('/')[0]), { recursive: true });
    writeFileSync(join(attachmentsRoot(), relativePath), Buffer.alloc(bytes));
  };

  it('never offers a row with no source reference as a candidate', async () => {
    respondTo([['unique_files', { rows: [{ bytes: String(10 * 1024 * 1024 * 1024), files: 1 }] }]]);
    await evictToBudget();
    // Eviction is only safe because the bytes can be fetched again; a row with
    // no `mxc_id` is precisely the one that could not be, so it is filtered in
    // the candidate query rather than skipped after selection (which would
    // re-select it forever).
    const candidateSql = vi.mocked(query).mock.calls
      .map(([sql]) => String(sql).replace(/\s+/g, ' '))
      .find((sql) => sql.includes('ORDER BY last_viewed_at ASC NULLS FIRST'));
    expect(candidateSql).toContain('mxc_id IS NOT NULL');
  });

  it('does nothing while the mirror fits its budget', async () => {
    respondTo([['unique_files', { rows: [{ bytes: '1024', files: 1 }] }]]);
    const result = await evictToBudget();
    expect(result).toMatchObject({ evicted: 0, overBudget: false });
    expect(vi.mocked(headAsset)).not.toHaveBeenCalled();
  });

  it('evicts the least-recently-viewed file once the source confirms it is re-fetchable', async () => {
    seedFile(relPath);
    let used = 10 * 1024 * 1024 * 1024;
    let candidateRemaining = true;
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('unique_files')) return { rows: [{ bytes: String(used), files: 1 }] };
      if (flat.includes('ORDER BY last_viewed_at ASC NULLS FIRST')) {
        return candidateRemaining
          ? { rows: [{ message_id: 'msg-example-1', idx: 0, mxc_id: 'mxc://example.invalid/abc', local_path: relPath, byte_length: 16 }] }
          : { rows: [] };
      }
      if (flat.includes('SET local_path = NULL')) { candidateRemaining = false; used = 0; return { rows: [] }; }
      if (flat.includes('WHERE local_path = $1 LIMIT 1')) return { rows: [] };
      return { rows: [] };
    });
    vi.mocked(headAsset).mockResolvedValue({ bytes: 16 });

    const result = await evictToBudget();
    expect(result.evicted).toBe(1);
    expect(existsSync(join(attachmentsRoot(), relPath))).toBe(false);
  });

  it('KEEPS a file the source can no longer supply, and takes it out of future candidate queries', async () => {
    seedFile(relPath);
    const marked = [];
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('unique_files')) return { rows: [{ bytes: String(10 * 1024 * 1024 * 1024), files: 1 }] };
      if (flat.includes('ORDER BY last_viewed_at ASC NULLS FIRST')) {
        return marked.length === 0
          ? { rows: [{ message_id: 'msg-example-1', idx: 0, mxc_id: 'mxc://example.invalid/abc', local_path: relPath, byte_length: 16 }] }
          : { rows: [] };
      }
      if (flat.includes('SET unavailable_at = NOW()')) { marked.push(flat); return { rows: [] }; }
      return { rows: [] };
    });
    vi.mocked(headAsset).mockRejectedValue(unavailableError());

    const result = await evictToBudget();
    expect(result).toMatchObject({ evicted: 0, keptUnavailable: 1 });
    expect(marked).toHaveLength(1);
    // The bytes Beeper can no longer supply are the last copy — still there.
    expect(existsSync(join(attachmentsRoot(), relPath))).toBe(true);
  });

  it('stops rather than evicting when the probe itself fails (Beeper closed)', async () => {
    seedFile(relPath);
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('unique_files')) return { rows: [{ bytes: String(10 * 1024 * 1024 * 1024), files: 1 }] };
      if (flat.includes('ORDER BY last_viewed_at ASC NULLS FIRST')) {
        return { rows: [{ message_id: 'msg-example-1', idx: 0, mxc_id: 'mxc://example.invalid/abc', local_path: relPath, byte_length: 16 }] };
      }
      return { rows: [] };
    });
    vi.mocked(headAsset).mockRejectedValue(new BeeperApiError('Beeper asset request failed: connection refused', {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    }));

    const result = await evictToBudget();
    expect(result).toMatchObject({ evicted: 0, overBudget: true });
    expect(existsSync(join(attachmentsRoot(), relPath))).toBe(true);
  });
});

describe('the store is content-addressed, so every unlink is reference-checked', () => {
  const relPath = `cc/${'c'.repeat(64)}.png`;

  it('keeps a forwarded file that another conversation still points at', async () => {
    mkdirSync(join(attachmentsRoot(), 'cc'), { recursive: true });
    writeFileSync(join(attachmentsRoot(), relPath), Buffer.alloc(32));
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('SELECT DISTINCT local_path FROM beeper_attachments WHERE conversation_id')) {
        return { rows: [{ local_path: relPath }] };
      }
      // A surviving row in ANOTHER conversation still points at these bytes.
      if (flat.includes('WHERE local_path = $1 LIMIT 1')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });

    const result = await purgeConversationAttachments(CONV);
    expect(result).toEqual({ removedFiles: 0, freedBytes: 0 });
    expect(existsSync(join(attachmentsRoot(), relPath))).toBe(true);
  });

  it('removes the file once nothing outside the purged conversation references it', async () => {
    mkdirSync(join(attachmentsRoot(), 'cc'), { recursive: true });
    writeFileSync(join(attachmentsRoot(), relPath), Buffer.alloc(32));
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('SELECT DISTINCT local_path FROM beeper_attachments WHERE conversation_id')) {
        return { rows: [{ local_path: relPath }] };
      }
      return { rows: [] };
    });

    const result = await purgeConversationAttachments(CONV);
    expect(result).toMatchObject({ removedFiles: 1, freedBytes: 32 });
    expect(existsSync(join(attachmentsRoot(), relPath))).toBe(false);
  });
});

describe('sweepAttachmentOrphans — the backstop, both directions', () => {
  it('removes a file no row points at and heals a row whose file is gone', async () => {
    const orphan = `ee/${'e'.repeat(64)}.png`;
    const missing = `11/${'1'.repeat(64)}.png`;
    mkdirSync(join(attachmentsRoot(), 'ee'), { recursive: true });
    writeFileSync(join(attachmentsRoot(), orphan), Buffer.alloc(8));
    // Backdated past the sweep's age gate: a file linked into place seconds ago
    // may be a download whose row update has not landed yet, so only an old
    // unreferenced file counts as an orphan.
    const hoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    utimesSync(join(attachmentsRoot(), orphan), hoursAgo, hoursAgo);

    const healed = [];
    vi.mocked(query).mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('SELECT DISTINCT local_path FROM beeper_attachments WHERE local_path IS NOT NULL')) {
        return { rows: [{ local_path: missing }] };
      }
      if (flat.includes('WHERE local_path = ANY')) { healed.push(params[0]); return { rowCount: 1 }; }
      return { rows: [] };
    });

    const result = await sweepAttachmentOrphans();
    expect(result).toMatchObject({ orphansRemoved: 1, healedRows: 1 });
    expect(existsSync(join(attachmentsRoot(), orphan))).toBe(false);
    expect(healed[0]).toEqual([missing]);
  });

  it('spares an unreferenced file young enough to be a download still finishing', async () => {
    const fresh = `dd/${'d'.repeat(64)}.png`;
    mkdirSync(join(attachmentsRoot(), 'dd'), { recursive: true });
    writeFileSync(join(attachmentsRoot(), fresh), Buffer.alloc(8));
    respondTo([['SELECT DISTINCT local_path FROM beeper_attachments WHERE local_path IS NOT NULL', { rows: [] }]]);

    const result = await sweepAttachmentOrphans();
    expect(result.orphansRemoved).toBe(0);
    expect(existsSync(join(attachmentsRoot(), fresh))).toBe(true);
  });
});

describe('the backfill census the consent step has to state', () => {
  it('counts unknown-size attachments separately instead of adding them as zero', async () => {
    respondTo([
      ['unique_files', { rows: [{ bytes: '2048', files: 2 }] }],
      ['COUNT(*) FILTER', { rows: [{ pending: 12, pending_bytes: '4096', pending_unknown: 3, over_cap: 1, unavailable: 2, kept: 1, total: 20 }] }],
    ]);
    const summary = await getAttachmentSummary();
    expect(summary).toMatchObject({
      usedBytes: 2048, pendingCount: 12, pendingBytes: 4096, pendingUnknownCount: 3, overCapCount: 1,
    });
    expect(summary.budgetBytes).toBe(5 * 1024 * 1024 * 1024);
  });

  it('counts a failed attachment and carries on through the rest of the run', async () => {
    const pending = [
      { message_id: 'msg-example-1', idx: 0 },
      { message_id: 'msg-example-2', idx: 0 },
    ];
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('ORDER BY created_at ASC')) return { rows: pending };
      if (flat.includes('unique_files')) return { rows: [{ bytes: '0', files: 0 }] };
      if (flat.includes('FROM beeper_attachments WHERE message_id')) {
        return { rows: [attachmentRow({ message_id: 'msg-example-1' })] };
      }
      return { rows: [] };
    });
    vi.mocked(headAsset)
      .mockRejectedValueOnce(unavailableError())
      .mockResolvedValueOnce({ bytes: 4 });
    vi.mocked(fetchAssetStream).mockResolvedValue(streamResponse([new Uint8Array([7, 7, 7, 7])]));

    const result = await backfillAttachments({ limit: 10 });
    expect(result).toMatchObject({ requested: 2, fetched: 1, failed: 1, stoppedForBudget: false });
  });

  it('stops at the disk budget rather than blowing through it', async () => {
    vi.mocked(getSettings).mockResolvedValue({ beeper: { attachmentBudgetGb: 0.000001 } });
    vi.mocked(query).mockImplementation(async (sql) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('ORDER BY created_at ASC')) return { rows: [{ message_id: 'msg-example-1', idx: 0 }] };
      if (flat.includes('unique_files')) return { rows: [{ bytes: '999999999', files: 9 }] };
      return { rows: [] };
    });

    const result = await backfillAttachments({});
    expect(result).toMatchObject({ fetched: 0, stoppedForBudget: true });
    expect(vi.mocked(fetchAssetStream)).not.toHaveBeenCalled();
  });
});

describe('shapeAttachment', () => {
  it('reads an unknown byte length as unknown, never as over-cap', () => {
    expect(shapeAttachment(attachmentRow({ byte_length: null }))).toMatchObject({
      byteLength: null, overCap: false, stored: false, unavailable: false,
    });
  });

  it('separates "stored" from "unavailable" — a mirrored file whose source aged out is both', () => {
    const shaped = shapeAttachment(attachmentRow({
      local_path: `aa/${'a'.repeat(64)}.png`,
      unavailable_at: '2026-09-01T00:00:00.000Z',
      fetch_error: 'Failed to download asset',
      byte_length: 40 * 1024 * 1024,
    }));
    expect(shaped).toMatchObject({ stored: true, unavailable: true, overCap: true });
  });
});
