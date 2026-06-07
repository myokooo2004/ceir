import { useCallback, useEffect, useRef, useState } from "react";
import { createWorker, type Worker } from "tesseract.js";
import {
  extractImeisFromText,
  isValidImei,
  loadTacDb,
  lookupDevice,
  toCsv,
  type DetectedImei,
  type ScannedPair,
} from "@/lib/imei-utils";

type Mode = "ocr" | "barcode";

interface PendingCounts {
  [imei: string]: { count: number; slotHint?: 1 | 2 };
}

const STABILITY_THRESHOLD = 2;
const HISTORY_KEY = "imei_scan_history_v1";

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

  const [mode, setMode] = useState<Mode>("ocr");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("Idle");
  const [current, setCurrent] = useState<{ imei1?: string; imei2?: string; device?: string }>({});
  const [history, setHistory] = useState<ScannedPair[]>([]);
  const [barcodeSupported, setBarcodeSupported] = useState(true);

  useEffect(() => {
    loadTacDb();
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
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
    // Assign slots
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
            // Some IMEI barcodes also include 16-17 digits (with check). Take 15-digit windows.
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
        setStatus("Loading OCR engine...");
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
          throw new Error("BarcodeDetector API not supported in this browser. Use OCR mode.");
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

  // When switching modes, stop active scan
  useEffect(() => {
    if (scanning) stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
    setStatus(ok ? "Copied to clipboard ✓" : "Copy failed");
  };

  const copyAll = () => {
    const lines: string[] = [];
    if (current.imei1) lines.push(`IMEI 1: ${current.imei1}`);
    if (current.imei2) lines.push(`IMEI 2: ${current.imei2}`);
    if (current.device) lines.push(`Device: ${current.device}`);
    if (lines.length) copy(lines.join("\n"));
    else setStatus("Nothing to copy");
  };

  const exportCsv = () => {
    const csv = toCsv(history);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `imei-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearHistory = () => setHistory([]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
      <header className="text-center space-y-2">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
          IMEI Scanner
        </h1>
        <p className="text-sm text-muted-foreground">OCR & Barcode dual-engine scanner</p>
      </header>

      {/* Mode toggle */}
      <div className="glass p-2 flex items-center gap-1">
        <button
          onClick={() => setMode("ocr")}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${
            mode === "ocr" ? "bg-primary text-primary-foreground shadow-lg" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          OCR Mode
        </button>
        <button
          onClick={() => setMode("barcode")}
          disabled={!barcodeSupported}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${
            mode === "barcode" ? "bg-primary text-primary-foreground shadow-lg" : "text-muted-foreground hover:text-foreground"
          } disabled:opacity-40`}
        >
          Barcode Mode {!barcodeSupported && "(unsupported)"}
        </button>
      </div>

      {/* Camera preview */}
      <div className="glass relative overflow-hidden aspect-video">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
        {!scanning && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Camera preview
          </div>
        )}
        {scanning && (
          <>
            <div className="absolute top-3 left-3 flex items-center gap-2 glass px-3 py-1.5">
              <span className="size-2.5 rounded-full bg-[oklch(0.75_0.2_145)] glow-pulse" />
              <span className="text-xs font-medium">LIVE</span>
            </div>
            <div className="absolute inset-x-8 top-1/3 bottom-1/3 border-2 border-primary/60 rounded-lg pointer-events-none" />
          </>
        )}
      </div>

      <div className="flex gap-2">
        {!scanning ? (
          <button
            onClick={startScan}
            className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:opacity-90 transition"
          >
            Start Scanning
          </button>
        ) : (
          <button
            onClick={stopScan}
            className="flex-1 py-3 rounded-lg bg-destructive text-white font-semibold hover:opacity-90 transition"
          >
            Stop
          </button>
        )}
      </div>

      <p className="text-xs text-center text-muted-foreground">{status}</p>
      {error && <p className="text-sm text-center text-destructive">{error}</p>}

      {/* Current result */}
      {(current.imei1 || current.imei2) && (
        <div className="glass p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Latest Scan</h2>
            <button onClick={copyAll} className="text-xs px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/80">
              Copy All
            </button>
          </div>
          {current.imei1 && <ImeiRow label="IMEI 1" value={current.imei1} onCopy={() => copy(current.imei1!)} />}
          {current.imei2 && <ImeiRow label="IMEI 2" value={current.imei2} onCopy={() => copy(current.imei2!)} />}
          {current.device && (
            <div className="text-sm text-muted-foreground">
              Device: <span className="text-foreground font-medium">{current.device}</span>
            </div>
          )}
        </div>
      )}

      {/* History */}
      <div className="glass p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">History ({history.length})</h2>
          <div className="flex gap-2">
            <button
              onClick={exportCsv}
              disabled={!history.length}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40"
            >
              Export CSV
            </button>
            <button
              onClick={clearHistory}
              disabled={!history.length}
              className="text-xs px-3 py-1.5 rounded-md bg-secondary disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>
        {!history.length && <p className="text-sm text-muted-foreground">No scans yet.</p>}
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {history.map((h) => (
            <div key={h.id} className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="font-mono">IMEI 1: {h.imei1}</div>
              {h.imei2 && <div className="font-mono">IMEI 2: {h.imei2}</div>}
              {h.device && <div className="text-muted-foreground">{h.device}</div>}
              <div className="text-xs text-muted-foreground">{new Date(h.date).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>

      <a
        href="https://ceir.gov.mm/check-status"
        target="_blank"
        rel="noreferrer"
        className="block text-center py-4 rounded-lg bg-gradient-to-r from-primary to-accent text-primary-foreground font-bold tracking-wide hover:opacity-90 transition shadow-lg"
      >
        Check CEIR Status →
      </a>
    </div>
  );
}

function ImeiRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-background/40 px-3 py-2">
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-mono text-sm">{value}</div>
      </div>
      <button onClick={onCopy} className="text-xs px-3 py-1.5 rounded-md bg-secondary hover:bg-secondary/80">
        Copy
      </button>
    </div>
  );
}
