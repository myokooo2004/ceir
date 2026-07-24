
CREATE TABLE public.tac_database (
  tac TEXT PRIMARY KEY,
  brand TEXT,
  model TEXT
);
GRANT SELECT ON public.tac_database TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tac_database TO authenticated;
GRANT ALL ON public.tac_database TO service_role;
ALTER TABLE public.tac_database ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read tac_database" ON public.tac_database FOR SELECT USING (true);
CREATE INDEX idx_tac_database_tac ON public.tac_database(tac);
