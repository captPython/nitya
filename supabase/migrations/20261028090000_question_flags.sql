-- Nitya: question flags, so families and children's answers keep the
-- question bank right. The rules (cp, 2026-10-26, improved in the "Nitya
-- Question Flags" spec) are the same as src/flags/rules.ts, which the demo
-- uses; the account contract tests hold the two to the same behaviour:
--   * A family flags a question with boxes (question, options, level,
--     explanation, safety) and an optional note. The question is hidden for
--     that family at once, for a watch period. Another family's flag restarts
--     the watch; a quiet watch lets it back for the families who flagged it.
--   * Families, not flags, are counted, each weighted by its trust. Enough of
--     them within the memory window send the question to the admin.
--   * "Not right for a child", or a question or options flag on a question
--     whose marked answer Nitya's answer check disagrees with, sends it at once.
--   * In review, a question flagged as wrong or unsafe is hidden for every
--     child (but its own family's); level and explanation flags leave it live.
--   * A family that flags many questions in a short time is checked as a
--     whole (a Flagger check). Its flags hide questions only for itself and
--     don't count until the admin decides.
--   * Children's answers count as one more family ("silent flags").
-- This replaces the community Report of 20261026080100_family_questions.sql.
-- Every number is a row of flag_settings, which the admin can change.

drop function public.report_question(text, text);
drop function public.moderate_question(text, text);
drop table public.question_reports;
drop index public.questions_community_idx;
alter table public.questions drop column hidden_at;

alter table public.questions
  -- Waiting for the admin's flag review since then.
  add column flag_review_at timestamptz,
  -- Out of every child's quizzes (but its own family's) while in flag review.
  add column flag_hide_all boolean not null default false,
  -- Live results beyond times_shown and first_try_correct: first tries that
  -- were wrong (the child got the hint), and right answers after the hint.
  add column retries int not null default 0 check (retries >= 0),
  add column retry_right int not null default 0 check (retry_right between 0 and retries),
  add constraint questions_flag_hide_in_review check (not flag_hide_all or flag_review_at is not null);
create index questions_community_idx on public.questions (topic_id, level) where shared and status = 'approved';
create index questions_flag_review_idx on public.questions (flag_review_at) where flag_review_at is not null;

-- The choice a child picked first, counted into the question's live results.
alter table public.quiz_responses
  add column first_answer text check (char_length(first_answer) <= 200);

create table public.question_choice_picks (
  question_id text not null references public.questions (id) on delete cascade,
  choice text not null,
  picks int not null default 0 check (picks >= 0),
  primary key (question_id, choice)
);

alter table public.question_checks drop constraint question_checks_reason_check;
alter table public.question_checks
  add constraint question_checks_reason_check check (reason in ('release', 'outside-band', 'flag'));

-- The numbers ---------------------------------------------------------------

create table public.flag_settings (
  id boolean primary key default true check (id),
  watch_days int not null default 7 check (watch_days between 1 and 30),
  review_families int not null default 3 check (review_families between 2 and 10),
  community_families int not null default 2 check (community_families between 1 and 10),
  memory_days int not null default 90 check (memory_days between 30 and 365),
  burst_flags int not null default 10 check (burst_flags between 5 and 50),
  burst_days int not null default 7 check (burst_days between 1 and 30),
  daily_cap int not null default 20 check (daily_cap between 5 and 100),
  mute_below numeric(4, 3) not null default 0.25 check (mute_below between 0 and 1),
  mute_after int not null default 5 check (mute_after between 1 and 50),
  mute_days int not null default 30 check (mute_days between 7 and 365),
  wrong_choice_share numeric(4, 3) not null default 0.4 check (wrong_choice_share between 0.2 and 0.8),
  min_answers int not null default 30 check (min_answers between 10 and 500),
  updated_at timestamptz not null default now()
);
insert into public.flag_settings default values;

-- Flags -----------------------------------------------------------------------

create table public.question_flags (
  id bigint generated always as identity primary key,
  question_id text not null references public.questions (id) on delete cascade,
  -- "system": a silent flag from children's answers.
  kind text not null check (kind in ('family', 'system')),
  -- Null for a silent flag. Set to null when the family deletes its account;
  -- the flag still counts, as a family of its own.
  parent_id uuid references public.parents (id) on delete set null,
  profile_id uuid references public.profiles (id) on delete set null,
  boxes text[] not null check (
    cardinality(boxes) > 0 and boxes <@ array['question', 'options', 'level', 'explanation', 'safety']
  ),
  level_direction text check (level_direction in ('easy', 'hard')),
  note text check (char_length(note) between 1 and 300),
  -- How many families this flag counts as: the family's trust when it flagged.
  weight numeric(4, 3) not null default 1 check (weight between 0 and 2),
  answered_wrong boolean,
  seconds_after_answer int check (seconds_after_answer >= 0),
  -- The latest flag; the same family flagging again moves it.
  flagged_at timestamptz not null default now(),
  -- The family doesn't get the question until then.
  hide_until timestamptz,
  -- Waiting on a Flagger check: hidden for this family, and not counted.
  burst boolean not null default false,
  resolved_at timestamptz,
  outcome text check (outcome in ('upheld', 'dismissed')),
  check ((resolved_at is null) = (outcome is null)),
  check (kind = 'family' or (parent_id is null and profile_id is null and not burst)),
  check ('level' = any(boxes) or level_direction is null)
);
-- One open flag per family per question, and one open silent flag per box.
create unique index question_flags_family_open on public.question_flags (question_id, parent_id)
  where resolved_at is null and kind = 'family' and parent_id is not null;
create unique index question_flags_system_open on public.question_flags (question_id, (boxes[1]))
  where resolved_at is null and kind = 'system';
create index question_flags_open_idx on public.question_flags (question_id) where resolved_at is null;
create index question_flags_parent_idx on public.question_flags (parent_id, flagged_at) where parent_id is not null;

-- A family's flagging record: its trust goes up with upheld flags and helpful
-- Flagger checks, and down with dismissed flags.
create table public.family_trust (
  parent_id uuid primary key references public.parents (id) on delete cascade,
  upheld int not null default 0 check (upheld >= 0),
  helpful int not null default 0 check (helpful >= 0),
  dismissed int not null default 0 check (dismissed >= 0),
  -- A Flagger check found not helpful: the family's flags don't count until then.
  muted_until timestamptz
);

-- A young child's "Something's wrong?" tap, waiting for a parent.
create table public.flag_suggestions (
  parent_id uuid not null references public.parents (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  question_id text not null references public.questions (id) on delete cascade,
  answered_wrong boolean,
  suggested_at timestamptz not null default now(),
  primary key (profile_id, question_id)
);
create index flag_suggestions_parent_idx on public.flag_suggestions (parent_id);

-- Each time an admin looked up a flagging family's email, and why.
create table public.flagger_reveals (
  id bigint generated always as identity primary key,
  parent_id uuid references public.parents (id) on delete set null,
  reason text not null check (char_length(reason) between 10 and 300),
  revealed_by uuid references auth.users (id) on delete set null,
  revealed_at timestamptz not null default now()
);

-- Row-level security ------------------------------------------------------------
-- Families and admins only read here; every change goes through the functions below.

grant select on public.question_choice_picks, public.question_flags, public.family_trust, public.flagger_reveals to authenticated;
grant select, delete on public.flag_suggestions to authenticated;
grant select on public.flag_settings to authenticated;
grant update (watch_days, review_families, community_families, memory_days, burst_flags, burst_days, daily_cap,
  mute_below, mute_after, mute_days, wrong_choice_share, min_answers, updated_at) on public.flag_settings to authenticated;

alter table public.question_choice_picks enable row level security;
alter table public.flag_settings enable row level security;
alter table public.question_flags enable row level security;
alter table public.family_trust enable row level security;
alter table public.flag_suggestions enable row level security;
alter table public.flagger_reveals enable row level security;

create policy "admins read picks" on public.question_choice_picks for select to authenticated using (public.is_admin());
create policy "admins read flag settings" on public.flag_settings for select to authenticated using (public.is_admin());
create policy "admins change flag settings" on public.flag_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "own flags" on public.question_flags for select to authenticated
  using (parent_id = auth.uid() or public.is_admin());
create policy "own trust" on public.family_trust for select to authenticated
  using (parent_id = auth.uid() or public.is_admin());
create policy "own suggestions" on public.flag_suggestions for select to authenticated using (parent_id = auth.uid());
create policy "dismiss own suggestions" on public.flag_suggestions for delete to authenticated using (parent_id = auth.uid());
create policy "admins read reveals" on public.flagger_reveals for select to authenticated using (public.is_admin());

-- A question in flag review that may teach something wrong is out of every
-- child's quizzes, but its own family's.
drop policy "read questions" on public.questions;
create policy "read questions" on public.questions for select to authenticated
  using (
    (source <> 'upload' and ((status = 'approved' and not flag_hide_all) or public.is_admin()))
    or owner = auth.uid()
    or (shared and (not flag_hide_all or public.is_admin()))
  );

-- The rules -------------------------------------------------------------------

create function public.trust_of(p_upheld int, p_helpful int, p_dismissed int) returns numeric
language sql immutable set search_path = '' as $$
  select round(least(2, greatest(0, 1 + 0.1 * (p_upheld + p_helpful) - 0.25 * p_dismissed)), 3);
$$;

-- How many families one flag of this family counts as: its trust, or 0 while it is muted.
create function public.flag_weight(p_parent_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case
    when t.muted_until > now() then 0
    when public.trust_of(coalesce(t.upheld, 0), coalesce(t.helpful, 0), coalesce(t.dismissed, 0)) < s.mute_below
     and coalesce(t.upheld, 0) + coalesce(t.dismissed, 0) >= s.mute_after then 0
    else public.trust_of(coalesce(t.upheld, 0), coalesce(t.helpful, 0), coalesce(t.dismissed, 0))
  end
  from public.flag_settings s left join public.family_trust t on t.parent_id = p_parent_id;
$$;

-- Whether the question is one children get: Nitya's own and approved, or shared.
create function public.question_served(q public.questions) returns boolean
language sql immutable set search_path = '' as $$
  select q.status = 'approved' and (q.source <> 'upload' or q.shared);
$$;

-- Whether Nitya's answer check, on its latest run, says the marked answer is wrong.
create function public.answer_check_disagrees(p_question_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not coalesce((c.report -> 'answer' ->> 'unchecked')::boolean, false)
       and not (c.report -> 'answer' ->> 'passed')::boolean
       and jsonb_array_length(coalesce(c.report -> 'answer' -> 'wrongKeys', '[]'::jsonb)) > 0
      from public.question_checks c where c.question_id = p_question_id
     order by c.checked_at desc, c.id desc limit 1
  ), false);
$$;

-- Sends the question to review when the rules say so, and decides whether it
-- is hidden for everyone meanwhile.
create function public.flag_evaluate(p_question_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.flag_settings;
  q public.questions;
  families numeric;
  safety boolean;
  wrong boolean;
  harmful boolean;
  urgent boolean;
begin
  select * into s from public.flag_settings;
  select * into q from public.questions where id = p_question_id for update;
  with counted as (
    select * from public.question_flags f
     where f.question_id = p_question_id and f.resolved_at is null and not f.burst
       and f.flagged_at > now() - make_interval(days => s.memory_days)
  ), live as (
    select * from counted where kind = 'system' or weight > 0
  )
  select
    coalesce((select sum(w) from (
      select max(case when kind = 'system' then 1 else weight end) w from counted
       group by case when kind = 'system' then 'system' else coalesce(parent_id::text, 'gone-' || id) end
    ) x), 0),
    exists (select 1 from live where 'safety' = any(boxes)),
    exists (select 1 from live where boxes && array['question', 'options']),
    exists (select 1 from live where boxes && array['question', 'options', 'safety'])
  into families, safety, wrong, harmful;
  urgent := safety or (wrong and public.answer_check_disagrees(p_question_id));
  if q.flag_review_at is null and not urgent
     and families < (case when q.shared then s.community_families else s.review_families end) then
    return;
  end if;
  update public.questions
     set flag_review_at = coalesce(flag_review_at, now()), flag_hide_all = urgent or harmful
   where id = p_question_id;
end;
$$;

-- The flags of a family whose flags were decided: they no longer hide or count.
create function public.flag_resolve(p_ids bigint[], p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.question_flags set resolved_at = now(), outcome = p_outcome, burst = false
   where id = any(p_ids) and resolved_at is null;
  insert into public.family_trust as t (parent_id, upheld, dismissed)
  select parent_id, count(*) filter (where p_outcome = 'upheld'), count(*) filter (where p_outcome = 'dismissed')
    from public.question_flags
   where id = any(p_ids) and kind = 'family' and parent_id is not null
   group by parent_id
  on conflict (parent_id) do update set upheld = t.upheld + excluded.upheld, dismissed = t.dismissed + excluded.dismissed;
end;
$$;

-- A silent flag from children's answers, once per box while it is open.
create function public.flag_system(p_question_id text, p_box text, p_direction text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.question_flags
              where question_id = p_question_id and kind = 'system' and resolved_at is null and boxes[1] = p_box) then
    return;
  end if;
  insert into public.question_flags (question_id, kind, boxes, level_direction, note)
  values (p_question_id, 'system', array[p_box], p_direction, p_note);
  perform public.flag_evaluate(p_question_id);
end;
$$;

-- What a question's live results say is wrong with it (silentSignals in src/flags/rules.ts).
create function public.flag_live_results(p_question_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.questions;
  s public.flag_settings;
  rate numeric;
  looks smallint;
  top record;
begin
  select * into q from public.questions where id = p_question_id;
  if not found or not public.question_served(q) then
    return;
  end if;
  select * into s from public.flag_settings;
  if q.times_shown >= s.min_answers then
    rate := q.first_try_correct::numeric / q.times_shown;
    if not exists (
      select 1 from public.level_bands b
       where b.level = q.level and rate >= b.min_rate and (rate < b.max_rate or (b.max_rate = 1 and rate = 1))
    ) then
      select coalesce((
        select b.level from public.level_bands b
         where rate >= b.min_rate and (rate < b.max_rate or (b.max_rate = 1 and rate = 1)) order by b.level limit 1
      ), q.level) into looks;
      perform public.flag_system(p_question_id, 'level', case when looks < q.level then 'easy' else 'hard' end,
        round(rate * 100)::int || '% of children got it right first time, which fits level ' || looks || '.');
    end if;
    select choice, picks into top from public.question_choice_picks
     where question_id = p_question_id and not (choice = any(q.answers))
     order by picks desc, choice limit 1;
    if found and top.picks::numeric / q.times_shown >= s.wrong_choice_share then
      perform public.flag_system(p_question_id, 'options', null,
        round(top.picks * 100.0 / q.times_shown)::int || '% of children picked ' || top.choice || ' first.');
    end if;
  end if;
  -- MIN_RETRIES and HINT_SHARE in src/flags/rules.ts.
  if q.retries >= 10 and q.retry_right::numeric / q.retries < 0.25 then
    perform public.flag_system(p_question_id, 'explanation', null,
      'Only ' || round(q.retry_right * 100.0 / q.retries)::int || '% of children got it right after the hint.');
  end if;
end;
$$;

-- Each answer adds to the question's live results, which may add a silent flag.
create or replace function public.record_response() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select topic_id from public.questions where id = new.question_id)
     <> (select topic_id from public.quiz_attempts where id = new.attempt_id) then
    raise exception 'question % is not in this quiz''s topic', new.question_id;
  end if;
  update public.questions
     set times_shown = times_shown + 1,
         first_try_correct = first_try_correct + (case when new.first_try_correct then 1 else 0 end),
         retries = retries + (case when new.first_try_correct then 0 else 1 end),
         retry_right = retry_right + (case when not new.first_try_correct and new.retry_correct then 1 else 0 end)
   where id = new.question_id;
  if new.first_answer is not null then
    insert into public.question_choice_picks as p (question_id, choice, picks) values (new.question_id, new.first_answer, 1)
    on conflict (question_id, choice) do update set picks = p.picks + 1;
  end if;
  perform public.flag_live_results(new.question_id);
  return new;
end;
$$;

revoke all on function
  public.flag_weight(uuid), public.answer_check_disagrees(text), public.flag_evaluate(text),
  public.flag_resolve(bigint[], text), public.flag_system(text, text, text, text), public.flag_live_results(text)
  from public, anon, authenticated;

-- A family's side -------------------------------------------------------------

-- A family's flag. Returns 'watching', 'review', or 'own-review' for a
-- question of the family's own, which goes to its own Review instead.
create function public.flag_question(
  p_question_id text,
  p_boxes text[],
  p_level_direction text default null,
  p_note text default null,
  p_profile_id uuid default null,
  p_answered_wrong boolean default null,
  p_seconds_after_answer int default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.flag_settings;
  q public.questions;
  clean_boxes text[];
  direction text;
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
  w numeric;
  hide timestamptz;
  row_id bigint;
  is_burst boolean;
begin
  if me is null or not exists (select 1 from public.parents where id = me) then
    raise exception 'Sign in first.';
  end if;
  clean_boxes := array(
    select b from unnest(array['question', 'options', 'level', 'explanation', 'safety']) with ordinality as x(b, n)
     where b = any(coalesce(p_boxes, '{}')) order by n
  );
  if cardinality(clean_boxes) = 0 then
    raise exception 'Tick at least one box.';
  end if;
  direction := case when 'level' = any(clean_boxes) then p_level_direction end;
  if 'level' = any(clean_boxes) and direction is distinct from 'easy' and direction is distinct from 'hard' then
    raise exception 'Say whether it is too easy or too hard.';
  end if;
  if char_length(clean_note) > 300 then
    raise exception 'Keep the note to 300 characters.';
  end if;
  if p_profile_id is not null and not exists (select 1 from public.profiles where id = p_profile_id and parent_id = me) then
    raise exception 'That profile isn''t in this account.';
  end if;

  select * into q from public.questions where id = p_question_id;
  if found and q.owner = me then
    -- The family's own question: to its own Review, where it can be fixed.
    update public.questions set status = 'in_review', shared = false,
      problems = array_append(
        array(select x from unnest(problems) x where x not like 'You flagged it:%'),
        'You flagged it: ' || (
          select string_agg(case b when 'question' then 'Wrong question' when 'options' then 'Wrong options'
            when 'level' then 'Wrong level' when 'explanation' then 'Wrong explanation' else 'Not right for a child' end, ', ' order by n)
            from unnest(clean_boxes) with ordinality as x(b, n)
        ) || coalesce(' ("' || clean_note || '")', '') || '.')
     where id = p_question_id;
    return 'own-review';
  end if;
  if not found or not public.question_served(q) then
    raise exception 'That question isn''t in Nitya''s quizzes.';
  end if;

  select * into s from public.flag_settings;
  if (select count(*) from public.question_flags
       where kind = 'family' and parent_id = me and flagged_at > now() - interval '1 day') >= s.daily_cap then
    raise exception 'You can send up to % flags a day. Please try again tomorrow.', s.daily_cap;
  end if;
  -- One flag per family for each version of a question.
  if exists (
    select 1 from public.question_flags d
     where d.parent_id = me and d.question_id = p_question_id and d.outcome = 'dismissed'
       and not exists (select 1 from public.question_flags u
                        where u.question_id = p_question_id and u.outcome = 'upheld' and u.resolved_at > d.resolved_at)
  ) then
    raise exception 'You flagged this question before, and Nitya''s team kept it as it is.';
  end if;

  w := public.flag_weight(me);
  hide := now() + make_interval(days => s.watch_days);
  select id into row_id from public.question_flags
   where question_id = p_question_id and parent_id = me and kind = 'family' and resolved_at is null for update;
  if found then
    -- The same family again: hidden for them again, but still one family.
    update public.question_flags f set
      boxes = array(select b from unnest(array['question', 'options', 'level', 'explanation', 'safety']) with ordinality as x(b, n)
                     where b = any(f.boxes || clean_boxes) order by n),
      level_direction = coalesce(direction, f.level_direction), note = coalesce(clean_note, f.note),
      profile_id = p_profile_id, answered_wrong = p_answered_wrong, seconds_after_answer = p_seconds_after_answer,
      weight = w, flagged_at = now(), hide_until = hide
     where id = row_id;
  else
    insert into public.question_flags (question_id, kind, parent_id, profile_id, boxes, level_direction, note, weight,
                                       answered_wrong, seconds_after_answer, hide_until, burst)
    values (p_question_id, 'family', me, p_profile_id, clean_boxes, direction, clean_note, w, p_answered_wrong, p_seconds_after_answer, hide,
            exists (select 1 from public.question_flags where parent_id = me and kind = 'family' and resolved_at is null and burst))
    returning id into row_id;
  end if;
  -- A child's tap on this question is answered by this flag.
  delete from public.flag_suggestions where parent_id = me and question_id = p_question_id;
  -- Another flag restarts the watch for every family still waiting on it.
  update public.question_flags set hide_until = hide
   where question_id = p_question_id and kind = 'family' and resolved_at is null and hide_until > now();
  -- Many questions in a short time: the family's open flags become one Flagger check.
  if w > 0 and (select count(distinct question_id) from public.question_flags
                 where parent_id = me and kind = 'family' and flagged_at > now() - make_interval(days => s.burst_days)) >= s.burst_flags then
    update public.question_flags set burst = true where parent_id = me and kind = 'family' and resolved_at is null;
  end if;
  select burst into is_burst from public.question_flags where id = row_id;
  if not is_burst then
    perform public.flag_evaluate(p_question_id);
  end if;
  return case when (select flag_review_at from public.questions where id = p_question_id) is null then 'watching' else 'review' end;
end;
$$;

-- A young child's "Something's wrong?": hidden for that child until a parent checks it.
create function public.suggest_flag(p_profile_id uuid, p_question_id text, p_answered_wrong boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.questions;
begin
  if not exists (select 1 from public.profiles where id = p_profile_id and parent_id = auth.uid()) then
    raise exception 'That profile isn''t in this account.';
  end if;
  select * into q from public.questions where id = p_question_id;
  if not found or not (q.owner = auth.uid() or public.question_served(q)) then
    raise exception 'That question isn''t in Nitya''s quizzes.';
  end if;
  insert into public.flag_suggestions (parent_id, profile_id, question_id, answered_wrong)
  values (auth.uid(), p_profile_id, p_question_id, p_answered_wrong)
  on conflict do nothing;
end;
$$;

-- Questions the family's children don't get now; with a child, also those
-- that child tapped "Something's wrong?" on.
create function public.my_hidden_questions(p_profile_id uuid default null) returns setof text
language sql stable security definer set search_path = '' as $$
  select f.question_id from public.question_flags f join public.questions q on q.id = f.question_id
   where f.parent_id = auth.uid() and f.kind = 'family' and f.resolved_at is null
     and (f.burst or q.flag_review_at is not null or f.hide_until > now())
  union
  select question_id from public.flag_suggestions
   where parent_id = auth.uid() and (p_profile_id is null or profile_id = p_profile_id);
$$;

-- The family's flags, newest first, with those decided in the last 30 days,
-- each with its question whatever the question's state.
create function public.my_flags() returns table (question jsonb, boxes text[], flagged_at timestamptz, state text, until timestamptz)
language sql stable security definer set search_path = '' as $$
  select to_jsonb(q), f.boxes, f.flagged_at, x.state,
         case when x.state = 'watching' and not f.burst then f.hide_until end
    from public.question_flags f
    join public.questions q on q.id = f.question_id
    cross join lateral (select coalesce(f.outcome, case
      when q.flag_review_at is not null then 'review'
      when f.hide_until > now() or f.burst then 'watching'
      else 'back' end) as state) x
   where f.parent_id = auth.uid() and f.kind = 'family'
     and (f.resolved_at is null or f.resolved_at > now() - interval '30 days')
   order by f.flagged_at desc;
$$;

revoke all on function
  public.flag_question(text, text[], text, text, uuid, boolean, int), public.suggest_flag(uuid, text, boolean),
  public.my_hidden_questions(uuid), public.my_flags()
  from public, anon;
grant execute on function
  public.flag_question(text, text[], text, text, uuid, boolean, int), public.suggest_flag(uuid, text, boolean),
  public.my_hidden_questions(uuid), public.my_flags()
  to authenticated;

-- The admin's side --------------------------------------------------------------

-- The admin's decision on a flagged question: keep (the flags are dismissed),
-- or level, fix or remove (upheld). A community question is only kept or taken
-- out of the community bank; its family keeps it.
create function public.decide_flags(
  p_question_id text,
  p_decision text,
  p_level smallint default null,
  p_fixed jsonb default null,
  p_report jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  q public.questions;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  select * into q from public.questions where id = p_question_id for update;
  if not found or q.flag_review_at is null or not public.question_served(q) then
    raise exception 'That question isn''t waiting for review.';
  end if;
  if q.shared and p_decision in ('level', 'fix') then
    raise exception 'A family''s question can only be kept or taken out of the community bank.';
  end if;

  if p_decision = 'level' then
    if p_level is null or p_level not between 1 and 4 then
      raise exception 'Pick a level from 1 to 4.';
    end if;
    update public.questions set level = p_level, times_shown = 0, first_try_correct = 0, retry_right = 0, retries = 0
     where id = p_question_id;
    delete from public.question_choice_picks where question_id = p_question_id;
  elsif p_decision = 'fix' then
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
      times_shown = 0, first_try_correct = 0, retry_right = 0, retries = 0
    where id = p_question_id;
    delete from public.question_choice_picks where question_id = p_question_id;
    insert into public.question_checks (question_id, reason, passed, report)
    values (p_question_id, 'flag', coalesce((p_report ->> 'passed')::boolean, false), p_report);
  elsif p_decision = 'remove' then
    if q.shared then
      update public.questions set shared = false where id = p_question_id;
    else
      update public.questions set status = 'rejected' where id = p_question_id;
    end if;
  elsif p_decision <> 'keep' then
    raise exception 'The decision must be keep, level, fix or remove.';
  end if;

  perform public.flag_resolve(
    array(select id from public.question_flags where question_id = p_question_id and resolved_at is null),
    case when p_decision = 'keep' then 'dismissed' else 'upheld' end);
  update public.questions set flag_review_at = null, flag_hide_all = false where id = p_question_id;
end;
$$;

-- The admin's call on a Flagger check: not helpful dismisses every flag and
-- mutes the family; helpful (which raises its trust) and "look at each" send
-- every question to review.
create function public.decide_flagger(p_parent_id uuid, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ids bigint[];
  qid text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  if p_decision not in ('helpful', 'not-helpful', 'each') then
    raise exception 'The decision must be helpful, not-helpful or each.';
  end if;
  ids := array(select id from public.question_flags
                where parent_id = p_parent_id and kind = 'family' and resolved_at is null and burst);
  if cardinality(ids) = 0 then
    raise exception 'That family has no Flagger check waiting.';
  end if;
  if p_decision = 'not-helpful' then
    perform public.flag_resolve(ids, 'dismissed');
    insert into public.family_trust as t (parent_id, muted_until)
    values (p_parent_id, now() + make_interval(days => (select mute_days from public.flag_settings)))
    on conflict (parent_id) do update set muted_until = excluded.muted_until;
    return;
  end if;
  if p_decision = 'helpful' then
    insert into public.family_trust as t (parent_id, helpful) values (p_parent_id, 1)
    on conflict (parent_id) do update set helpful = t.helpful + 1;
  end if;
  update public.question_flags set burst = false where id = any(ids);
  for qid in select distinct question_id from public.question_flags where id = any(ids) loop
    -- Each question goes to review, whatever the count.
    update public.questions set flag_review_at = coalesce(flag_review_at, now()) where id = qid;
    perform public.flag_evaluate(qid);
  end loop;
end;
$$;

-- What the admin's Flagger check card needs that the admin can't otherwise
-- read: when each waiting family joined, and its children's classes.
create function public.flagger_cards() returns table (parent_id uuid, created_at timestamptz, classes text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  return query
    select p.id, p.created_at,
           array(select distinct c.class_id::text from public.profiles c where c.parent_id = p.id order by 1)
      from public.parents p
     where exists (select 1 from public.question_flags f
                    where f.parent_id = p.id and f.kind = 'family' and f.resolved_at is null and f.burst);
end;
$$;

-- A flagging family's email, for a reason that is recorded.
create function public.reveal_flagger(p_parent_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  why text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  if char_length(why) not between 10 and 300 then
    raise exception 'Say in a sentence why you need this family''s email.';
  end if;
  insert into public.flagger_reveals (parent_id, reason, revealed_by) values (p_parent_id, why, auth.uid());
  return (select email from auth.users where id = p_parent_id);
end;
$$;

-- Puts approved questions of Nitya's own in the review queue, each with the
-- check run that sent it (a template sibling of a fixed or removed question).
create function public.send_to_review(p_entries jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    update public.questions set status = 'in_review'
     where id = e ->> 'questionId' and status = 'approved' and source <> 'upload';
    if not found then
      raise exception 'Question % isn''t an approved question.', e ->> 'questionId';
    end if;
    insert into public.question_checks (question_id, reason, passed, report)
    values (e ->> 'questionId', 'flag', coalesce((e -> 'report' ->> 'passed')::boolean, false), e -> 'report');
  end loop;
end;
$$;

revoke all on function
  public.decide_flags(text, text, smallint, jsonb, jsonb), public.decide_flagger(uuid, text),
  public.flagger_cards(), public.reveal_flagger(uuid, text), public.send_to_review(jsonb)
  from public, anon;
grant execute on function
  public.decide_flags(text, text, smallint, jsonb, jsonb), public.decide_flagger(uuid, text),
  public.flagger_cards(), public.reveal_flagger(uuid, text), public.send_to_review(jsonb)
  to authenticated;
