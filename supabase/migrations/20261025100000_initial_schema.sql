-- Nitya initial schema: the question bank and its checks, families and child
-- profiles, quiz progress, and the admin and parent settings.
--
-- Access rules (row-level security):
--   * Everyone signed in can read topics, approved questions, level bands and
--     topic settings. Only admins can change them or see unapproved questions.
--   * A parent sees and changes only their own row, consents and child
--     profiles, and only those profiles' progress, quizzes and settings.
--   * Admins get no access to family data through these rules.
--   * Signed-out (anon) users get nothing.

create type public.class_id as enum (
  'LKG', 'UKG', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12'
);
create type public.question_status as enum ('pending', 'approved', 'in_review', 'rejected');
create type public.question_source as enum ('template', 'csv', 'website');
create type public.topic_state as enum ('locked', 'current', 'cleared');

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Admins ---------------------------------------------------------------------

-- Rows are added from the Supabase dashboard or with the service role, never
-- from the app.
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Topics and questions -------------------------------------------------------

create table public.topics (
  id text primary key,
  class_id public.class_id not null,
  position int not null check (position > 0),
  title text not null check (title <> ''),
  -- Sub-skill id -> the name shown to parents, e.g. {"count-on": "Counting on"}.
  sub_skills jsonb not null default '{}',
  unique (class_id, position)
);

create table public.questions (
  id text primary key,
  topic_id text not null references public.topics (id),
  sub_skill text not null,
  level smallint not null check (level between 1 and 4),
  format text not null check (format in (
    'tap-picture', 'match', 'drag-drop', 'count', 'audio', 'pattern', 'balance',
    'number-line', 'mcq', 'fill-blank', 'true-false', 'numeric', 'multi-step'
  )),
  prompt text not null check (prompt <> ''),
  visual jsonb,
  options text[],
  answers text[] not null check (cardinality(answers) > 0),
  hint text not null,
  explanation text not null,
  -- The one-line reason shown with the praise after a right answer.
  reason text not null,
  source public.question_source not null,
  -- Template name, CSV file name, or the page link the question came from.
  source_ref text,
  generator_version text,
  -- For generated questions: the numbers used and how the answer was worked
  -- out, so the validation engine can recompute it.
  working jsonb,
  -- Questions in one group (like "3 + 4" and "4 + 3") never share a quiz.
  variant_group text,
  status public.question_status not null default 'pending',
  times_shown int not null default 0 check (times_shown >= 0),
  first_try_correct int not null default 0 check (first_try_correct between 0 and times_shown),
  created_at timestamptz not null default now(),
  -- Same prompt and picture in one topic = the same question.
  content_key text generated always as (md5(prompt || coalesce(visual::text, ''))) stored,
  unique (topic_id, content_key),
  check (source <> 'website' or source_ref is not null)
);
create index questions_serving_idx on public.questions (topic_id, level) where status = 'approved';

-- One row per run of the automatic checks on a question.
create table public.question_checks (
  id bigint generated always as identity primary key,
  question_id text not null references public.questions (id) on delete cascade,
  reason text not null check (reason in ('release', 'outside-band')),
  passed boolean not null,
  -- Per-check results: answer, options, scope, level tag, wording and safety.
  report jsonb not null,
  checked_at timestamptz not null default now()
);
create index question_checks_question_idx on public.question_checks (question_id, checked_at desc);

-- An admin's manual decision on a question that failed a check.
create table public.question_reviews (
  id bigint generated always as identity primary key,
  question_id text not null references public.questions (id) on delete cascade,
  reviewer_id uuid references auth.users (id) on delete set null,
  decision text not null check (decision in ('approved', 'fixed', 'rejected')),
  note text,
  reviewed_at timestamptz not null default now()
);

-- Admin settings -------------------------------------------------------------

-- First-try success rate that each level should have. A band covers
-- min_rate <= rate < max_rate, except L1, which also includes 100%.
create table public.level_bands (
  level smallint primary key check (level between 1 and 4),
  min_rate numeric(4, 3) not null check (min_rate >= 0),
  max_rate numeric(4, 3) not null check (max_rate <= 1 and max_rate > min_rate),
  updated_at timestamptz not null default now()
);

-- Bands must cover 0% to 100% with no gaps or overlaps, harder levels lower.
-- Checked at commit, so an admin can change several bands in one transaction.
create function public.check_level_bands() returns trigger
language plpgsql set search_path = '' as $$
declare
  bands numeric[][];
begin
  select array_agg(array[min_rate, max_rate] order by level) into bands from public.level_bands;
  if coalesce(array_length(bands, 1), 0) <> 4
     or bands[1][2] <> 1 or bands[4][1] <> 0
     or bands[1][1] <> bands[2][2] or bands[2][1] <> bands[3][2] or bands[3][1] <> bands[4][2] then
    raise exception 'level bands must run from 100%% (L1) down to 0%% (L4) with no gaps or overlaps';
  end if;
  return null;
end;
$$;
create constraint trigger level_bands_valid
  after insert or update or delete on public.level_bands
  deferrable initially deferred
  for each row execute function public.check_level_bands();
create trigger level_bands_touch before update on public.level_bands
  for each row execute function public.touch_updated_at();

-- The admin's defaults for a topic, and the limits a parent can change them
-- within for one child.
create table public.topic_settings (
  topic_id text primary key references public.topics (id) on delete cascade,
  pass_marks int not null,
  pass_marks_min int not null check (pass_marks_min > 0),
  pass_marks_max int not null,
  wrong_penalty int not null,
  wrong_penalty_min int not null check (wrong_penalty_min >= 0),
  wrong_penalty_max int not null,
  updated_at timestamptz not null default now(),
  check (pass_marks between pass_marks_min and pass_marks_max),
  check (wrong_penalty between wrong_penalty_min and wrong_penalty_max)
);
create trigger topic_settings_touch before update on public.topic_settings
  for each row execute function public.touch_updated_at();

-- Families -------------------------------------------------------------------

-- The signed-in parent. The app creates this row after sign-in.
create table public.parents (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Verifiable parental consent (COPPA, DPDP): when it was given and which
-- consent text was shown. Kept as a record, so never edited.
create table public.consents (
  id bigint generated always as identity primary key,
  parent_id uuid not null references public.parents (id) on delete cascade,
  consent_version text not null check (consent_version <> ''),
  given_at timestamptz not null default now()
);

-- A child profile holds only what onboarding asks for.
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.parents (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 30),
  avatar text not null check (avatar <> ''),
  class_id public.class_id not null,
  board text not null check (board <> ''),
  language text not null check (language <> ''),
  created_at timestamptz not null default now()
);
create index profiles_parent_idx on public.profiles (parent_id);

create function public.has_consent() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.consents where parent_id = auth.uid());
$$;

create function public.owns_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_profile and parent_id = auth.uid());
$$;

-- A parent's change to one child's topic settings. Null = the admin default.
create table public.profile_topic_settings (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  topic_id text not null references public.topics (id) on delete cascade,
  pass_marks int,
  wrong_penalty int,
  updated_at timestamptz not null default now(),
  primary key (profile_id, topic_id)
);

create function public.check_profile_topic_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t public.topic_settings;
begin
  select * into t from public.topic_settings where topic_id = new.topic_id;
  if not found then
    raise exception 'topic % has no admin settings', new.topic_id;
  end if;
  if new.pass_marks is not null and new.pass_marks not between t.pass_marks_min and t.pass_marks_max then
    raise exception 'pass mark % is outside the allowed % to %', new.pass_marks, t.pass_marks_min, t.pass_marks_max;
  end if;
  if new.wrong_penalty is not null and new.wrong_penalty not between t.wrong_penalty_min and t.wrong_penalty_max then
    raise exception 'wrong-answer penalty % is outside the allowed % to %', new.wrong_penalty, t.wrong_penalty_min, t.wrong_penalty_max;
  end if;
  return new;
end;
$$;
create trigger profile_topic_settings_check before insert or update on public.profile_topic_settings
  for each row execute function public.check_profile_topic_settings();
create trigger profile_topic_settings_touch before update on public.profile_topic_settings
  for each row execute function public.touch_updated_at();

-- The settings a child's quiz uses: the parent's value if set, else the admin
-- default, always kept inside the admin's current limits.
create function public.effective_topic_settings(p_profile uuid, p_topic text)
returns table (pass_marks int, wrong_penalty int)
language sql stable set search_path = '' as $$
  select
    greatest(t.pass_marks_min, least(t.pass_marks_max, coalesce(o.pass_marks, t.pass_marks))),
    greatest(t.wrong_penalty_min, least(t.wrong_penalty_max, coalesce(o.wrong_penalty, t.wrong_penalty)))
  from public.topic_settings t
  left join public.profile_topic_settings o on o.topic_id = t.topic_id and o.profile_id = p_profile
  where t.topic_id = p_topic;
$$;

-- Progress -------------------------------------------------------------------

create table public.topic_progress (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  topic_id text not null references public.topics (id),
  state public.topic_state not null,
  attempts int not null default 0 check (attempts >= 0),
  best_marks int not null default 0 check (best_marks >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, topic_id)
);
create trigger topic_progress_touch before update on public.topic_progress
  for each row execute function public.touch_updated_at();

create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  topic_id text not null references public.topics (id),
  attempt_no int not null check (attempt_no > 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  marks int check (marks >= 0),
  pass_marks int,
  max_marks int,
  correct int check (correct >= 0),
  cleared boolean,
  stars smallint check (stars between 0 and 3),
  unique (profile_id, topic_id, attempt_no)
);

create function public.owns_attempt(p_attempt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.quiz_attempts a
    join public.profiles p on p.id = a.profile_id
    where a.id = p_attempt and p.parent_id = auth.uid()
  );
$$;

-- One row per question in a quiz. A question appears at most once per quiz.
create table public.quiz_responses (
  attempt_id uuid not null references public.quiz_attempts (id) on delete cascade,
  seq smallint not null check (seq > 0),
  question_id text not null references public.questions (id),
  level smallint not null check (level between 1 and 4),
  first_try_correct boolean not null,
  retry_correct boolean,
  marks_delta int not null,
  answered_at timestamptz not null default now(),
  primary key (attempt_id, seq),
  unique (attempt_id, question_id)
);

-- Keeps a question's live stats (for the level-band check) up to date, and
-- refuses a response whose question is from another topic.
create function public.record_response() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select topic_id from public.questions where id = new.question_id)
     <> (select topic_id from public.quiz_attempts where id = new.attempt_id) then
    raise exception 'question % is not in this quiz''s topic', new.question_id;
  end if;
  update public.questions
     set times_shown = times_shown + 1,
         first_try_correct = first_try_correct + (case when new.first_try_correct then 1 else 0 end)
   where id = new.question_id;
  return new;
end;
$$;
create trigger quiz_responses_record after insert on public.quiz_responses
  for each row execute function public.record_response();

-- Questions this child saw in their last few plays of a topic (3 by default),
-- so the next quiz can avoid them.
create function public.recent_question_ids(p_profile uuid, p_topic text, p_plays int default 3)
returns setof text
language sql stable set search_path = '' as $$
  select distinct r.question_id
  from public.quiz_responses r
  join (
    select a.id from public.quiz_attempts a
    where a.profile_id = p_profile and a.topic_id = p_topic
    order by a.attempt_no desc
    limit p_plays
  ) recent on recent.id = r.attempt_id;
$$;

-- Row-level security ---------------------------------------------------------

alter table public.admins enable row level security;
alter table public.topics enable row level security;
alter table public.questions enable row level security;
alter table public.question_checks enable row level security;
alter table public.question_reviews enable row level security;
alter table public.level_bands enable row level security;
alter table public.topic_settings enable row level security;
alter table public.parents enable row level security;
alter table public.consents enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_topic_settings enable row level security;
alter table public.topic_progress enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.quiz_responses enable row level security;

-- Lets the app tell whether the signed-in user is an admin.
create policy "read own admin row" on public.admins for select to authenticated
  using (user_id = auth.uid());

create policy "read topics" on public.topics for select to authenticated using (true);
create policy "admins manage topics" on public.topics for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "read approved questions" on public.questions for select to authenticated
  using (status = 'approved' or public.is_admin());
create policy "admins add questions" on public.questions for insert to authenticated
  with check (public.is_admin());
create policy "admins change questions" on public.questions for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins remove questions" on public.questions for delete to authenticated
  using (public.is_admin());

create policy "admins manage checks" on public.question_checks for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins manage reviews" on public.question_reviews for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "read level bands" on public.level_bands for select to authenticated using (true);
create policy "admins change level bands" on public.level_bands for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "read topic settings" on public.topic_settings for select to authenticated using (true);
create policy "admins manage topic settings" on public.topic_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "own parent row" on public.parents for select to authenticated
  using (id = auth.uid());
create policy "create own parent row" on public.parents for insert to authenticated
  with check (id = auth.uid());
create policy "delete own parent row" on public.parents for delete to authenticated
  using (id = auth.uid());

create policy "own consents" on public.consents for select to authenticated
  using (parent_id = auth.uid());
create policy "give consent" on public.consents for insert to authenticated
  with check (parent_id = auth.uid());

create policy "own profiles" on public.profiles for select to authenticated
  using (parent_id = auth.uid());
-- No child data is saved before the parent has given consent.
create policy "create profile after consent" on public.profiles for insert to authenticated
  with check (parent_id = auth.uid() and public.has_consent());
create policy "edit own profiles" on public.profiles for update to authenticated
  using (parent_id = auth.uid()) with check (parent_id = auth.uid());
create policy "delete own profiles" on public.profiles for delete to authenticated
  using (parent_id = auth.uid());

create policy "own child settings" on public.profile_topic_settings for all to authenticated
  using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy "own child progress" on public.topic_progress for all to authenticated
  using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy "own child quizzes" on public.quiz_attempts for all to authenticated
  using (public.owns_profile(profile_id)) with check (public.owns_profile(profile_id));
create policy "own child answers" on public.quiz_responses for all to authenticated
  using (public.owns_attempt(attempt_id)) with check (public.owns_attempt(attempt_id));

-- Grants (row-level security above decides which rows) -----------------------

-- Supabase grants every new table to anon and authenticated by default. Start
-- from nothing and grant only what the app needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Tables added by later migrations also start private until granted.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant select on public.admins to authenticated;
grant select, insert, update, delete on
  public.topics, public.question_checks, public.question_reviews, public.topic_settings
  to authenticated;
grant select, insert, delete on public.questions to authenticated;
-- Live stats (times_shown, first_try_correct) are left out: only the response
-- trigger changes them.
grant update (
  topic_id, sub_skill, level, format, prompt, visual, options, answers, hint, explanation,
  reason, source, source_ref, generator_version, working, variant_group, status
) on public.questions to authenticated;
grant select, update on public.level_bands to authenticated;
grant select, insert, delete on public.parents to authenticated;
grant select, insert on public.consents to authenticated;
grant select, insert, update, delete on
  public.profiles, public.profile_topic_settings, public.topic_progress,
  public.quiz_attempts, public.quiz_responses
  to authenticated;
grant usage on all sequences in schema public to authenticated;
