# Definition of Done & Acceptance Criteria Verification

This document verifies the completion of the **Scalable File Upload & Streaming Media Service** against the project plan's **Final Definition of Done (Section 18)** and **Testing and Acceptance Criteria (Section 11)**.

Every automated claim cites a test title copied verbatim from `test_output.txt`. Any visual or interactive user-interface behavior is explicitly classified as manual.

---

## 1. Final Definition of Done (All 8 Bullets)

| # | Requirement | Status | Verification Method | Exact Verbatim Test Title |
|---|---|---|---|---|
| 1 | **A file can be uploaded in chunks, interrupted, resumed, finalized, and downloaded with identical bytes.** | Verified | Automated | `Happy path: upload ~5.5 MiB, finalize with whole-file sha256 -> 200 and published media`<br>`Full upload + finalize of ~5.5 MiB Blob matches source and SHA`<br>`stopAfter 3 then resume sends ONLY remaining chunks and resendEfficiency is 0`<br>`GET full representation -> 200, Content-Length 5767168, ETag, SHA matches` |
| 2 | **The server does not load an entire large file into a single Buffer.** | Verified | Automated | `Streaming not buffering: 40 MiB download samples RSS every 20ms and stays bounded` |
| 3 | **Every committed chunk has a validated byte range and checksum.** | Verified | Automated | `bad X-Chunk-SHA256 -> 422 CHECKSUM_MISMATCH & temp file cleaned`<br>`wrong Content-Length vs range -> 422 rejected, no chunk file, no metadata`<br>`Content-Range range not matching index -> 422` |
| 4 | **Duplicate retries are safe and do not inflate progress.** | Verified | Automated | `re-send same chunk with same checksum -> 200 duplicate:true`<br>`5 parallel requests for the SAME index -> exactly one 201, four 200 duplicate:true`<br>`ledger - committedBytes ignores duplicates` |
| 5 | **Incomplete uploads cannot be finalized.** | Verified | Automated | `Gap: upload 4 of 6 chunks, finalize -> 409 INCOMPLETE_UPLOAD with correct missingChunks and missingRanges` |
| 6 | **HTTP byte-range requests return correct 206/416 behavior and exact bytes.** | Verified | Automated | `Range 0-1023 -> 206, Content-Range bytes 0-1023/5767168, 1024 bytes matching source`<br>`Unsatisfiable ranges -> 416 with Content-Range bytes */5767168 and JSON error` |
| 7 | **Performance metrics are computed with explicit units and timing definitions.** | Verified | Automated | `metrics-math: bytesPerSecond and toMiBps calculation (20 MiB in 4s = 5 MiB/s)`<br>`metrics-math: mergeActiveIntervals handles overlap, small gaps, and distinct gaps`<br>`Sequential upload of 6 chunks: counters, sizes, timing, throughput, ETA progression`<br>`/api/recommendation/chunk-size and /api/stats routing and output validation` |
| 8 | **The demo clearly proves interruption recovery, integrity checks and seeking.** | Verified | Automated & Manual | **Automated**:<br>`stopAfter 3 then resume sends ONLY remaining chunks and resendEfficiency is 0`<br>`corruptIndex: exactly one PUT attempt, no retry, in-flight chunks finish, resume completes`<br>**Manual**:<br>Browser UI interactive verification (file selection, pause toggle, resume action, seeking in media player) as described in DEMO.md. |

---

## 2. Testing and Acceptance Criteria Table (15 Rows)

| # | Test Scenario | Expected Result | Status | Exact Verbatim Test Title |
|---|---|---|---|---|
| 1 | **Small file upload** | Final file byte-for-byte equals source | Verified | `Happy path: upload ~5.5 MiB, finalize with whole-file sha256 -> 200 and published media` |
| 2 | **Large file upload** | No whole-file buffering; bounded memory behavior | Verified | `Streaming not buffering: 40 MiB download samples RSS every 20ms and stays bounded` |
| 3 | **Last partial chunk** | Exact shorter length accepted | Verified | `last partial chunk accepted with its exact shorter length` |
| 4 | **Wrong Content-Length/range** | Rejected with 400/422; no commit | Verified | `wrong Content-Length vs range -> 422 rejected, no chunk file, no metadata` |
| 5 | **Corrupt checksum** | Rejected; temp file cleaned or quarantined | Verified | `bad X-Chunk-SHA256 -> 422 CHECKSUM_MISMATCH & temp file cleaned` |
| 6 | **Disconnect during chunk** | Incomplete temp chunk not marked committed | Verified | `client disconnect mid-chunk -> temp cleaned, not recorded` |
| 7 | **Resume after interruption** | Only missing chunks are sent again | Verified | `stopAfter 3 then resume sends ONLY remaining chunks and resendEfficiency is 0` |
| 8 | **Duplicate matching chunk** | Idempotent success; progress unchanged | Verified | `re-send same chunk with same checksum -> 200 duplicate:true` |
| 9 | **Duplicate conflicting chunk** | 409 conflict; committed chunk remains intact | Verified | `re-send same index with different checksum -> 409 CHUNK_CONFLICT` |
| 10 | **Finalize with a gap** | Rejected with missing range details | Verified | `Gap: upload 4 of 6 chunks, finalize -> 409 INCOMPLETE_UPLOAD with correct missingChunks and missingRanges` |
| 11 | **Full GET / HEAD** | Correct headers; HEAD returns no body | Verified | `HEAD full representation -> 200, identical headers, 0 body bytes`<br>`GET full representation -> 200, Content-Length 5767168, ETag, SHA matches` |
| 12 | **Valid byte range** | 206; exact requested bytes returned | Verified | `Range 0-1023 -> 206, Content-Range bytes 0-1023/5767168, 1024 bytes matching source` |
| 13 | **Out-of-bounds range** | 416 and Content-Range: bytes */size | Verified | `Unsatisfiable ranges -> 416 with Content-Range bytes */5767168 and JSON error` |
| 14 | **Parallel chunk requests** | No metadata corruption or duplicate byte counting | Verified | `5 parallel requests for the SAME index -> exactly one 201, four 200 duplicate:true`<br>`parallel mix: 6 different indices + duplicates of 2 at same time` |
| 15 | **Traversal filename** | Cannot escape storage directory | Verified | `disallowed contentType -> 415; traversal filename uses safe stored name inside storageRoot`<br>`paths - assertInsideStorageRoot rejects paths outside root without leaking root path` |

---

## 3. Items Classified as Manual Verification

1. **Browser Visual UI Interaction**: Visual confirmation of the upload progress bar, chunk ledger states, and pause/resume button interactions in an interactive desktop browser.
2. **HTML5 `<video>` Player Seeking**: Scrubbing within the native browser media player and observing seamless 206 Partial Content playback. Step-by-step manual test procedures are documented in `DEMO.md`.
