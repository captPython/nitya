-- Nitya: a family's own questions, and the community question bank.
--
-- A parent fills in the question template and uploads it. The
-- family-questions server function checks every question again and saves it
-- here, with the family as its owner:
--   * A question that passes the checks is approved, and the family's own
--     children get it at once.
--   * A question with an issue waits in the family's own review (in_review),
--     never in the admin's queue. The family approves, fixes or deletes it.
--   * A question that passed every check, the answer included, is also shared
--     into the community bank, unless its upload is private. A child gets
--     shared questions only when their parent turns the community bank on.
--   * Any family can report a shared question. It is hidden from every family
--     until an admin keeps it, or takes it out of the community bank.
-- Official questions are every question whose source isn't "upload". Admins
-- never see a family's questions, except the shared ones.

-- Uploads -------------------------------------------------------------------

create table public.question_uploads (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.parents (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 200),
  -- Kept out of the community bank.
  private boolean not null default false,
  uploaded_at timestamptz not null default now(),
  -- Set when the family removes it. Questions a child already answered stay,
  -- rejected, so those answers keep their question.
  removed_at timestamptz
);
create index question_uploads_parent_idx on public.question_uploads (parent_id);

alter table public.questions
  add column owner uuid references public.parents (id) on delete cascade,
  add column upload_id uuid references public.question_uploads (id) on delete cascade,
  -- In the community bank.
  add column shared boolean not null default false,
  -- What the checks found, in words for the family. Empty for official questions.
  add column problems text[] not null default '{}',
  -- Set when a family reports a shared question; cleared when an admin keeps it.
  add column hidden_at timestamptz,
  add constraint questions_owner_upload check ((owner is null) = (upload_id is null)),
  -- An uploaded question loses its owner only when its family leaves after
  -- another family's child answered it (see delete_my_account below).
  add constraint questions_owner_source check (owner is null or source = 'upload'),
  add constraint questions_shared_upload check (not shared or source = 'upload');

-- The same question may be in the official bank and in any number of
-- families' own questions, but only once in each.
alter table public.questions drop constraint questions_topic_id_content_key_key;
alter table public.questions
  add constraint questions_topic_owner_content_key unique nulls not distinct (topic_id, owner, content_key);
create index questions_owner_idx on public.questions (owner) where owner is not null;
create index questions_community_idx on public.questions (topic_id, level)
  where shared and status = 'approved' and hidden_at is null;

-- A family's report of a shared question.
create table public.question_reports (
  id bigint generated always as identity primary key,
  question_id text not null references public.questions (id) on delete cascade,
  -- Set to null if the reporting parent deletes their account.
  parent_id uuid references public.parents (id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 300),
  reported_at timestamptz not null default now(),
  -- Set when an admin keeps or removes the question.
  resolved_at timestamptz
);
create index question_reports_open_idx on public.question_reports (question_id) where resolved_at is null;

-- The community bank switch, for each child. Off until a parent turns it on.
alter table public.profiles
  add column community boolean not null default false;

-- Row-level security ----------------------------------------------------------

alter table public.question_uploads enable row level security;
alter table public.question_reports enable row level security;

drop policy "read approved questions" on public.questions;
drop policy "admins add questions" on public.questions;
drop policy "admins change questions" on public.questions;
drop policy "admins remove questions" on public.questions;

-- Official questions as before; a family's own, whatever their state; and
-- every shared one. The app leaves out shared questions that are hidden, and
-- asks for shared ones only for a child with the community bank on.
create policy "read questions" on public.questions for select to authenticated
  using (
    (source <> 'upload' and (status = 'approved' or public.is_admin()))
    or owner = auth.uid()
    or shared
  );
-- Admins manage only the official bank. Families' questions are written only
-- by the family-questions server function and the functions below.
create policy "admins add questions" on public.questions for insert to authenticated
  with check (public.is_admin() and source <> 'upload');
create policy "admins change questions" on public.questions for update to authenticated
  using (public.is_admin() and source <> 'upload') with check (public.is_admin() and source <> 'upload');
create policy "admins remove questions" on public.questions for delete to authenticated
  using (public.is_admin() and source <> 'upload');

create policy "own uploads" on public.question_uploads for select to authenticated
  using (parent_id = auth.uid());
create policy "admins read reports" on public.question_reports for select to authenticated
  using (public.is_admin());

grant select on public.question_uploads, public.question_reports to authenticated;

-- A family's decisions ----------------------------------------------------------

-- Whether any child has answered the question, so it must stay for their answers.
create function public.question_answered(p_question_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quiz_responses where question_id = p_question_id);
$$;
revoke all on function public.question_answered(text) from public, anon, authenticated;

-- Takes one of the family's questions away: deleted, or rejected if a child
-- has answered it.
create function public.drop_own_question(p_question_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.question_answered(p_question_id) then
    update public.questions set status = 'rejected', shared = false where id = p_question_id;
  else
    delete from public.questions where id = p_question_id;
  end if;
end;
$$;
revoke all on function public.drop_own_question(text) from public, anon, authenticated;

-- The family approves (for their own children only) or deletes a question
-- under review. A fix goes through the server function, which checks it again.
create function public.review_own_question(p_question_id text, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.questions;
begin
  select * into q from public.questions where id = p_question_id and owner = auth.uid() for update;
  if not found then
    raise exception 'That question isn''t in this account.';
  end if;
  if p_decision = 'delete' then
    perform public.drop_own_question(p_question_id);
  elsif p_decision = 'approve' then
    if q.status <> 'in_review' then
      raise exception 'This question was already reviewed.';
    end if;
    -- Approved with its issues: never shared.
    update public.questions set status = 'approved', shared = false where id = p_question_id;
  else
    raise exception 'The decision must be approve or delete.';
  end if;
end;
$$;

-- Takes a whole upload away.
create function public.remove_question_upload(p_upload_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q record;
begin
  perform 1 from public.question_uploads where id = p_upload_id and parent_id = auth.uid() and removed_at is null for update;
  if not found then
    raise exception 'That upload isn''t in this account.';
  end if;
  for q in select id from public.questions where upload_id = p_upload_id and status <> 'rejected' loop
    perform public.drop_own_question(q.id);
  end loop;
  if exists (select 1 from public.questions where upload_id = p_upload_id) then
    update public.question_uploads set removed_at = now() where id = p_upload_id;
  else
    delete from public.question_uploads where id = p_upload_id;
  end if;
end;
$$;

-- Reports a shared question. It is hidden from every family at once.
create function public.report_question(p_question_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.parents where id = auth.uid()) then
    raise exception 'Sign in first.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 300 then
    raise exception 'Say in a few words what is wrong with it.';
  end if;
  update public.questions set hidden_at = coalesce(hidden_at, now())
   where id = p_question_id and shared and owner is distinct from auth.uid();
  if not found then
    raise exception 'That question isn''t in the community bank.';
  end if;
  insert into public.question_reports (question_id, parent_id, reason)
  values (p_question_id, auth.uid(), btrim(p_reason));
end;
$$;

-- An admin keeps a reported question (it shows again) or takes it out of the
-- community bank for good (its family still has it).
create function public.moderate_question(p_question_id text, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  if p_decision not in ('keep', 'remove') then
    raise exception 'The decision must be keep or remove.';
  end if;
  update public.questions
     set hidden_at = null, shared = (p_decision = 'keep')
   where id = p_question_id and shared;
  if not found then
    raise exception 'That question isn''t in the community bank.';
  end if;
  update public.question_reports set resolved_at = now()
   where question_id = p_question_id and resolved_at is null;
end;
$$;

revoke all on function
  public.review_own_question(text, text), public.remove_question_upload(uuid),
  public.report_question(text, text), public.moderate_question(text, text)
  from public, anon;
grant execute on function
  public.review_own_question(text, text), public.remove_question_upload(uuid),
  public.report_question(text, text), public.moderate_question(text, text)
  to authenticated;

-- The admin's review queue is for the official bank only.
create or replace function public.review_question(
  p_question_id text,
  p_decision text,
  p_note text default null,
  p_fixed jsonb default null,
  p_report jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.questions;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can review questions.' using errcode = '42501';
  end if;
  select * into q from public.questions where id = p_question_id and source <> 'upload' for update;
  if not found then
    raise exception 'There is no question %.', p_question_id;
  end if;
  if q.status <> 'in_review' then
    raise exception 'This question was already reviewed.';
  end if;

  if p_decision = 'fixed' then
    if p_fixed is null or p_report is null then
      raise exception 'A fix needs the new question and its check report.';
    end if;
    if q.source = 'csv' then
      raise exception 'Fix CSV questions in the Drive file, so the next sync keeps the fix.';
    end if;
    update public.questions set
      sub_skill = p_fixed ->> 'sub_skill',
      level = (p_fixed ->> 'level')::smallint,
      prompt = p_fixed ->> 'prompt',
      visual = nullif(p_fixed -> 'visual', 'null'::jsonb),
      options = (select array_agg(o) from jsonb_array_elements_text(nullif(p_fixed -> 'options', 'null'::jsonb)) o),
      answers = (select array_agg(a) from jsonb_array_elements_text(p_fixed -> 'answers') a),
      hint = p_fixed ->> 'hint',
      explanation = p_fixed ->> 'explanation',
      reason = p_fixed ->> 'reason',
      working = nullif(p_fixed -> 'working', 'null'::jsonb),
      status = 'approved',
      times_shown = 0,
      first_try_correct = 0
    where id = p_question_id;
    insert into public.question_checks (question_id, reason, passed, report)
    values (p_question_id, 'release', coalesce((p_report ->> 'passed')::boolean, false), p_report);
  elsif p_decision = 'approved' then
    update public.questions set status = 'approved' where id = p_question_id;
  elsif p_decision = 'rejected' then
    update public.questions set status = 'rejected' where id = p_question_id;
  else
    raise exception 'The decision must be approved, fixed or rejected.';
  end if;

  insert into public.question_reviews (question_id, reviewer_id, decision, note)
  values (p_question_id, auth.uid(), p_decision, nullif(btrim(p_note), ''));
end;
$$;

-- Withdrawing consent deletes the family's questions with everything else.
-- A question another family's child has answered can't be deleted without
-- losing that child's answers, so it stays without its family: shared ones
-- stay in the community bank, the rest out of everyone's sight.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  update public.questions q set owner = null, upload_id = null
   where q.owner = auth.uid()
     and exists (
       select 1 from public.quiz_responses r
       join public.quiz_attempts a on a.id = r.attempt_id
       join public.profiles p on p.id = a.profile_id
       where r.question_id = q.id and p.parent_id <> auth.uid()
     );
  delete from auth.users where id = auth.uid();
end;
$$;
