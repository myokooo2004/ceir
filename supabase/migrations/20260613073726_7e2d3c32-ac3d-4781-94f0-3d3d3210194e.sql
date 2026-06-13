-- Allow updates/deletes on scan_history (no auth) and updates on device_overrides
CREATE POLICY "Anyone can update scans" ON public.scan_history FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete scans" ON public.scan_history FOR DELETE TO anon, authenticated USING (true);

-- device_overrides: allow updates (for rename) and make tac the primary key for upsert
ALTER TABLE public.device_overrides ADD CONSTRAINT device_overrides_tac_key UNIQUE (tac);
CREATE POLICY "Anyone can update device overrides" ON public.device_overrides FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
GRANT UPDATE ON public.device_overrides TO anon, authenticated;
GRANT UPDATE, DELETE ON public.scan_history TO anon, authenticated;