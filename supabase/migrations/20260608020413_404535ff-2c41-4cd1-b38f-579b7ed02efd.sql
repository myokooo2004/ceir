CREATE TABLE public.device_overrides (
  tac TEXT PRIMARY KEY CHECK (tac ~ '^[0-9]{8}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.device_overrides TO anon, authenticated;
GRANT ALL ON public.device_overrides TO service_role;
ALTER TABLE public.device_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read device overrides" ON public.device_overrides FOR SELECT USING (true);
CREATE POLICY "Anyone can add device overrides" ON public.device_overrides FOR INSERT WITH CHECK (true);