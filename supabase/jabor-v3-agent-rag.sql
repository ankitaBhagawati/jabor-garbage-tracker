-- Jabor Version 3 — Agentic RAG migration
-- Run in the target Supabase project's SQL Editor (or via supabase db push).
--
-- Adds the building blocks for AI social-media recommendations:
--   * pgvector embeddings on reports (gte-small => 384 dimensions)
--   * civic escalation guidelines + authority contacts (RAG knowledge base)
--   * recommendations audit log (human-in-the-loop trail)
--   * match_reports() similarity RPC used by the edge functions
-- Admin users must have raw_app_meta_data.role = 'admin'.

create extension if not exists vector;

-- ── Embeddings on reports ───────────────────────────────────────────────────
-- gte-small (Supabase built-in model) produces 384-dimension vectors.
alter table public.reports add column if not exists embedding vector(384);
alter table public.reports add column if not exists embedded_at timestamptz;

-- IVFFlat needs ANALYZE + data to be useful; HNSW works well from the start and
-- needs no training step, so prefer it for a small/growing dataset.
create index if not exists idx_reports_embedding
  on public.reports using hnsw (embedding vector_cosine_ops);

-- ── Civic escalation guidelines (RAG knowledge base) ────────────────────────
create table if not exists public.escalation_guidelines (
  id uuid primary key default gen_random_uuid(),
  -- match_type: 'location_keyword' (matches area/landmark text) or
  -- 'waste_type' (matches reports.waste_type) or 'pattern' (repeat reports).
  match_type text not null default 'location_keyword',
  match_value text not null,
  severity text not null default 'medium',
  authority_type text,
  guidance text not null default '',
  is_active boolean not null default true,
  created_at timestamptz default now(),
  constraint escalation_guidelines_severity_check
    check (severity in ('low', 'medium', 'high')),
  constraint escalation_guidelines_match_type_check
    check (match_type in ('location_keyword', 'waste_type', 'pattern'))
);

create index if not exists idx_escalation_guidelines_active
  on public.escalation_guidelines(is_active);

-- ── Authority contacts (who to email) ───────────────────────────────────────
create table if not exists public.authority_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  authority_type text not null,
  email text,
  phone text,
  -- Optional scoping. NULL means "applies statewide / any".
  district text,
  constituency text,
  waste_types text[],
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create index if not exists idx_authority_contacts_type
  on public.authority_contacts(authority_type);
create index if not exists idx_authority_contacts_district
  on public.authority_contacts(district);

-- ── Recommendations audit log (human-in-the-loop trail) ─────────────────────
create table if not exists public.recommendations_audit (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.reports(id) on delete set null,
  admin_id uuid,
  -- Snapshot of what the agent produced.
  caption_generated text,
  caption_final text,
  similar_report_ids jsonb default '[]'::jsonb,
  pattern jsonb default '{}'::jsonb,
  escalations jsonb default '[]'::jsonb,
  suggested_authorities jsonb default '[]'::jsonb,
  suggested_actions jsonb default '[]'::jsonb,
  post_timing text,
  -- Filled when the admin approves + we execute.
  executed_actions jsonb default '[]'::jsonb,
  status text not null default 'generated',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint recommendations_audit_status_check
    check (status in ('generated', 'approved', 'executed', 'cancelled', 'error'))
);

create index if not exists idx_recommendations_audit_report
  on public.recommendations_audit(report_id);
create index if not exists idx_recommendations_audit_created
  on public.recommendations_audit(created_at);

-- ── Similarity search RPC ───────────────────────────────────────────────────
-- Returns the most similar non-deleted reports to a query embedding, optionally
-- excluding one report id and filtering by district + a created-after window.
create or replace function public.match_reports(
  query_embedding vector(384),
  match_count int default 10,
  exclude_id uuid default null,
  filter_district text default null,
  created_after timestamptz default null
)
returns table (
  id uuid,
  constituency text,
  district text,
  area text,
  landmark text,
  waste_type text,
  description text,
  status text,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
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

-- ── RLS + grants ────────────────────────────────────────────────────────────
alter table public.escalation_guidelines enable row level security;
alter table public.authority_contacts enable row level security;
alter table public.recommendations_audit enable row level security;

-- The edge functions use the service role key (bypasses RLS). These grants/policies
-- only matter for any direct authenticated access; keep them admin-only.
revoke all on public.escalation_guidelines from anon, authenticated;
revoke all on public.authority_contacts from anon, authenticated;
revoke all on public.recommendations_audit from anon, authenticated;

grant select on public.escalation_guidelines to authenticated;
grant select on public.authority_contacts to authenticated;
grant select, insert, update on public.recommendations_audit to authenticated;

drop policy if exists "Admin read escalation guidelines" on public.escalation_guidelines;
create policy "Admin read escalation guidelines"
on public.escalation_guidelines for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin read authority contacts" on public.authority_contacts;
create policy "Admin read authority contacts"
on public.authority_contacts for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin read recommendations audit" on public.recommendations_audit;
create policy "Admin read recommendations audit"
on public.recommendations_audit for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin write recommendations audit" on public.recommendations_audit;
create policy "Admin write recommendations audit"
on public.recommendations_audit for insert
to authenticated
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin update recommendations audit" on public.recommendations_audit;
create policy "Admin update recommendations audit"
on public.recommendations_audit for update
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin')
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

grant execute on function public.match_reports(vector, int, uuid, text, timestamptz)
  to authenticated, service_role;

-- ── Seed data ───────────────────────────────────────────────────────────────
-- Escalation guidelines. Location keywords are matched case-insensitively
-- against the report's area + landmark text by the agent.
insert into public.escalation_guidelines (match_type, match_value, severity, authority_type, guidance)
values
  ('location_keyword', 'school',   'high',   'health_department',     'Garbage near a school is a child-health hazard. Notify the District Health Department urgently.'),
  ('location_keyword', 'hospital', 'high',   'health_department',     'Waste near a hospital risks infection spread. Escalate to the Health Department immediately.'),
  ('location_keyword', 'market',   'medium', 'municipal_corporation', 'Markets generate high footfall; route to the Municipal Corporation for prompt clearing.'),
  ('location_keyword', 'river',    'high',   'pollution_control',     'Waste near water bodies pollutes the river. Escalate to the State Pollution Control Board.'),
  ('location_keyword', 'drain',    'medium', 'municipal_corporation', 'Blocked drains cause flooding. Flag the Municipal Corporation sanitation wing.'),
  ('waste_type',       'medical',  'high',   'health_department',     'Biomedical waste needs specialised handling. Escalate to the Health Department.'),
  ('waste_type',       'hazardous','high',   'pollution_control',     'Hazardous waste must go to the Pollution Control Board for safe disposal.'),
  ('pattern',          'repeat',   'high',   'municipal_corporation', 'Repeat reports in the same area indicate a systemic failure. Escalate to the Municipal Corporation.')
on conflict do nothing;

-- Sample statewide authority contacts. Replace emails with real ones before
-- enabling live email execution.
insert into public.authority_contacts (name, authority_type, email, district)
values
  ('District Health Department',        'health_department',     'health.dept@example.gov.in',     null),
  ('Guwahati Municipal Corporation',    'municipal_corporation', 'gmc.sanitation@example.gov.in',  'Kamrup Metropolitan'),
  ('Assam State Pollution Control Board','pollution_control',    'pcb.assam@example.gov.in',       null),
  ('Municipal Corporation (Statewide)', 'municipal_corporation', 'municipal@example.gov.in',       null)
on conflict do nothing;

-- Reload PostgREST schema cache.
notify pgrst, 'reload schema';
