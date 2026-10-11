-- Restores the policies exactly as they were before 20261010074755 (from the baseline).
-- Warning: this brings back the leak of hidden pending or cleaned reports to anon.

drop policy if exists "Public read reports" on public.reports;

CREATE POLICY "Allow public read reports" ON public.reports FOR SELECT TO authenticated, anon USING ((status = ANY (ARRAY['pending'::text, 'active'::text, 'reported'::text, 'open'::text, 'cleaned'::text])));
CREATE POLICY "Public can read visible reports" ON public.reports FOR SELECT TO authenticated, anon USING (((COALESCE(is_deleted, false) = false) AND (status = ANY (ARRAY['pending'::text, 'verified'::text, 'active'::text, 'reported'::text, 'open'::text, 'cleaned'::text]))));
CREATE POLICY "Public read reports" ON public.reports FOR SELECT TO authenticated, anon USING (((COALESCE(is_deleted, false) = false) AND (status = ANY (ARRAY['verified'::text, 'cleaned'::text]))));
CREATE POLICY "Public read mla_list" ON public.mla_list FOR SELECT USING (true);
CREATE POLICY "Public read mp_list" ON public.mp_list FOR SELECT USING (true);
