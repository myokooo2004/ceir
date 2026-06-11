
CREATE TABLE public.scan_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  imei1 TEXT NOT NULL,
  imei2 TEXT,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.scan_history TO anon;
GRANT SELECT, INSERT ON public.scan_history TO authenticated;
GRANT ALL ON public.scan_history TO service_role;

ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert scans"
  ON public.scan_history FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can read scans"
  ON public.scan_history FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE INDEX scan_history_created_at_idx ON public.scan_history (created_at DESC);
