import { supabase } from "@/integrations/supabase/client";

export interface ScannedPair {
  id: string;
  imei1: string;
  imei2?: string;
  device?: string;
  date: string;
}

export interface DetectedImei {
  value: string;
  slotHint?: 1 | 2;
}

const TAC_URL = "https://raw.githubusercontent.com/myokooo2004/tac-db/main/tac.json";
let tacCache: Record<string, { brand?: string; model?: string; name?: string }> | null = null;
const overrideCache: Record<string, string> = {};

export async function loadTacDb() {
  if (!tacCache) {
    try {
      const res = await fetch(TAC_URL);
      const json = await res.json();
      if (Array.isArray(json)) {
        const map: Record<string, any> = {};
        for (const row of json) {
          const tac = String(row.tac ?? row.TAC ?? row.Tac ?? "").slice(0, 8);
          if (tac) map[tac] = row;
        }
        tacCache = map;
      } else {
        tacCache = json as any;
      }
    } catch {
      tacCache = {};
    }
  }
  // Load user-submitted overrides from Lovable Cloud
  try {
    const { data } = await (supabase as any).from("device_overrides").select("tac,name");
    if (data) for (const row of data) overrideCache[row.tac] = row.name;
  } catch {}
  return tacCache!;
}

export async function saveDeviceOverride(tac: string, name: string): Promise<boolean> {
  const cleanTac = tac.slice(0, 8);
  const cleanName = name.trim().slice(0, 100);
  if (!/^\d{8}$/.test(cleanTac) || !cleanName) return false;
  const { error } = await (supabase as any)
    .from("device_overrides")
    .upsert({ tac: cleanTac, name: cleanName }, { onConflict: "tac" });
  if (error) {
    console.error("saveDeviceOverride failed", error);
    return false;
  }
  overrideCache[cleanTac] = cleanName;
  return true;
}

// Record an unknown TAC into the cloud (placeholder name) so it can be renamed later.
export async function ensureTacRecorded(imei: string): Promise<void> {
  const tac = imei.slice(0, 8);
  if (!/^\d{8}$/.test(tac)) return;
  if (overrideCache[tac]) return;
  if (tacCache && tacCache[tac]) return;
  try {
    const { error } = await (supabase as any)
      .from("device_overrides")
      .upsert({ tac, name: "Unknown device" }, { onConflict: "tac", ignoreDuplicates: true });
    if (!error) overrideCache[tac] = overrideCache[tac] ?? "Unknown device";
  } catch (e) {
    console.error("ensureTacRecorded failed", e);
  }
}

export async function updateScanDevice(id: string, device: string): Promise<boolean> {
  const { error } = await (supabase as any)
    .from("scan_history")
    .update({ device })
    .eq("id", id);
  if (error) {
    console.error("updateScanDevice failed", error);
    return false;
  }
  return true;
}

export async function deleteScan(id: string): Promise<boolean> {
  const { error } = await (supabase as any)
    .from("scan_history")
    .delete()
    .eq("id", id);
  if (error) {
    console.error("deleteScan failed", error);
    return false;
  }
  return true;
}

export async function saveScanToCloud(pair: ScannedPair): Promise<void> {
  try {
    await (supabase as any).from("scan_history").insert({
      imei1: pair.imei1,
      imei2: pair.imei2 ?? null,
      device: pair.device ?? null,
      created_at: pair.date,
    });
  } catch (e) {
    console.error("saveScanToCloud failed", e);
  }
}

export async function fetchCloudHistory(): Promise<ScannedPair[]> {
  const { data, error } = await (supabase as any)
    .from("scan_history")
    .select("id,imei1,imei2,device,created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    console.error("fetchCloudHistory failed", error);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    imei1: r.imei1,
    imei2: r.imei2 ?? undefined,
    device: r.device ?? undefined,
    date: r.created_at,
  }));
}

export function lookupDevice(imei: string): string | undefined {
  const tac = imei.slice(0, 8);
  if (overrideCache[tac]) return overrideCache[tac];
  if (!tacCache) return undefined;
  const row = tacCache[tac] as any;
  if (!row) return undefined;
  const brand = String(row.brand ?? row.Brand ?? row.manufacturer ?? "").trim();
  const model = String(row.model ?? row.Model ?? row.name ?? row.Name ?? "").trim();
  const combined = [brand, model].filter(Boolean).join(" ").trim();
  if (!combined) return undefined;
  const words = combined.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (!out.length || out[out.length - 1].toLowerCase() !== w.toLowerCase()) out.push(w);
  }
  return out.join(" ");
}

// Luhn check optional — keep permissive but verify length
export function isValidImei(s: string): boolean {
  return /^\d{15}$/.test(s);
}

const IMEI_REGEX = /IMEI\s*([12])?\s*[:\-]?\s*(\d{15})/gi;

export function extractImeisFromText(text: string): DetectedImei[] {
  // Strip out any lines that look like ICCID / MEID / PSN / SN — we don't want to capture SIM serials, CDMA MEIDs, or product serial numbers.
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !/ICCID|MEID|PSN|\bS\/?N\b/i.test(line))
    .join("\n");

  const out: DetectedImei[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMEI_REGEX.lastIndex = 0;
  while ((m = IMEI_REGEX.exec(cleaned)) !== null) {
    const v = m[2];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, slotHint: m[1] ? (Number(m[1]) as 1 | 2) : undefined });
  }
  // fallback: any standalone 15-digit run (word boundary excludes 19–20 digit ICCIDs)
  if (out.length === 0) {
    const re = /\b(\d{15})\b/g;
    let mm;
    while ((mm = re.exec(cleaned)) !== null) {
      if (!seen.has(mm[1])) {
        seen.add(mm[1]);
        out.push({ value: mm[1] });
      }
    }
  }
  return out;
}

export function toCsv(rows: ScannedPair[]): string {
  const header = ["IMEI 1", "IMEI 2", "Device", "Date"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    lines.push([esc(r.imei1), esc(r.imei2 ?? ""), esc(r.device ?? ""), esc(r.date)].join(","));
  }
  return lines.join("\n");
}
