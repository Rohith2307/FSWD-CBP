(function () {
  'use strict';

  // Global references to modular helpers
  const chunkMath = window.FSS.chunkMath;
  const uploaderLib = window.FSS.uploader;
  const ledgerView = window.FSS.ledgerView;

  // DOM Elements
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const dropzoneLabel = document.getElementById('dropzone-label');
  const fileDetails = document.getElementById('file-details');
  const typeWarning = document.getElementById('type-warning');
  const resumeBanner = document.getElementById('resume-banner');
  const btnFreshUpload = document.getElementById('btn-fresh-upload');

  const selectContentType = document.getElementById('select-content-type');
  const selectChunkSize = document.getElementById('select-chunk-size');
  const btnGetRec = document.getElementById('btn-get-rec');
  const recInfo = document.getElementById('rec-info');
  const selectConcurrency = document.getElementById('select-concurrency');
  const checkAutoFinalize = document.getElementById('check-auto-finalize');

  const inputStopAfter = document.getElementById('input-stop-after');
  const inputCorruptChunk = document.getElementById('input-corrupt-chunk');

  const btnStart = document.getElementById('btn-start');
  const btnInterrupt = document.getElementById('btn-interrupt');
  const btnResume = document.getElementById('btn-resume');
  const btnFinalize = document.getElementById('btn-finalize');

  const progressBarDurable = document.getElementById('progress-bar-durable');
  const progressPct = document.getElementById('progress-pct');
  const progressBytes = document.getElementById('progress-bytes');
  const progressInflight = document.getElementById('progress-inflight');
  const ledgerGrid = document.getElementById('ledger-grid');
  const rangesCommitted = document.getElementById('ranges-committed');
  const rangesMissing = document.getElementById('ranges-missing');

  const metricServerSpeed = document.getElementById('metric-server-speed');
  const metricClientSpeed = document.getElementById('metric-client-speed');
  const metricEta = document.getElementById('metric-eta');
  const metricTimes = document.getElementById('metric-times');
  const metricResendEff = document.getElementById('metric-resend-eff');
  const metricRetries = document.getElementById('metric-retries');
  const metricIntegrity = document.getElementById('metric-integrity');
  const metricAssembly = document.getElementById('metric-assembly');

  const finalShaWrap = document.getElementById('final-sha-wrap');
  const finalShaVal = document.getElementById('final-sha-val');
  const chunksTableBody = document.getElementById('chunks-table-body');

  const mediaList = document.getElementById('media-list');
  const btnRefreshMedia = document.getElementById('btn-refresh-media');
  const playerContainer = document.getElementById('player-container');
  const mediaInfo = document.getElementById('media-info');
  const infoName = document.getElementById('info-name');
  const infoSize = document.getElementById('info-size');
  const infoType = document.getElementById('info-type');
  const infoSha = document.getElementById('info-sha');
  const infoDownload = document.getElementById('info-download');

  const probeForm = document.getElementById('probe-form');
  const inputCustomRange = document.getElementById('input-custom-range');
  const btnSendProbe = document.getElementById('btn-send-probe');
  const probeResultBox = document.getElementById('probe-result-box');
  const probeStatus = document.getElementById('probe-status');
  const probeHeadersBody = document.getElementById('probe-headers-body');

  const errorBanner = document.getElementById('error-banner');
  const errorCode = document.getElementById('error-code');
  const errorMessage = document.getElementById('error-message');
  const btnDismissError = document.getElementById('btn-dismiss-error');
  const liveAnnouncer = document.getElementById('live-announcer');

  const pillCreated = document.getElementById('pill-created');
  const pillUploading = document.getElementById('pill-uploading');
  const pillFinalizing = document.getElementById('pill-finalizing');
  const pillReady = document.getElementById('pill-ready');

  // Application State
  let selectedFile = null;
  let fileFingerprint = null;
  let currentUploadId = null;
  let activeUploader = null;
  let metricsPollTimer = null;
  let selectedMedia = null;

  let stateByIndex = {};
  let totalChunksCount = 0;
  let inFlightCount = 0;

  // LocalStorage Helpers (wrapped in try/catch)
  function getStoredUploadId(fp) {
    try {
      return localStorage.getItem('fss_upload_' + fp);
    } catch {
      return null;
    }
  }

  function setStoredUploadId(fp, id) {
    try {
      localStorage.setItem('fss_upload_' + fp, id);
    } catch {}
  }

  function removeStoredUploadId(fp) {
    try {
      localStorage.removeItem('fss_upload_' + fp);
    } catch {}
  }

  // Announce messages to screen readers
  function announce(msg) {
    if (liveAnnouncer) {
      liveAnnouncer.textContent = msg;
    }
  }

  // Error Banner Display
  function showError(code, message) {
    errorCode.textContent = code ? `[${code}] ` : '';
    errorMessage.textContent = message || 'An unexpected error occurred';
    errorBanner.classList.remove('is-hidden');
    announce(`Error: ${code} ${message}`);
  }

  function hideError() {
    errorBanner.classList.add('is-hidden');
    errorCode.textContent = '';
    errorMessage.textContent = '';
  }

  btnDismissError.addEventListener('click', hideError);

  // State Pills
  function setSessionState(state) {
    pillCreated.classList.remove('is-active', 'is-completed');
    pillUploading.classList.remove('is-active', 'is-completed');
    pillFinalizing.classList.remove('is-active', 'is-completed');
    pillReady.classList.remove('is-active', 'is-completed');

    if (state === 'created') {
      pillCreated.classList.add('is-active');
    } else if (state === 'uploading') {
      pillCreated.classList.add('is-completed');
      pillUploading.classList.add('is-active');
    } else if (state === 'finalizing') {
      pillCreated.classList.add('is-completed');
      pillUploading.classList.add('is-completed');
      pillFinalizing.classList.add('is-active');
    } else if (state === 'ready') {
      pillCreated.classList.add('is-completed');
      pillUploading.classList.add('is-completed');
      pillFinalizing.classList.add('is-completed');
      pillReady.classList.add('is-active', 'is-completed');
    }
  }

  // Format Bytes Utility
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MiB';
    return (bytes / 1073741824).toFixed(2) + ' GiB';
  }

  // Content-Type Detection & Selection
  const ALLOWED_CONTENT_TYPES = [
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/ogg',
    'image/png',
    'image/jpeg',
    'application/octet-stream'
  ];

  function handleFileSelected(file) {
    if (!file) return;
    selectedFile = file;
    fileFingerprint = `${file.name}-${file.size}-${file.lastModified}`;

    dropzoneLabel.textContent = file.name;
    fileDetails.textContent = `${formatBytes(file.size)} (${file.size} bytes)`;

    // Content Type Auto-Detection
    const fileType = (file.type || '').toLowerCase();
    if (ALLOWED_CONTENT_TYPES.includes(fileType)) {
      selectContentType.value = fileType;
    } else {
      selectContentType.value = 'application/octet-stream';
    }
    updateTypeWarning();

    // Check for existing session in localStorage
    const savedId = getStoredUploadId(fileFingerprint);
    if (savedId) {
      currentUploadId = savedId;
      resumeBanner.classList.remove('is-hidden');
      btnResume.classList.remove('is-hidden');
      btnStart.classList.add('is-hidden');
      announce('Previous session found for this file. Click Resume to continue.');
    } else {
      currentUploadId = null;
      resumeBanner.classList.add('is-hidden');
      btnResume.classList.add('is-hidden');
      btnStart.classList.remove('is-hidden');
    }

    btnStart.disabled = false;
    btnResume.disabled = false;
    btnFinalize.disabled = true;
    btnInterrupt.disabled = true;

    // Estimate initial chunks
    const cSize = parseInt(selectChunkSize.value, 10) || 1048576;
    totalChunksCount = chunkMath.chunkCount(file.size, cSize);
    stateByIndex = {};
    inFlightCount = 0;
    renderLedger();
  }

  function updateTypeWarning() {
    if (selectContentType.value === 'application/octet-stream') {
      typeWarning.classList.remove('is-hidden');
    } else {
      typeWarning.classList.add('is-hidden');
    }
  }

  selectContentType.addEventListener('change', updateTypeWarning);

  // Drag and Drop Wiring
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('is-dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  btnFreshUpload.addEventListener('click', () => {
    if (fileFingerprint) {
      removeStoredUploadId(fileFingerprint);
    }
    currentUploadId = null;
    resumeBanner.classList.add('is-hidden');
    btnResume.classList.add('is-hidden');
    btnStart.classList.remove('is-hidden');
    stateByIndex = {};
    inFlightCount = 0;
    renderLedger();
  });

  // Server Chunk Recommendation Button
  btnGetRec.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/recommendation/chunk-size');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      recInfo.textContent = `Server advice: ${formatBytes(data.recommendedChunkBytes)} (${data.reason}). Samples: ${data.inputs?.samples ?? 0}. (heuristic, applies to new uploads only)`;
      recInfo.classList.remove('is-hidden');

      // Select recommended chunk size if option exists, or create custom option
      let found = false;
      for (let i = 0; i < selectChunkSize.options.length; i++) {
        if (parseInt(selectChunkSize.options[i].value, 10) === data.recommendedChunkBytes) {
          selectChunkSize.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = data.recommendedChunkBytes;
        opt.textContent = `${formatBytes(data.recommendedChunkBytes)} (recommended)`;
        opt.selected = true;
        selectChunkSize.appendChild(opt);
      }
    } catch (err) {
      showError('REC_FAILED', `Failed to fetch server recommendation: ${err.message}`);
    }
  });

  // Ledger & Grid Rendering
  function renderLedger() {
    while (ledgerGrid.firstChild) {
      ledgerGrid.removeChild(ledgerGrid.firstChild);
    }

    if (totalChunksCount === 0) return;

    const buckets = ledgerView.bucketize(totalChunksCount, stateByIndex, 256);
    const glyphMap = {
      committed: '\u2713',
      inflight: '\u21B5',
      repaired: '\u267B',
      partial: '\u25D0',
      missing: '\u00B7',
      failed: '\u2717'
    };

    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const cell = document.createElement('div');
      cell.className = 'chunk-cell cell-' + b.state;
      cell.textContent = glyphMap[b.state] || '';

      const spanText = b.from === b.to ? `Chunk ${b.from}` : `Chunks ${b.from}-${b.to}`;
      cell.title = `${spanText}: ${b.state}`;
      ledgerGrid.appendChild(cell);
    }

    progressInflight.textContent = `${inFlightCount} in flight`;
  }

  // Update Range Lists
  function updateRangesText(status) {
    const ranges = ledgerView.rangesFromStatus(status);

    while (rangesCommitted.firstChild) rangesCommitted.removeChild(rangesCommitted.firstChild);
    if (ranges.committed.length === 0) {
      const em = document.createElement('em');
      em.textContent = 'None';
      rangesCommitted.appendChild(em);
    } else {
      for (const r of ranges.committed) {
        const div = document.createElement('div');
        div.textContent = r;
        rangesCommitted.appendChild(div);
      }
    }

    while (rangesMissing.firstChild) rangesMissing.removeChild(rangesMissing.firstChild);
    if (ranges.missing.length === 0) {
      const em = document.createElement('em');
      em.textContent = 'None (100% committed)';
      rangesMissing.appendChild(em);
    } else {
      for (const r of ranges.missing) {
        const div = document.createElement('div');
        div.textContent = r;
        rangesMissing.appendChild(div);
      }
    }
  }

  // Update Durable Progress Bar
  function updateProgressBar(committedBytes, expectedBytes) {
    if (!expectedBytes || expectedBytes <= 0) {
      progressPct.textContent = '0%';
      progressBytes.textContent = '0 / 0 bytes';
      progressBarDurable.style.width = '0%';
      return;
    }

    const pct = Math.floor((committedBytes * 10000) / expectedBytes) / 100;
    progressPct.textContent = `${pct.toFixed(1)}%`;
    progressBytes.textContent = `${formatBytes(committedBytes)} / ${formatBytes(expectedBytes)}`;
    progressBarDurable.style.width = `${Math.min(100, pct)}%`;
  }

  // Metrics Polling
  function startMetricsPolling(uploadId) {
    stopMetricsPolling();
    metricsPollTimer = setInterval(() => {
      fetchMetrics(uploadId);
    }, 1000);
    fetchMetrics(uploadId);
  }

  function stopMetricsPolling() {
    if (metricsPollTimer) {
      clearInterval(metricsPollTimer);
      metricsPollTimer = null;
    }
  }

  async function fetchMetrics(uploadId) {
    if (!uploadId) return;
    try {
      const res = await fetch(`/api/metrics/${uploadId}`);
      if (!res.ok) return;
      const data = await res.json();
      updateMetricsUI(data);
    } catch {}
  }

  function updateMetricsUI(data) {
    if (!data) return;

    if (data.throughput?.recentMiBPerSecond !== undefined) {
      metricServerSpeed.textContent = `${data.throughput.recentMiBPerSecond} MiB/s`;
    }

    if (data.timing) {
      metricTimes.textContent = `${data.timing.activeMs}ms / ${data.timing.wallMs}ms`;
    }

    if (data.eta?.available) {
      metricEta.textContent = `${data.eta.seconds}s`;
      const samples = data.eta.basedOn?.samples ?? 0;
      document.getElementById('metric-eta-sub').textContent = `based on ${samples} chunks`;
    } else {
      metricEta.textContent = 'Not enough data yet';
      document.getElementById('metric-eta-sub').textContent = 'needs >= 3 samples';
    }

    if (data.resume?.resendEfficiency !== undefined) {
      metricResendEff.textContent = `${(data.resume.resendEfficiency * 100).toFixed(2)}%`;
    }

    if (data.counters) {
      metricRetries.textContent = `${data.counters.retries} (${data.counters.duplicates} dup, ${data.counters.repaired} rep)`;
      metricIntegrity.textContent = `${data.counters.checksumMismatches} mismatches (${data.integrity?.chunksVerified ?? 0} ok)`;
    }

    if (data.finalize?.assemblyMs !== undefined) {
      metricAssembly.textContent = `${data.finalize.assemblyMs}ms`;
    }

    if (data.state === 'ready' && data.finalize?.sha256) {
      finalShaVal.textContent = data.finalize.sha256;
      finalShaWrap.classList.remove('is-hidden');
    }
  }

  // Load Verified Chunks Table
  async function loadVerifiedChunksTable(uploadId) {
    try {
      const res = await fetch(`/api/uploads/${uploadId}?verify=true`);
      if (!res.ok) return;
      const data = await res.json();

      while (chunksTableBody.firstChild) chunksTableBody.removeChild(chunksTableBody.firstChild);

      if (!data.chunks || data.chunks.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.setAttribute('colspan', '4');
        td.textContent = 'No chunks verified';
        tr.appendChild(td);
        chunksTableBody.appendChild(tr);
        return;
      }

      for (const c of data.chunks) {
        const tr = document.createElement('tr');

        const tdIdx = document.createElement('td');
        tdIdx.textContent = c.index;

        const tdRange = document.createElement('td');
        tdRange.textContent = `${c.start}-${c.end}`;

        const tdSha = document.createElement('td');
        const code = document.createElement('code');
        code.className = 'code-sm';
        code.textContent = (c.checksum || '').slice(0, 16) + '...';
        code.title = c.checksum || '';
        tdSha.appendChild(code);

        const tdAt = document.createElement('td');
        tdAt.textContent = c.committedAt ? new Date(c.committedAt).toLocaleTimeString() : '-';

        tr.appendChild(tdIdx);
        tr.appendChild(tdRange);
        tr.appendChild(tdSha);
        tr.appendChild(tdAt);
        chunksTableBody.appendChild(tr);
      }
    } catch {}
  }

  // Upload Runner
  async function runUpload(isResuming) {
    if (!selectedFile) {
      showError('NO_FILE', 'Please select a file to upload first.');
      return;
    }

    hideError();
    const cSize = parseInt(selectChunkSize.value, 10) || 1048576;
    const conc = parseInt(selectConcurrency.value, 10) || 1;
    const autoFin = checkAutoFinalize.checked;

    let stopAfter = undefined;
    const stopVal = parseInt(inputStopAfter.value, 10);
    if (!isNaN(stopVal) && stopVal > 0) {
      stopAfter = stopVal;
    }

    let corruptIdx = undefined;
    const corruptVal = parseInt(inputCorruptChunk.value, 10);
    if (!isNaN(corruptVal) && corruptVal >= 0) {
      corruptIdx = corruptVal;
    }

    btnStart.disabled = true;
    btnResume.disabled = true;
    btnInterrupt.disabled = false;
    btnFinalize.disabled = true;

    setSessionState('uploading');

    activeUploader = uploaderLib.createUploader({ baseUrl: '' });

    try {
      const summary = await activeUploader.upload(selectedFile, {
        name: selectedFile.name,
        contentType: selectContentType.value,
        chunkSize: cSize,
        concurrency: conc,
        uploadId: isResuming ? currentUploadId : undefined,
        stopAfter,
        corruptIndex: corruptIdx,
        finalize: autoFin,
        onEvent: (evt) => {
          if (evt.type === 'status') {
            currentUploadId = evt.status.uploadId;
            setStoredUploadId(fileFingerprint, currentUploadId);
            totalChunksCount = evt.status.totalChunks;
            updateRangesText(evt.status);
            updateProgressBar(evt.status.committedBytes, evt.status.expectedSize);

            // Populate committed chunks into stateByIndex
            for (const c of evt.status.committedChunks) {
              stateByIndex[c.index] = 'committed';
            }
            renderLedger();
            startMetricsPolling(currentUploadId);
          } else if (evt.type === 'session_gone') {
            removeStoredUploadId(fileFingerprint);
            currentUploadId = null;
            resumeBanner.classList.add('is-hidden');
            btnResume.classList.add('is-hidden');
            btnStart.classList.remove('is-hidden');
            showError('SESSION_GONE', 'The server has no record of this upload session. Please start fresh.');
          } else if (evt.type === 'chunk-start') {
            stateByIndex[evt.index] = 'inflight';
            inFlightCount++;
            renderLedger();
          } else if (evt.type === 'chunk-done') {
            stateByIndex[evt.index] = evt.outcome;
            inFlightCount = Math.max(0, inFlightCount - 1);
            renderLedger();
          } else if (evt.type === 'chunk-failed') {
            stateByIndex[evt.index] = 'failed';
            inFlightCount = Math.max(0, inFlightCount - 1);
            renderLedger();
          } else if (evt.type === 'interrupted') {
            inFlightCount = 0;
            renderLedger();
          } else if (evt.type === 'finalized') {
            setSessionState('ready');
            announce('Upload finalized successfully!');
            refreshMediaLibrary();
          } else if (evt.type === 'finalize-failed') {
            setSessionState('uploading');
            showError('FINALIZE_FAILED', `Finalization failed: ${evt.code}`);
          }
        }
      });

      stopMetricsPolling();
      if (currentUploadId) {
        await fetchMetrics(currentUploadId);
        await loadVerifiedChunksTable(currentUploadId);
      }

      // Display client metrics
      if (summary.clientMetrics) {
        metricClientSpeed.textContent = `${summary.clientMetrics.clientObservedMiBps} MiB/s`;
      }

      if (summary.interrupted) {
        btnInterrupt.disabled = true;
        btnResume.classList.remove('is-hidden');
        btnResume.disabled = false;
        btnStart.classList.add('is-hidden');
        announce('Upload interrupted. Click Resume to continue.');
      } else if (summary.media) {
        setSessionState('ready');
        removeStoredUploadId(fileFingerprint);
        btnInterrupt.disabled = true;
        btnResume.classList.add('is-hidden');
        btnStart.classList.remove('is-hidden');
        btnStart.disabled = false;
        btnFinalize.disabled = true;
      } else {
        // Chunks complete, ready for manual finalize
        btnInterrupt.disabled = true;
        btnFinalize.disabled = false;
        btnResume.disabled = true;
      }
    } catch (err) {
      stopMetricsPolling();
      inFlightCount = 0;
      renderLedger();

      btnInterrupt.disabled = true;
      btnResume.classList.remove('is-hidden');
      btnResume.disabled = false;
      btnStart.classList.add('is-hidden');

      showError(err.code || 'UPLOAD_FAILED', err.message);

      if (currentUploadId) {
        await fetchMetrics(currentUploadId);
      }
    }
  }

  btnStart.addEventListener('click', () => runUpload(false));
  btnResume.addEventListener('click', () => runUpload(true));

  btnInterrupt.addEventListener('click', () => {
    if (activeUploader) {
      activeUploader.interrupt();
      btnInterrupt.disabled = true;
      announce('Interrupting in-flight chunk requests...');
    }
  });

  btnFinalize.addEventListener('click', async () => {
    if (!currentUploadId) return;
    setSessionState('finalizing');
    btnFinalize.disabled = true;

    try {
      const res = await fetch(`/api/uploads/${currentUploadId}/finalize`, { method: 'POST' });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status}: ${errJson?.error?.message || errJson?.error?.code || 'Error'}`);
      }
      const media = await res.json();
      setSessionState('ready');
      announce('Finalize complete!');
      removeStoredUploadId(fileFingerprint);

      await fetchMetrics(currentUploadId);
      await loadVerifiedChunksTable(currentUploadId);
      refreshMediaLibrary();
    } catch (err) {
      setSessionState('uploading');
      btnFinalize.disabled = false;
      showError('FINALIZE_ERROR', err.message);
    }
  });

  // Media Library Refresh & Display
  async function refreshMediaLibrary() {
    try {
      const res = await fetch('/api/media');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      while (mediaList.firstChild) mediaList.removeChild(mediaList.firstChild);

      if (!data.items || data.items.length === 0) {
        const li = document.createElement('li');
        li.className = 'media-empty';
        li.textContent = 'No media published yet. Finalize an upload to publish.';
        mediaList.appendChild(li);
        return;
      }

      for (const item of data.items) {
        const li = document.createElement('li');
        li.className = 'media-item';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.originalName;

        const sizeSpan = document.createElement('span');
        sizeSpan.textContent = formatBytes(item.size);

        li.appendChild(nameSpan);
        li.appendChild(sizeSpan);

        li.addEventListener('click', () => {
          const allItems = mediaList.querySelectorAll('.media-item');
          for (const el of allItems) el.classList.remove('is-selected');
          li.classList.add('is-selected');
          selectMediaItem(item);
        });

        mediaList.appendChild(li);
      }
    } catch (err) {
      showError('MEDIA_LIST_FAILED', `Failed to load media list: ${err.message}`);
    }
  }

  btnRefreshMedia.addEventListener('click', refreshMediaLibrary);

  function selectMediaItem(item) {
    selectedMedia = item;
    btnSendProbe.disabled = false;

    while (playerContainer.firstChild) playerContainer.removeChild(playerContainer.firstChild);

    const mediaUrl = `/api/media/${item.mediaId}`;
    const cType = item.contentType || '';

    if (cType.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.controls = true;
      vid.src = mediaUrl;
      playerContainer.appendChild(vid);
    } else if (cType.startsWith('audio/')) {
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.src = mediaUrl;
      playerContainer.appendChild(aud);
    } else if (cType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = mediaUrl;
      img.alt = item.originalName;
      playerContainer.appendChild(img);
    } else {
      const p = document.createElement('p');
      p.className = 'player-placeholder';
      const a = document.createElement('a');
      a.href = mediaUrl + '?download=1';
      a.className = 'btn btn-primary';
      a.textContent = `Download ${item.originalName} (${formatBytes(item.size)})`;
      p.appendChild(a);
      playerContainer.appendChild(p);
    }

    infoName.textContent = item.originalName;
    infoSize.textContent = `${formatBytes(item.size)} (${item.size} bytes)`;
    infoType.textContent = item.contentType;
    infoSha.textContent = item.sha256;
    infoDownload.href = mediaUrl + '?download=1';
    mediaInfo.classList.remove('is-hidden');
  }

  // HTTP Range Probe
  async function executeRangeProbe(rangeHeader) {
    if (!selectedMedia) {
      showError('NO_MEDIA_SELECTED', 'Please select a media item from the list first.');
      return;
    }

    const url = `/api/media/${selectedMedia.mediaId}`;
    const ctrl = new AbortController();

    try {
      const res = await fetch(url, {
        headers: { Range: rangeHeader },
        signal: ctrl.signal
      });

      // Immediately abort body stream to avoid downloading large media chunks
      ctrl.abort();

      probeStatus.textContent = `${res.status} ${res.statusText}`;
      probeStatus.className = 'status-tag status-' + res.status;

      while (probeHeadersBody.firstChild) probeHeadersBody.removeChild(probeHeadersBody.firstChild);

      const headersToInspect = [
        ['Request Range', rangeHeader],
        ['Content-Range', res.headers.get('content-range') || '(none)'],
        ['Content-Length', res.headers.get('content-length') || '(none)'],
        ['Accept-Ranges', res.headers.get('accept-ranges') || '(none)'],
        ['Content-Type', res.headers.get('content-type') || '(none)'],
        ['ETag', res.headers.get('etag') || '(none)'],
        ['Last-Modified', res.headers.get('last-modified') || '(none)']
      ];

      for (const [k, v] of headersToInspect) {
        const tr = document.createElement('tr');
        const tdK = document.createElement('td');
        tdK.textContent = k;
        const tdV = document.createElement('td');
        tdV.textContent = v;
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        probeHeadersBody.appendChild(tr);
      }

      probeResultBox.classList.remove('is-hidden');
    } catch (err) {
      if (err.name === 'AbortError') {
        // Abort of response body is expected
        return;
      }
      showError('PROBE_FAILED', `Range probe failed: ${err.message}`);
    }
  }

  probeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = inputCustomRange.value.trim();
    if (val) executeRangeProbe(val);
  });

  const presetBtns = document.querySelectorAll('.btn-preset');
  for (const btn of presetBtns) {
    btn.addEventListener('click', () => {
      const r = btn.getAttribute('data-range');
      inputCustomRange.value = r;
      executeRangeProbe(r);
    });
  }

  // Initial setup
  setSessionState('created');
  refreshMediaLibrary();
})();
