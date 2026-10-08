-- Baseline: schema of the public schema as it existed on staging (uefijiwklnelmwcipwku) on 2026-10-08,
-- dumped with pg_dump 18.6 --schema-only --schema=public --schema=private --no-owner (staging has no private schema).
-- The public schema matched production's structure-only dump line for line.
--
-- This file is NEVER executed against staging or production. Both already have this schema;
-- the migration is marked applied with `supabase migration repair --status applied <version>`.
-- It exists so a fresh local database (supabase db reset) starts from the same schema.
--
-- Edits from the raw dump: removed the \restrict lines, CREATE SCHEMA public and its comment
-- (every Supabase database has them), and ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
-- (platform managed). Added the extensions and the cron job the schema depends on.
-- Known problems in this schema are kept as they are and fixed in later migrations.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: auto_clean_old_reports(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_clean_old_reports() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.reports
  set status = 'cleaned',
      updated_at = now()
  -- 'pending' left out: unmoderated reports shouldn't surface publicly as Cleaned.
  where status in ('verified', 'active', 'reported', 'open')
    and is_deleted = false
    and created_at <= now() - interval '15 days';
$$;


--
-- Name: match_reports(extensions.vector, integer, uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_reports(query_embedding extensions.vector, match_count integer DEFAULT 10, exclude_id uuid DEFAULT NULL::uuid, filter_district text DEFAULT NULL::text, created_after timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id uuid, constituency text, district text, area text, landmark text, waste_type text, description text, status text, created_at timestamp with time zone, similarity double precision)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions'
    AS $$
  select
    r.id,
    r.constituency,
    r.district,
    r.area,
    r.landmark,
    r.waste_type,
    r.description,
    r.status,
    r.created_at,
    1 - (r.embedding <=> query_embedding) as similarity
  from public.reports r
  where r.embedding is not null
    and coalesce(r.is_deleted, false) = false
    and (exclude_id is null or r.id <> exclude_id)
    and (filter_district is null or r.district = filter_district)
    and (created_after is null or r.created_at >= created_after)
  order by r.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: authority_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authority_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    authority_type text NOT NULL,
    email text,
    phone text,
    district text,
    constituency text,
    waste_types text[],
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: cleanup_proofs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleanup_proofs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    image_url text NOT NULL,
    submitted_by text,
    cleaned_date_estimate text,
    status text DEFAULT 'pending'::text,
    admin_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT cleanup_proofs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: constituencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constituencies (
    id bigint NOT NULL,
    name text NOT NULL,
    district text NOT NULL,
    lok_sabha_seat text NOT NULL,
    mla_name text NOT NULL,
    mla_party text NOT NULL,
    mp_name text NOT NULL,
    mp_party text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: constituencies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.constituencies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.constituencies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: escalation_guidelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_guidelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_type text DEFAULT 'location_keyword'::text NOT NULL,
    match_value text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    authority_type text,
    guidance text DEFAULT ''::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT escalation_guidelines_match_type_check CHECK ((match_type = ANY (ARRAY['location_keyword'::text, 'waste_type'::text, 'pattern'::text]))),
    CONSTRAINT escalation_guidelines_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))
);


--
-- Name: mla_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mla_list (
    id bigint NOT NULL,
    name text,
    constituency text,
    district text,
    lok_sabha_seat text,
    party text,
    phone text,
    email text,
    photo_url text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    x_handle text,
    x_handle_verified boolean DEFAULT false NOT NULL
);


--
-- Name: mp_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mp_list (
    id bigint NOT NULL,
    name text,
    lok_sabha_seat text,
    party text,
    phone text,
    email text,
    photo_url text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    x_handle text,
    x_handle_verified boolean DEFAULT false NOT NULL,
    seat_status text DEFAULT 'filled'::text NOT NULL
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    constituency text,
    district text,
    lok_sabha_seat text,
    mla text,
    mla_party text,
    mp text,
    mp_party text,
    area text,
    landmark text,
    waste_type text DEFAULT 'mixed'::text,
    description text DEFAULT ''::text,
    photo_url text,
    lat double precision,
    lng double precision,
    status text DEFAULT 'verified'::text,
    assigned_to text,
    rejected_at timestamp with time zone,
    is_deleted boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    embedding extensions.vector(384),
    embedded_at timestamp with time zone,
    tweeted_at timestamp with time zone,
    emailed_at timestamp with time zone,
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'cleaned'::text, 'rejected'::text])))
);


--
-- Name: public_reports; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_reports WITH (security_invoker='true') AS
 SELECT r.id,
    r.constituency,
    r.district,
    r.lok_sabha_seat,
    COALESCE(m.name, r.mla) AS mla,
    COALESCE(m.party, r.mla_party) AS mla_party,
    COALESCE(p.name, r.mp) AS mp,
    COALESCE(p.party, r.mp_party) AS mp_party,
    r.area,
    r.landmark,
    r.waste_type,
    r.description,
    r.photo_url,
    approved_proof.image_url AS cleanup_photo_url,
    r.lat,
    r.lng,
    r.status,
    r.assigned_to,
    r.rejected_at,
    r.is_deleted,
    r.created_at,
    r.updated_at
   FROM (((public.reports r
     LEFT JOIN public.mla_list m ON ((m.constituency = r.constituency)))
     LEFT JOIN public.mp_list p ON ((p.lok_sabha_seat = r.lok_sabha_seat)))
     LEFT JOIN LATERAL ( SELECT proof.image_url
           FROM public.cleanup_proofs proof
          WHERE ((proof.report_id = r.id) AND (proof.status = 'approved'::text))
          ORDER BY proof.updated_at DESC, proof.created_at DESC
         LIMIT 1) approved_proof ON (true))
  WHERE ((COALESCE(r.is_deleted, false) = false) AND (r.status = ANY (ARRAY['verified'::text, 'cleaned'::text])));


--
-- Name: recommendations_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recommendations_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid,
    admin_id uuid,
    caption_generated text,
    caption_final text,
    similar_report_ids jsonb DEFAULT '[]'::jsonb,
    pattern jsonb DEFAULT '{}'::jsonb,
    escalations jsonb DEFAULT '[]'::jsonb,
    suggested_authorities jsonb DEFAULT '[]'::jsonb,
    suggested_actions jsonb DEFAULT '[]'::jsonb,
    post_timing text,
    executed_actions jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'generated'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT recommendations_audit_status_check CHECK ((status = ANY (ARRAY['generated'::text, 'approved'::text, 'executed'::text, 'cancelled'::text, 'error'::text])))
);


--
-- Name: report_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_activity (
    constituency character varying(100),
    district character varying(100),
    hour timestamp with time zone,
    report_count integer
);


--
-- Name: report_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_contacts (
    report_id uuid NOT NULL,
    name text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: authority_contacts authority_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authority_contacts
    ADD CONSTRAINT authority_contacts_pkey PRIMARY KEY (id);


--
-- Name: cleanup_proofs cleanup_proofs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_proofs
    ADD CONSTRAINT cleanup_proofs_pkey PRIMARY KEY (id);


--
-- Name: constituencies constituencies_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constituencies
    ADD CONSTRAINT constituencies_name_key UNIQUE (name);


--
-- Name: constituencies constituencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constituencies
    ADD CONSTRAINT constituencies_pkey PRIMARY KEY (id);


--
-- Name: escalation_guidelines escalation_guidelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_guidelines
    ADD CONSTRAINT escalation_guidelines_pkey PRIMARY KEY (id);


--
-- Name: mla_list mla_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mla_list
    ADD CONSTRAINT mla_list_pkey PRIMARY KEY (id);


--
-- Name: mp_list mp_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mp_list
    ADD CONSTRAINT mp_list_pkey PRIMARY KEY (id);


--
-- Name: recommendations_audit recommendations_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendations_audit
    ADD CONSTRAINT recommendations_audit_pkey PRIMARY KEY (id);


--
-- Name: report_contacts report_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_contacts
    ADD CONSTRAINT report_contacts_pkey PRIMARY KEY (report_id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: reports unique_photo_url; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT unique_photo_url UNIQUE (photo_url);


--
-- Name: idx_authority_contacts_district; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authority_contacts_district ON public.authority_contacts USING btree (district);


--
-- Name: idx_authority_contacts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_authority_contacts_type ON public.authority_contacts USING btree (authority_type);


--
-- Name: idx_cleanup_proofs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proofs_created_at ON public.cleanup_proofs USING btree (created_at);


--
-- Name: idx_cleanup_proofs_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proofs_report_id ON public.cleanup_proofs USING btree (report_id);


--
-- Name: idx_cleanup_proofs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cleanup_proofs_status ON public.cleanup_proofs USING btree (status);


--
-- Name: idx_escalation_guidelines_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_guidelines_active ON public.escalation_guidelines USING btree (is_active);


--
-- Name: idx_recommendations_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recommendations_audit_created ON public.recommendations_audit USING btree (created_at);


--
-- Name: idx_recommendations_audit_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recommendations_audit_report ON public.recommendations_audit USING btree (report_id);


--
-- Name: idx_reports_constituency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_constituency ON public.reports USING btree (constituency);


--
-- Name: idx_reports_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_created_at ON public.reports USING btree (created_at);


--
-- Name: idx_reports_district; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_district ON public.reports USING btree (district);


--
-- Name: idx_reports_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_embedding ON public.reports USING hnsw (embedding extensions.vector_cosine_ops);


--
-- Name: idx_reports_rejected_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_rejected_at ON public.reports USING btree (rejected_at);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_status ON public.reports USING btree (status);


--
-- Name: idx_reports_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_updated_at ON public.reports USING btree (updated_at);


--
-- Name: idx_reports_waste_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_waste_type ON public.reports USING btree (waste_type);


--
-- Name: cleanup_proofs cleanup_proofs_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleanup_proofs
    ADD CONSTRAINT cleanup_proofs_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE;


--
-- Name: recommendations_audit recommendations_audit_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recommendations_audit
    ADD CONSTRAINT recommendations_audit_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE SET NULL;


--
-- Name: report_contacts report_contacts_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_contacts
    ADD CONSTRAINT report_contacts_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE;


--
-- Name: reports Admin delete rejected reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin delete rejected reports" ON public.reports FOR DELETE TO authenticated USING (((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (status = 'rejected'::text) AND (rejected_at IS NOT NULL) AND (rejected_at < (now() - '7 days'::interval))));


--
-- Name: authority_contacts Admin read authority contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read authority contacts" ON public.authority_contacts FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: cleanup_proofs Admin read cleanup proofs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read cleanup proofs" ON public.cleanup_proofs FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: escalation_guidelines Admin read escalation guidelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read escalation guidelines" ON public.escalation_guidelines FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: recommendations_audit Admin read recommendations audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read recommendations audit" ON public.recommendations_audit FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: report_contacts Admin read report contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read report contacts" ON public.report_contacts FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: reports Admin read reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin read reports" ON public.reports FOR SELECT TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: cleanup_proofs Admin update cleanup proofs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin update cleanup proofs" ON public.cleanup_proofs FOR UPDATE TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text)) WITH CHECK ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: recommendations_audit Admin update recommendations audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin update recommendations audit" ON public.recommendations_audit FOR UPDATE TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text)) WITH CHECK ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: reports Admin update reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin update reports" ON public.reports FOR UPDATE TO authenticated USING ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text)) WITH CHECK ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: recommendations_audit Admin write recommendations audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin write recommendations audit" ON public.recommendations_audit FOR INSERT TO authenticated WITH CHECK ((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'admin'::text));


--
-- Name: reports Allow public read reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public read reports" ON public.reports FOR SELECT TO authenticated, anon USING ((status = ANY (ARRAY['pending'::text, 'active'::text, 'reported'::text, 'open'::text, 'cleaned'::text])));


--
-- Name: reports Public can read visible reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read visible reports" ON public.reports FOR SELECT TO authenticated, anon USING (((COALESCE(is_deleted, false) = false) AND (status = ANY (ARRAY['pending'::text, 'verified'::text, 'active'::text, 'reported'::text, 'open'::text, 'cleaned'::text]))));


--
-- Name: mla_list Public read MLA list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read MLA list" ON public.mla_list FOR SELECT TO authenticated, anon USING (true);


--
-- Name: mp_list Public read MP list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read MP list" ON public.mp_list FOR SELECT TO authenticated, anon USING (true);


--
-- Name: cleanup_proofs Public read approved cleanup proofs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read approved cleanup proofs" ON public.cleanup_proofs FOR SELECT TO authenticated, anon USING ((status = 'approved'::text));


--
-- Name: mla_list Public read mla_list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read mla_list" ON public.mla_list FOR SELECT USING (true);


--
-- Name: mp_list Public read mp_list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read mp_list" ON public.mp_list FOR SELECT USING (true);


--
-- Name: reports Public read reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read reports" ON public.reports FOR SELECT TO authenticated, anon USING (((COALESCE(is_deleted, false) = false) AND (status = ANY (ARRAY['verified'::text, 'cleaned'::text]))));


--
-- Name: authority_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.authority_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: cleanup_proofs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cleanup_proofs ENABLE ROW LEVEL SECURITY;

--
-- Name: constituencies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.constituencies ENABLE ROW LEVEL SECURITY;

--
-- Name: escalation_guidelines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.escalation_guidelines ENABLE ROW LEVEL SECURITY;

--
-- Name: mla_list; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mla_list ENABLE ROW LEVEL SECURITY;

--
-- Name: mp_list; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mp_list ENABLE ROW LEVEL SECURITY;

--
-- Name: constituencies public read constituencies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read constituencies" ON public.constituencies FOR SELECT USING (true);


--
-- Name: recommendations_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recommendations_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: report_activity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: report_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: reports temporarily_blocked; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY temporarily_blocked ON public.reports FOR INSERT TO anon WITH CHECK (false);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION auto_clean_old_reports(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auto_clean_old_reports() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_clean_old_reports() TO service_role;


--
-- Name: FUNCTION match_reports(query_embedding extensions.vector, match_count integer, exclude_id uuid, filter_district text, created_after timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_reports(query_embedding extensions.vector, match_count integer, exclude_id uuid, filter_district text, created_after timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.match_reports(query_embedding extensions.vector, match_count integer, exclude_id uuid, filter_district text, created_after timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.match_reports(query_embedding extensions.vector, match_count integer, exclude_id uuid, filter_district text, created_after timestamp with time zone) TO service_role;


--
-- Name: TABLE authority_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.authority_contacts TO service_role;
GRANT SELECT ON TABLE public.authority_contacts TO authenticated;


--
-- Name: TABLE cleanup_proofs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cleanup_proofs TO service_role;
GRANT SELECT,UPDATE ON TABLE public.cleanup_proofs TO authenticated;


--
-- Name: COLUMN cleanup_proofs.report_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(report_id) ON TABLE public.cleanup_proofs TO anon;


--
-- Name: COLUMN cleanup_proofs.image_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(image_url) ON TABLE public.cleanup_proofs TO anon;


--
-- Name: COLUMN cleanup_proofs.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.cleanup_proofs TO anon;


--
-- Name: COLUMN cleanup_proofs.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.cleanup_proofs TO anon;


--
-- Name: COLUMN cleanup_proofs.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.cleanup_proofs TO anon;


--
-- Name: TABLE constituencies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.constituencies TO anon;
GRANT ALL ON TABLE public.constituencies TO authenticated;
GRANT ALL ON TABLE public.constituencies TO service_role;


--
-- Name: SEQUENCE constituencies_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.constituencies_id_seq TO anon;
GRANT ALL ON SEQUENCE public.constituencies_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.constituencies_id_seq TO service_role;


--
-- Name: TABLE escalation_guidelines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.escalation_guidelines TO service_role;
GRANT SELECT ON TABLE public.escalation_guidelines TO authenticated;


--
-- Name: TABLE mla_list; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mla_list TO anon;
GRANT ALL ON TABLE public.mla_list TO authenticated;
GRANT ALL ON TABLE public.mla_list TO service_role;


--
-- Name: TABLE mp_list; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mp_list TO anon;
GRANT ALL ON TABLE public.mp_list TO authenticated;
GRANT ALL ON TABLE public.mp_list TO service_role;


--
-- Name: TABLE reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reports TO service_role;
GRANT SELECT ON TABLE public.reports TO anon;
GRANT SELECT,DELETE,UPDATE ON TABLE public.reports TO authenticated;


--
-- Name: TABLE public_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_reports TO anon;
GRANT ALL ON TABLE public.public_reports TO authenticated;
GRANT ALL ON TABLE public.public_reports TO service_role;


--
-- Name: TABLE recommendations_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.recommendations_audit TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.recommendations_audit TO authenticated;


--
-- Name: TABLE report_activity; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.report_activity TO anon;
GRANT ALL ON TABLE public.report_activity TO authenticated;
GRANT ALL ON TABLE public.report_activity TO service_role;


--
-- Name: TABLE report_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.report_contacts TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.report_contacts TO authenticated;
GRANT ALL ON TABLE public.report_contacts TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--



-- Daily sweep that marks reports older than 15 days as cleaned (see auto_clean_old_reports).
select cron.schedule('jabor-auto-clean-old-reports', '0 0 * * *', 'select public.auto_clean_old_reports()');
