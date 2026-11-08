# 7-Minute Interactive Demo Script: Scalable Resumable File Upload & Streaming Media Service

This document provides a timed, step-by-step walkthrough for demonstrating the core resilience, transfer ledger verification, performance telemetry, and HTTP Range streaming capabilities of the system.

---

## Pre-Demo Checklist

1. **Working Directory & Server Execution**:
   - Verify the server is started from the project directory:
     ```bash
     cd file-stream-service
     node src/server.js
     ```
   - Confirm server starts on `http://127.0.0.1:3000/`.
2. **Browser Environment**:
   - Open Chrome, Firefox, or Edge in incognito/clean mode to `http://127.0.0.1:3000/`.
   - **Crucial**: Ensure URL is strictly `http://127.0.0.1:3000/` or `http://localhost:3000/` so `crypto.subtle` is enabled under Secure Context requirements.
3. **Demo Media Assets**:
   - Prepare a real small/medium MP4 file (e.g. ~10–20 MiB, H.264 video with AAC audio) for the upload demo.
   - Alternatively, generate a 12 MiB seeded test file using the CLI tool:
     ```bash
     node scripts/generate-test-file.js /tmp/demo-12m.mp4 12582912 42
     ```
4. **DevTools**:
   - Open Browser Developer Tools (`F12` or `Cmd+Option+I`) to the **Network** tab.
   - Filter by `Fetch/XHR` or `media` to observe chunk PUTs and 206 Partial Content range requests.

---

## Timed Walkthrough (0:00 – 7:00)

### 0:00 – 0:45 | Architecture & Core Principles
- **Talking Points**:
  - The service is implemented in pure Node.js with **zero third-party dependencies** (`http`, `fs`, `crypto`, `stream`).
  - Traditional uploads rely on continuous connections or coarse-grained retries; here, uploads are treated as a **durable, verified ledger**.
  - Every 1 MiB chunk is independently SHA-256 hashed on the client, verified on the fly by the server, and atomically recorded in a crash-resilient metadata journal with `fsync`.
  - Application memory is strictly bounded (streaming pipelines; no multi-megabyte buffering).

---

### 0:45 – 1:45 | Upload Initialization & Proof-of-Progress Ledger
- **Actions in Browser**:
  1. Select the prepared MP4 file (`demo-12m.mp4`).
  2. Content-Type automatically detects `video/mp4`.
  3. Set Chunk Size to `1 MiB` and Concurrency to `2 workers`.
  4. Click **Start Upload**.
- **Talking Points**:
  - Point to the **Ingestion State Pills** transitioning from `created` to `uploading`.
  - Point to the **Proof-of-Progress Ledger Grid**:
    - Each cell indicates chunk state using both colors and distinct glyphs: `⏳` (in-flight) and `✔` (committed).
    - Cells are aggregated using bounded bucketing (at most 256 cells) so files of 50 GB don't cause browser DOM bloat.
  - Show the **Durable Progress Bar**: strictly reflects server-verified `committedBytes`, never unverified in-flight network bytes.

---

### 1:45 – 2:45 | Interruption & Authoritative Server Status
- **Actions in Browser**:
  1. Mid-upload (around 40% completion), click **Interrupt**.
  2. Observe immediate worker halt; in-flight requests abort gracefully via `AbortController`.
  3. Point to the ledger: committed chunks remain green (`✔`), in-flight chunks revert to missing (`·`).
  4. Note the displayed committed vs. missing byte ranges in the text summary.
- **Terminal Demonstration (Show Truth in Ledger)**:
  Run a curl command to inspect the authoritative server-side metadata:
  ```bash
  # Query server ledger status (replace <uploadId> with the ID displayed in the UI)
  curl -s http://127.0.0.1:3000/api/uploads/<uploadId> | json_pp
  ```
  *Key Output to Highlight*: `state: "uploading"`, `committedBytes`, `committedChunks`, and explicit `missingChunks: [5, 6, 7, 8, 9, 10, 11]`.

---

### 2:45 – 3:45 | Resume & Zero Resend Waste
- **Actions in Browser**:
  1. Click **Resume** (or reload the page; the file fingerprint in `localStorage` restores the session and shows "Resume available").
  2. Click **Resume**.
- **Talking Points**:
  - The client queries `GET /api/uploads/:id` to ask the server: *"What do you actually have?"*
  - Notice that workers do **NOT** re-upload chunks 0 through 4! Only missing chunks (5 to 11) are dispatched across the wire.
  - Point to **Resend Efficiency**: stays at `0%` (or 0 bytes resent), proving zero wasted bandwidth.

---

### 3:45 – 4:30 | Integrity Failure Injection & Self-Healing Repair
- **Actions in Browser**:
  1. Before starting a new upload (or with a second demo file), under **Demo Tools**:
     - Check **Corrupt checksum of chunk I** and enter index `1`.
     - Set Concurrency to `2`.
     - Click **Start Upload**.
  2. Observe chunk 1 fail immediately with a red `✖` and a visible error notification: `422 CHUNK_CHECKSUM_MISMATCH`.
  3. Notice that other workers continue and complete their chunks, while chunk 1 is permanently rejected and omitted from the server ledger.
  4. Click **Resume**:
     - The client queries the ledger, discovers chunk 1 is missing, computes the correct SHA-256, and successfully uploads and commits chunk 1.
- **Terminal Demonstration (Raw 422 Check)**:
  ```bash
  # Attempt uploading a corrupted chunk manually
  curl -i -X PUT http://127.0.0.1:3000/api/uploads/<uploadId>/chunks/1 \
    -H "Content-Range: bytes 1048576-2097151/12582912" \
    -H "X-Chunk-SHA256: 0000000000000000000000000000000000000000000000000000000000000000" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @/tmp/chunk1.bin
  ```
  *Output*: Returns `422 Unprocessable Entity` with `{"error":{"code":"CHUNK_CHECKSUM_MISMATCH"}}`.

---

### 4:30 – 5:30 | Finalization, Video Playback & HTTP Range Streaming
- **Actions in Browser**:
  1. Allow upload to reach 100% and finalize automatically (or click **Finalize**).
  2. State pill transitions to `finalizing` (assembly and disk-level whole-file SHA-256 verification), then `ready`.
  3. Media appears in the **Media Library** panel and loads into the embedded `<video controls>` player.
  4. Press Play, then drag the player's seek bar to 80% duration.
  5. Open DevTools Network tab: show that seeking triggers `206 Partial Content` with `Content-Range: bytes <offset>-<end>/<total>` rather than re-downloading the entire video.
- **Actions in Range Probe Widget**:
  1. Click **First 1 KiB**: shows status `206 Partial Content`, `Content-Range: bytes 0-1023/12582912`, `Content-Length: 1024`.
  2. Click **Last 500 bytes (suffix)**: shows status `206 Partial Content`, `Content-Range: bytes 12582412-12582911/12582912`.
  3. Click **Past EOF (expect 416)**: shows status `416 Range Not Satisfiable`, `Content-Range: bytes */12582912`.
  4. Click **Malformed (expect 400)**: sends `bytes=500-100` and displays status `400 Bad Request`.

---

### 5:30 – 6:30 | Real-Time Telemetry & Heuristic Chunk Recommendation
- **Actions in Browser**:
  1. Point to the **Metrics Panel**:
     - **Server Throughput vs. Client Throughput**: Client throughput includes hashing and socket scheduling overhead; server throughput reflects disk commit rate.
     - **Active Time vs. Wall Clock Time**: `activeMs` merges parallel intervals with a 1,000 ms gap tolerance so pauses are not counted as active transfer time.
     - **ETA**: Computed dynamically based on windowed transfer history.
     - **Per-chunk Ledger Table**: Shows every committed chunk, verified SHA-256, and timestamp.
  2. Click **Query Server Recommendation**:
     - Shows recommended chunk size (e.g., 2 MiB or 4 MiB) and explanation.
     - Emphasize talking point: this is an **advisory heuristic** for new uploads; the protocol strictly respects client-chosen chunk sizes.

---

### 6:30 – 7:00 | Tradeoffs & Limitations Summary
- **Key Takeaways**:
  - **Memory Boundedness**: Fixed 64 KiB stream buffers; at most `concurrency × chunkSize` memory allocated at any moment.
  - **Single-Source-of-Truth**: The server ledger is authoritative; client local state is purely advisory.
  - **Limitations**:
    - Single-node local storage (no distributed cluster or S3 backend).
    - Browser skips whole-file SHA-256 before upload because W3C SubtleCrypto lacks streaming digest capabilities; the server computes the whole-file hash during disk assembly.
    - Single HTTP range streaming per request (RFC 9110 multipart/byteranges is not supported).

---

## Direct Terminal Verification Commands

```bash
# 1. Inspect static asset serving with security headers
curl -i http://127.0.0.1:3000/

# 2. Inspect allow-listed JS asset with ETag
curl -I http://127.0.0.1:3000/app.js

# 3. Path traversal protection (must return 404 without leaking server paths)
curl -i http://127.0.0.1:3000/../package.json --path-as-is

# 4. Method not allowed protection
curl -i -X POST http://127.0.0.1:3000/

# 5. List published media
curl -s http://127.0.0.1:3000/api/media | json_pp

# 6. Stream range request
curl -i -H "Range: bytes=0-1023" http://127.0.0.1:3000/api/media/<mediaId>

# 7. Past-end range request (416)
curl -i -H "Range: bytes=999999999-" http://127.0.0.1:3000/api/media/<mediaId>
```

---

## Troubleshooting Guide

| Issue | Cause | Fix |
| :--- | :--- | :--- |
| `crypto.subtle is undefined` or hash errors in browser | Accessed via plain IP (e.g. `192.168.1.x`) | Always open via `http://127.0.0.1:3000/` or `http://localhost:3000/`. |
| Port 3000 in use (`EADDRINUSE`) | Existing node process still running | Run `lsof -i :3000` and kill the old process (`kill -9 <PID>`). |
| Media player will not play video | Uploaded file was not valid MP4 (e.g. arbitrary random bytes) | Use a real `.mp4` video with H.264 video codec. Random bytes will download but cannot decode in `<video>`. |
| `409 Conflict: INCOMPLETE_UPLOAD` on Finalize | Chunks missing from upload ledger | Click Resume to upload remaining chunks before finalizing. |
| Browser tab crashes on upload | Attempting to hash whole multi-GB file in browser memory | Use the provided `public/uploader.js` which hashes chunk-by-chunk and delegates whole-file hash to the server. |
