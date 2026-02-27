# Batch Upload + Background Vectorization + Reliable Pinecone Indexing

This guide describes a production-safe approach for this app to support:

1. Uploading many documents quickly (`dump first`),
2. Running extraction/vectorization asynchronously (including user-command triggers),
3. Ensuring embeddings are fully and correctly indexed in Pinecone.

---

## 1) Current capabilities in this repo

The codebase already contains most primitives needed:

- **Background vectorization endpoint**: `POST /api/v1/documents/{id}/vectorize` with `useBackgroundJob: true`.
- **Inngest event model**: `document/vectorize.requested|progress|completed|failed`.
- **Vectorization worker**: `vectorize-document` function with progress + failure handling.
- **Pinecone namespace isolation** per organization.
- **BatchProcessing table** for tracking batch jobs.

What still needs adjustment for “upload all first, process later” at scale:

- Upload path currently triggers basic processing inline.
- No first-class batch ingest API that queues many docs in one operation.
- Partial indexing is possible when some embedding batches fail; explicit retry/final verification loop should be added.

---

## 2) Target architecture

Use a **4-stage pipeline** with explicit status transitions in `document.processing`:

1. `UPLOADED` – metadata + file stored.
2. `TEXT_EXTRACTED` – extraction complete (`extractedText` present).
3. `VECTORIZING` – embeddings generation + Pinecone upsert in progress.
4. `INDEXED` – all expected chunks successfully indexed and verified.

Plus terminal error states:

- `FAILED_EXTRACT`
- `FAILED_VECTORIZE`
- `PARTIAL_INDEXED` (temporary state; should trigger retries)

### Why this works

- Upload API stays fast and resilient.
- Retries become deterministic and idempotent.
- Search only runs on fully indexed docs (or intentionally includes partial docs with reduced confidence).

---

## 3) API contract proposal

### 3.1 `POST /api/v1/documents/batch-ingest`

**Purpose:** Accept many files (or file references), create docs, and enqueue async processing.

**Request (example):**

```json
{
  "organizationId": "org_123",
  "folderId": "fld_456",
  "documentIds": ["doc_1", "doc_2", "doc_3"],
  "options": {
    "autoVectorize": true,
    "chunkSize": 1500,
    "overlap": 200,
    "priority": "normal"
  }
}
```

**Response:**

- `202 Accepted`

```json
{
  "success": true,
  "batchId": "batch_20260226_abc123",
  "status": "queued",
  "totalDocuments": 3,
  "message": "Batch accepted and queued"
}
```

### 3.2 `GET /api/v1/documents/batch-ingest/{batchId}/status`

Returns:

- `status` (`queued|processing|completed|failed|partial`)
- `processedDocuments`
- `failedDocuments`
- per-document statuses + last error

### 3.3 User-command (manual) trigger APIs

Yes — asynchronous extraction/vectorization can and should run on explicit user command.

Use two trigger modes:

1. **Automatic mode** (default): enqueue jobs right after upload.
2. **Manual mode** (user-command): upload first, then user clicks **"Process"** or **"Vectorize"**.

Recommended manual trigger endpoints:

- `POST /api/v1/documents/{id}/process/basic` with `{ "useBackgroundJob": true }`
- `POST /api/v1/documents/{id}/vectorize` with `{ "useBackgroundJob": true }`

Manual mode UX pattern:

- Document appears as `UPLOADED` after ingest.
- User explicitly starts extraction/vectorization per document or for selected documents.
- UI polls status endpoint and shows progress/events.

Manual mode is useful when:

- Users want control over API/token spend.
- Teams need approval before indexing sensitive documents.
- You want to prioritize only selected documents first.


### 3.4 Re-dump behavior (no re-vectorization for already processed docs)

When new documents are dumped into the system, it should **not** create vectors again for documents that are already processed/indexed unless explicitly requested.

Required behavior:

- During batch orchestration, pre-check each document:
  - `hasExtractedText = extractedText exists`
  - `hasEmbeddings = embeddings.chunks exists and length > 0`
  - `statusIndexed = processing.currentStatus in {"INDEXED", "COMPLETED"}`
- If `hasEmbeddings && statusIndexed` and `forceReprocess=false`, mark document as `SKIPPED_ALREADY_INDEXED` for this batch and do **not** enqueue vectorization.
- Only enqueue vectorization if:
  - document is new / not yet indexed, or
  - `forceReprocess=true`, or
  - content changed (hash/version mismatch).

Batch status should include skip counters:

- `processedDocuments`
- `failedDocuments`
- `skippedDocuments` (already indexed / unchanged)

This keeps ingestion idempotent, reduces cost, and prevents duplicate work.

---

## 4) Orchestration flow

### Step A: batch record creation

- Insert `BatchProcessing` row (`status=queued`, counts initialized).
- Emit `document/batch.process` event with `{batchId, documentIds, organizationId, userId, options}`.

### Step B: extraction phase (fan-out)

For each document:

- If already indexed and unchanged (`hasEmbeddings && statusIndexed && forceReprocess=false`), mark as `SKIPPED_ALREADY_INDEXED` and skip both extraction/vectorization.
- Else if `extractedText` already exists and `forceReprocess=false`, skip extraction only.
- Else enqueue/run `document/process-basic.requested`.

### Step C: vectorization phase (fan-out)

For each extraction-complete document:

- Emit `document/vectorize.requested`.
- Worker chunk/embed/upserts to Pinecone namespace.

### Step D: verification + finalize

For each doc marked complete by worker:

- Verify expected chunk count equals indexed chunk count.
- If mismatch: mark doc `PARTIAL_INDEXED` and enqueue retry for missing chunks.
- Batch marked `completed` only when all docs are `INDEXED` (or `failed`/`partial` with explicit policy).

---

## 5) Reliability rules (important)

### 5.1 Idempotent vector IDs

Keep deterministic vector IDs (already done with `orgId_chunkId` style IDs), so retries upsert safely without duplicates.

### 5.2 Chunk-hash metadata

Store `chunkHash` + `documentVersion` in Pinecone metadata and in document embeddings JSON:

- If chunk content unchanged, skip regeneration (do not enqueue vectorization for unchanged docs/chunks).
- If changed, regenerate only changed chunks.
- Re-dump of already indexed unchanged documents must be a no-op unless `forceReprocess=true`.

### 5.3 Partial failure policy

If any embedding batch fails:

- Do **not** declare final `INDEXED`.
- Persist `failedChunkIds`.
- Retry only failed chunks with exponential backoff.
- Escalate to `FAILED_VECTORIZE` after max retries.

### 5.4 Verification gate

Before final status transition:

- Compare expected chunk count to successfully indexed chunks.
- Persist verification timestamp + checksum/hash snapshot.

---

## 6) Suggested status payload shape

Store in `document.processing`:

```json
{
  "currentStatus": "VECTORIZING",
  "progress": 65,
  "currentStep": "Processing batch 4/8",
  "jobId": "vectorize_doc_123_...",
  "attempt": 2,
  "maxAttempts": 5,
  "failedChunkIds": ["ch_7", "ch_8"],
  "expectedChunks": 42,
  "indexedChunks": 34,
  "verification": {
    "verified": false,
    "verifiedAt": null
  },
  "events": []
}
```

---

## 7) Operational defaults

- Inngest vectorization concurrency: **3** (good starting point).
- OpenAI embedding timeout: keep hard timeout and retry on transient errors.
- Pinecone upsert/query timeout: keep current timeout protection.
- Batch size: start around **50–200 docs** depending on average size.

---

## 8) Minimal implementation sequence (recommended)

1. **Decouple upload**: remove inline basic processing from upload path; queue event instead.
2. **Add batch ingest API** backed by `BatchProcessing`.
3. **Create batch orchestrator Inngest function** for extraction/vectorization fan-out.
4. **Add verification/retry loop** for partial indexing.
5. **Expose batch status endpoint** for UI and observability.

### Optional: user-command-first rollout

If product wants explicit user control from day 1:

1. Ship ingest with `autoVectorize=false` by default.
2. Add UI actions: **Process Basic** and **Vectorize**.
3. Trigger background jobs only from those actions.
4. Keep "Auto-process on upload" as an org-level setting.

---

## 9) Acceptance criteria checklist

- [ ] Uploading 100+ docs returns quickly (no long blocking requests).
- [ ] Batch status endpoint reports accurate processed/failed counts.
- [ ] Every indexed document passes verification (`expectedChunks == indexedChunks`).
- [ ] Retry mechanism resolves transient Pinecone/OpenAI failures.
- [ ] Search uses only `INDEXED` documents by default.
- [ ] Failed docs are isolated and re-runnable without re-upload.

---

## 10) Notes for this codebase

- Existing vectorization/background job plumbing is solid and should be reused.
- `BatchProcessing` model and `document/batch.process` event type are already available for orchestration scaffolding.
- Main gap is consistent end-to-end **batch orchestration + verification gate**.
