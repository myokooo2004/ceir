// One-off TAC bulk import. Fetches a CSV and bulk-inserts into tac_database.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const { url } = await req.json();
  if (!url) return new Response("missing url", { status: 400, headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const res = await fetch(url);
  if (!res.ok) return new Response(`fetch failed ${res.status}`, { status: 500, headers: cors });
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  lines.shift(); // header

  const rows: { tac: string; brand: string; model: string }[] = [];
  const parseCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === ",") { out.push(cur); cur = ""; }
        else if (c === '"') inQ = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  for (const line of lines) {
    if (!line) continue;
    const [tac, brand, model] = parseCsvLine(line);
    if (!/^\d{8}$/.test(tac)) continue;
    rows.push({ tac, brand: brand || "", model: model || "" });
  }

  const BATCH = 2000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("tac_database")
      .upsert(chunk, { onConflict: "tac", ignoreDuplicates: true });
    if (error) {
      return new Response(
        JSON.stringify({ inserted, error: error.message, at: i }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    inserted += chunk.length;
  }

  return new Response(JSON.stringify({ inserted, total: rows.length }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
