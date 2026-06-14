import { useCallback, useEffect, useRef, useState } from "react";
import { createWorker, type Worker } from "tesseract.js";
import {
  deleteScan,
  ensureTacRecorded,
  extractImeisFromText,
  fetchCloudHistory,
  isValidImei,
  loadTacDb,
  lookupDevice,
  saveDeviceOverride,
  saveScanToCloud,
  toCsv,
  updateScanDevice,
  type DetectedImei,
  type ScannedPair,
} from "@/lib/imei-utils";

type Mode = "ocr" | "barcode";
type Tab = "scanner" | "history" | "cloud";

interface PendingCounts {
  [imei: string]: { count: number; slotHint?: 1 | 2 };
}

const STABILITY_THRESHOLD = 2;
const HISTORY_KEY = "imei_scan_history_v1";
const CLOUD_PASSWORD = "157269";
const CLOUD_UNLOCK_KEY = "imei_cloud_unlocked_v1";

export function ImeiScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const loopRef = useRef<number | null>(null);
  const barcodeDetectorRef = useRef<any>(null);
  const pendingRef = useRef<PendingCounts>({});
  const confirmedRef = useRef<DetectedImei[]>([]);
  const runningRef = useRef(false);

  const [tab, setTab] = useState<Tab>("scanner");
  const [mode, setMode] = useState<Mode>("ocr");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("Idle");
  const [current, setCurrent] = useState<{ imei1?: string; imei2?: string; device?: string }>({});
  const [history, setHistory] = useState<ScannedPair[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [barcodeSupported, setBarcodeSupported] = useState(true);
  const [cloudUnlocked, setCloudUnlocked] = useState(false);
  const [cloudHistory, setCloudHistory] = useState<ScannedPair[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [pwPromptOpen, setPwPromptOpen] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");

  useEffect(() => {
    loadTacDb();
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
    try {
      if (localStorage.getItem(CLOUD_UNLOCK_KEY) === "1") setCloudUnlocked(true);
    } catch {}
    if (typeof window !== "undefined" && !("BarcodeDetector" in window)) {
      setBarcodeSupported(false);
    }
    return () => {
      stopScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {}
  }, [history]);

  const finalizePair = useCallback((imeis: DetectedImei[]) => {
    let imei1: string | undefined;
    let imei2: string | undefined;
    const withHint1 = imeis.find((x) => x.slotHint === 1);
    const withHint2 = imeis.find((x) => x.slotHint === 2);
    if (withHint1) imei1 = withHint1.value;
    if (withHint2) imei2 = withHint2.value;
    const remaining = imeis.filter((x) => x.value !== imei1 && x.value !== imei2);
    if (!imei1 && remaining.length) imei1 = remaining.shift()!.value;
    if (!imei2 && remaining.length) imei2 = remaining.shift()!.value;
    const device = imei1 ? lookupDevice(imei1) : undefined;
    setCurrent({ imei1, imei2, device });
    if (imei1) {
      const entry: ScannedPair = {
        id: crypto.randomUUID(),
        imei1,
        imei2,
        device,
        date: new Date().toISOString(),
      };
      setHistory((h) => [entry, ...h]);
      // Save to shared cloud database (no auth required)
      saveScanToCloud(entry);
      // Record unknown TACs so they can be renamed permanently later
      ensureTacRecorded(imei1);
      if (imei2) ensureTacRecorded(imei2);
    }
  }, []);

  const handleDetected = useCallback(
    (det: DetectedImei[]) => {
      const pending = pendingRef.current;
      const confirmed = confirmedRef.current;
      for (const d of det) {
        if (!isValidImei(d.value)) continue;
        if (confirmed.find((c) => c.value === d.value)) continue;
        const entry = pending[d.value] ?? { count: 0 };
        entry.count += 1;
        if (d.slotHint) entry.slotHint = d.slotHint;
        pending[d.value] = entry;
        if (entry.count >= STABILITY_THRESHOLD) {
          confirmed.push({ value: d.value, slotHint: entry.slotHint });
          delete pending[d.value];
          setStatus(`Confirmed ${confirmed.length} IMEI(s)`);
        }
      }
      if (confirmed.length >= 2) {
        const final = [...confirmed];
        confirmedRef.current = [];
        pendingRef.current = {};
        stopScan();
        finalizePair(final);
        setStatus("Both IMEIs captured");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finalizePair],
  );

  const grabFrame = useCallback((): HTMLCanvasElement | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }, []);

  const ocrLoop = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      const canvas = grabFrame();
      const worker = workerRef.current;
      if (canvas && worker) {
        const { data } = await worker.recognize(canvas);
        const det = extractImeisFromText(data.text || "");
        if (det.length) handleDetected(det);
      }
    } catch (e) {
      console.error("OCR error", e);
    }
    if (runningRef.current) {
      loopRef.current = window.setTimeout(ocrLoop, 600) as unknown as number;
    }
  }, [grabFrame, handleDetected]);

  const barcodeLoop = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      const video = videoRef.current;
      const detector = barcodeDetectorRef.current;
      if (video && detector) {
        const codes = await detector.detect(video);
        const det: DetectedImei[] = [];
        for (const c of codes) {
          const raw = String(c.rawValue || "").replace(/\D/g, "");
          if (raw.length >= 15) {
            const m = raw.match(/\d{15}/g);
            if (m) m.forEach((v) => det.push({ value: v }));
          }
        }
        if (det.length) handleDetected(det);
      }
    } catch (e) {
      console.error("Barcode error", e);
    }
    if (runningRef.current) {
      loopRef.current = window.setTimeout(barcodeLoop, 250) as unknown as number;
    }
  }, [handleDetected]);

  const startScan = useCallback(async () => {
    setError("");
    setCurrent({});
    pendingRef.current = {};
    confirmedRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      runningRef.current = true;
      setScanning(true);

      if (mode === "ocr") {
        setStatus("Loading OCR...");
        if (!workerRef.current) {
          workerRef.current = await createWorker("eng");
          await workerRef.current.setParameters({
            tessedit_char_whitelist: "IMEIimei0123456789:- ",
            // @ts-expect-error psm enum
            tessedit_pageseg_mode: "6",
          });
        }
        setStatus("Scanning (OCR)...");
        ocrLoop();
      } else {
        if (!("BarcodeDetector" in window)) {
          throw new Error("BarcodeDetector not supported. Use OCR mode.");
        }
        // @ts-expect-error experimental
        barcodeDetectorRef.current = new window.BarcodeDetector({
          formats: ["code_128", "code_39", "ean_13", "qr_code", "data_matrix", "itf", "codabar", "pdf417"],
        });
        setStatus("Scanning (Barcode)...");
        barcodeLoop();
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setScanning(false);
      runningRef.current = false;
      stopScan();
    }
  }, [mode, ocrLoop, barcodeLoop]);

  function stopScan() {
    runningRef.current = false;
    if (loopRef.current) {
      clearTimeout(loopRef.current);
      loopRef.current = null;
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
    setStatus("Stopped");
  }

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (scanning) stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (tab !== "scanner" && scanning) stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const copy = async (text: string) => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch (e) {
      console.error("Copy failed", e);
    }
    setStatus(ok ? "Copied ✓" : "Copy failed");
  };

  const copyAll = () => {
    const lines: string[] = [];
    if (current.imei1) lines.push(current.imei1);
    if (current.imei2) lines.push(current.imei2);
    if (lines.length) copy(lines.join("\n"));
    else setStatus("Nothing to copy");
  };

  const exportCsv = () => {
    if (!history.length) {
      setStatus("No history to export");
      return;
    }
    const csv = toCsv(history);
    const filename = `imei-history-${new Date().toISOString().slice(0, 10)}.csv`;
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });

    // Try native download first
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      setStatus("CSV exported ✓ (check downloads)");
      return;
    } catch (e) {
      console.error("Blob download failed", e);
    }

    // Fallback: open CSV in a new window so the user can save it manually.
    // This works inside sandboxed preview iframes that block direct downloads.
    try {
      const w = window.open("", "_blank");
      if (w) {
        w.document.open();
        w.document.write(
          `<!doctype html><meta charset="utf-8"><title>${filename}</title>` +
            `<pre style="font-family:ui-monospace,monospace;white-space:pre;padding:16px">` +
            csv.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)) +
            `</pre>`,
        );
        w.document.close();
        setStatus("CSV opened in new tab — Save As .csv");
      } else {
        setStatus("Popup blocked — allow popups");
      }
    } catch (e) {
      console.error("CSV fallback failed", e);
      setStatus("CSV export failed");
    }
  };

  const clearHistory = () => {
    setHistory([]);
    setExpanded(null);
  };

  const addDeviceName = async (imei: string) => {
    const name = window.prompt("Enter device name (e.g. XIAOMI Redmi 13)")?.trim();
    if (!name) return;
    setStatus("Saving device name...");
    const ok = await saveDeviceOverride(imei, name);
    if (!ok) {
      setStatus("Save failed");
      return;
    }
    // Re-lookup all entries that share the same TAC
    const tac = imei.slice(0, 8);
    setHistory((h) =>
      h.map((e) =>
        e.imei1.slice(0, 8) === tac || (e.imei2 && e.imei2.slice(0, 8) === tac)
          ? { ...e, device: lookupDevice(e.imei1) ?? e.device }
          : e,
      ),
    );
    setCurrent((c) => (c.imei1 && c.imei1.slice(0, 8) === tac ? { ...c, device: name } : c));
    setStatus("Device name saved ✓");
  };

  const loadCloud = useCallback(async () => {
    setCloudLoading(true);
    const rows = await fetchCloudHistory();
    setCloudHistory(rows);
    setCloudLoading(false);
  }, []);

  const unlockCloud = useCallback(async () => {
    if (cloudUnlocked) {
      setTab("cloud");
      loadCloud();
      return;
    }
    setPwInput("");
    setPwError("");
    setPwPromptOpen(true);
  }, [cloudUnlocked, loadCloud]);

  const submitPassword = useCallback(() => {
    if (pwInput !== CLOUD_PASSWORD) {
      setPwError("Wrong password");
      return;
    }
    try { localStorage.setItem(CLOUD_UNLOCK_KEY, "1"); } catch {}
    setCloudUnlocked(true);
    setPwPromptOpen(false);
    setPwInput("");
    setPwError("");
    setTab("cloud");
    loadCloud();
  }, [pwInput, loadCloud]);

  const lockCloud = () => {
    try { localStorage.removeItem(CLOUD_UNLOCK_KEY); } catch {}
    setCloudUnlocked(false);
    setCloudHistory([]);
    setTab("scanner");
  };

  const renameCloudEntry = async (entry: ScannedPair) => {
    const name = window.prompt("Rename device", entry.device || "")?.trim();
    if (!name) return;
    setStatus("Renaming...");
    // Persist permanently against the TAC (so future scans inherit the name)
    const tac = entry.imei1.slice(0, 8);
    const okTac = await saveDeviceOverride(tac, name);
    // Update this scan row's device name directly
    const okRow = await updateScanDevice(entry.id, name);
    if (!okTac && !okRow) { setStatus("Rename failed"); return; }
    setCloudHistory((rows) => rows.map((r) => (r.id === entry.id ? { ...r, device: name } : r)));
    // Also reflect in local history when TAC matches
    setHistory((h) =>
      h.map((e) =>
        e.imei1.slice(0, 8) === tac || (e.imei2 && e.imei2.slice(0, 8) === tac)
          ? { ...e, device: name }
          : e,
      ),
    );
    setStatus("Renamed ✓");
  };

  const deleteCloudEntry = async (entry: ScannedPair) => {
    if (!window.confirm("Delete this scan from the shared database?")) return;
    setStatus("Deleting...");
    const ok = await deleteScan(entry.id);
    if (!ok) { setStatus("Delete failed"); return; }
    setCloudHistory((rows) => rows.filter((r) => r.id !== entry.id));
    setStatus("Deleted ✓");
  };



  return (
    <div className="fixed inset-0 flex flex-col bg-background" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
      {/* Header */}
      <header className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
        <div className="w-8" />
        <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
          IMEI Scanner
        </h1>
        <button
          onClick={unlockCloud}
          title={cloudUnlocked ? "View shared database" : "Unlock shared database"}
          className={`w-8 h-8 rounded-md flex items-center justify-center text-base font-bold border transition ${
            cloudUnlocked
              ? "bg-primary/20 text-primary border-primary/40"
              : "bg-secondary text-muted-foreground border-border"
          }`}
        >
          🔑
        </button>
      </header>

      {/* Main content area */}
      <main className="flex-1 overflow-y-auto px-3 pb-3">
        {tab === "scanner" && (
          <ScannerView
            mode={mode}
            setMode={setMode}
            barcodeSupported={barcodeSupported}
            scanning={scanning}
            videoRef={videoRef}
            canvasRef={canvasRef}
            startScan={startScan}
            stopScan={stopScan}
            status={status}
            error={error}
            current={current}
            copy={copy}
            copyAll={copyAll}
          />
        )}
        {tab === "history" && (
          <HistoryView
            history={history}
            expanded={expanded}
            setExpanded={setExpanded}
            exportCsv={exportCsv}
            clearHistory={clearHistory}
            copy={copy}
            addDeviceName={addDeviceName}
          />
        )}
        {tab === "cloud" && (
          <CloudView
            history={cloudHistory}
            loading={cloudLoading}
            refresh={loadCloud}
            lock={lockCloud}
            copy={copy}
            onRename={renameCloudEntry}
            onDelete={deleteCloudEntry}
          />
        )}
      </main>

      {/* Bottom tab bar */}
      <nav className="shrink-0 grid grid-cols-2 border-t border-border bg-background/80 backdrop-blur-lg">
        <TabButton active={tab === "scanner"} onClick={() => setTab("scanner")} label="SCANNER" icon="scan" />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          label="HISTORY"
          icon="history"
          badge={history.length || undefined}
        />
      </nav>
    </div>
  );
}

function ScannerView(props: {
  mode: Mode;
  setMode: (m: Mode) => void;
  barcodeSupported: boolean;
  scanning: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  startScan: () => void;
  stopScan: () => void;
  status: string;
  error: string;
  current: { imei1?: string; imei2?: string; device?: string };
  copy: (t: string) => void;
  copyAll: () => void;
}) {
  const { mode, setMode, barcodeSupported, scanning, videoRef, canvasRef, startScan, stopScan, status, error, current, copy, copyAll } = props;
  return (
    <div className="space-y-3">
      <div className="glass p-1 flex items-center gap-1">
        <button
          onClick={() => setMode("ocr")}
          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
            mode === "ocr" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
          }`}
        >
          OCR
        </button>
        <button
          onClick={() => setMode("barcode")}
          disabled={!barcodeSupported}
          className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
            mode === "barcode" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
          } disabled:opacity-40`}
        >
          BARCODE{!barcodeSupported && " (n/a)"}
        </button>
      </div>

      <div className="glass relative overflow-hidden aspect-[4/3]">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
        {!scanning && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
            Camera preview
          </div>
        )}
        {scanning && (
          <>
            <div className="absolute top-2 left-2 flex items-center gap-1.5 glass px-2 py-1">
              <span className="size-2 rounded-full bg-[oklch(0.75_0.2_145)] glow-pulse" />
              <span className="text-[10px] font-semibold">LIVE</span>
            </div>
            <div className="absolute inset-x-6 top-1/4 bottom-1/4 border-2 border-primary/60 rounded-lg pointer-events-none" />
          </>
        )}
      </div>

      {!scanning ? (
        <button
          onClick={startScan}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition"
        >
          Start Scanning
        </button>
      ) : (
        <button
          onClick={stopScan}
          className="w-full py-2.5 rounded-lg bg-destructive text-white font-semibold text-sm hover:opacity-90 transition"
        >
          Stop
        </button>
      )}

      <p className="text-[11px] text-center text-muted-foreground">{status}</p>
      {error && <p className="text-xs text-center text-destructive">{error}</p>}

      {(current.imei1 || current.imei2) && (
        <div className="glass p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Scan</h2>
            <button onClick={copyAll} className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-semibold">
              Copy All
            </button>
          </div>
          {current.imei1 && <ImeiRow label="IMEI 1" value={current.imei1} onCopy={() => copy(current.imei1!)} />}
          {current.imei2 && <ImeiRow label="IMEI 2" value={current.imei2} onCopy={() => copy(current.imei2!)} />}
          {current.device && (
            <div className="text-[11px] text-muted-foreground">
              Device: <span className="text-foreground font-medium">{current.device}</span>
            </div>
          )}
        </div>
      )}

      <a
        href="https://ceir.gov.mm/check-status"
        target="_blank"
        rel="noreferrer"
        className="block text-center py-2.5 rounded-lg bg-gradient-to-r from-primary to-accent text-primary-foreground font-bold text-sm hover:opacity-90 transition"
      >
        Check CEIR Status →
      </a>
    </div>
  );
}

function HistoryView(props: {
  history: ScannedPair[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  exportCsv: () => void;
  clearHistory: () => void;
  copy: (t: string) => void;
  addDeviceName: (imei: string) => void | Promise<void>;
}) {
  const { history, expanded, setExpanded, exportCsv, clearHistory, copy, addDeviceName } = props;
  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">History ({history.length})</h2>
        <div className="flex gap-2">
          <button
            onClick={exportCsv}
            disabled={!history.length}
            className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-semibold disabled:opacity-40"
          >
            CSV
          </button>
          <button
            onClick={clearHistory}
            disabled={!history.length}
            className="text-[11px] px-2.5 py-1 rounded-md bg-secondary disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>
      {!history.length && <p className="text-xs text-muted-foreground text-center py-8">No scans yet.</p>}
      <div className="space-y-2">
        {history.map((h) => {
          const isOpen = expanded === h.id;
          const count = (h.imei1 ? 1 : 0) + (h.imei2 ? 1 : 0);
          const d = new Date(h.date);
          const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
          const date = `${d.toLocaleString([], { month: "short", day: "2-digit" })}, ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
          return (
            <div key={h.id} className="glass overflow-hidden">
              <div className="w-full flex items-center justify-between gap-2 px-3 py-2.5">
                <button
                  onClick={() => setExpanded(isOpen ? null : h.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="text-sm font-semibold truncate flex items-center gap-1">
                    {h.device || `Scan ${time}`}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">{h.device ? `${time} · ${date}` : date}</div>
                </button>
                {!h.device && (
                  <button
                    onClick={(e) => { e.stopPropagation(); addDeviceName(h.imei1); }}
                    title="Add device name"
                    className="text-[11px] w-6 h-6 rounded-md bg-primary/20 text-primary font-bold border border-primary/40 hover:bg-primary/30 shrink-0"
                  >
                    +
                  </button>
                )}
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-primary/15 text-primary font-semibold border border-primary/30 shrink-0">
                  {count} IMEIs
                </span>
                <button
                  onClick={() => setExpanded(isOpen ? null : h.id)}
                  className={`text-muted-foreground transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
                >
                  ⌄
                </button>
              </div>
              {isOpen && (
                <div className="px-3 pb-3 space-y-2 border-t border-border/50 pt-2">
                  {h.imei1 && <SlotRow slot={1} imei={h.imei1} device={h.device} onCopy={() => copy(h.imei1)} />}
                  {h.imei2 && <SlotRow slot={2} imei={h.imei2} device={h.device} onCopy={() => copy(h.imei2!)} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function SlotRow({ slot, imei, device, onCopy }: { slot: 1 | 2; imei: string; device?: string; onCopy: () => void }) {
  return (
    <button onClick={onCopy} className="w-full flex items-center justify-between gap-2 rounded-md bg-background/60 px-3 py-2 text-left hover:bg-background/80 transition">
      <div className="min-w-0">
        <div className="font-mono text-sm">{imei}</div>
        {device && <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{device}</div>}
      </div>
      <span className="text-[10px] px-2 py-0.5 rounded-md border border-primary/40 text-primary font-semibold">SLOT {slot}</span>
    </button>
  );
}

function TabButton({ active, onClick, label, icon, badge }: { active: boolean; onClick: () => void; label: string; icon: "scan" | "history"; badge?: number }) {
  return (
    <button onClick={onClick} className={`relative py-2.5 flex flex-col items-center gap-0.5 transition ${active ? "text-primary" : "text-muted-foreground"}`}>
      <span className="text-base leading-none">{icon === "scan" ? "▣" : "≡"}</span>
      <span className="text-[10px] font-bold tracking-wider">{label}</span>
      {badge !== undefined && (
        <span className="absolute top-1 right-1/4 text-[9px] bg-primary text-primary-foreground rounded-full min-w-4 h-4 px-1 flex items-center justify-center font-bold">
          {badge}
        </span>
      )}
    </button>
  );
}

function ImeiRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-background/40 px-2.5 py-1.5">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="font-mono text-sm truncate">{value}</div>
      </div>
      <button onClick={onCopy} className="text-[11px] px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 font-semibold shrink-0">
        Copy
      </button>
    </div>
  );
}

function CloudView(props: {
  history: ScannedPair[];
  loading: boolean;
  refresh: () => void;
  lock: () => void;
  copy: (t: string) => void;
  onRename: (entry: ScannedPair) => void | Promise<void>;
  onDelete: (entry: ScannedPair) => void | Promise<void>;
}) {
  const { history, loading, refresh, lock, copy, onRename, onDelete } = props;
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">🔐 Shared Database ({history.length})</h2>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-semibold disabled:opacity-40"
          >
            {loading ? "..." : "Refresh"}
          </button>
          <button
            onClick={lock}
            className="text-[11px] px-2.5 py-1 rounded-md bg-secondary"
          >
            Lock
          </button>
        </div>
      </div>
      {loading && <p className="text-xs text-muted-foreground text-center py-8">Loading...</p>}
      {!loading && !history.length && (
        <p className="text-xs text-muted-foreground text-center py-8">No cloud scans yet.</p>
      )}
      <div className="space-y-2">
        {history.map((h) => {
          const isOpen = expanded === h.id;
          const count = (h.imei1 ? 1 : 0) + (h.imei2 ? 1 : 0);
          const d = new Date(h.date);
          const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          const date = d.toLocaleString([], { month: "short", day: "2-digit" });
          return (
            <div key={h.id} className="glass overflow-hidden">
              <div className="w-full flex items-center justify-between gap-2 px-3 py-2.5">
                <button
                  onClick={() => setExpanded(isOpen ? null : h.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="text-sm font-semibold truncate">{h.device || `Scan ${time}`}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">{date} · {time}</div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRename(h); }}
                  title="Rename device"
                  className="text-[11px] w-7 h-7 rounded-md bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 shrink-0"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(h); }}
                  title="Delete scan"
                  className="text-[11px] w-7 h-7 rounded-md bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25 shrink-0"
                >
                  🗑
                </button>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-primary/15 text-primary font-semibold border border-primary/30 shrink-0">
                  {count}
                </span>
              </div>
              {isOpen && (
                <div className="px-3 pb-3 space-y-2 border-t border-border/50 pt-2">
                  {h.imei1 && <SlotRow slot={1} imei={h.imei1} device={h.device} onCopy={() => copy(h.imei1)} />}
                  {h.imei2 && <SlotRow slot={2} imei={h.imei2} device={h.device} onCopy={() => copy(h.imei2!)} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
