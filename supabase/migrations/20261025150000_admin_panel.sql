-- Nitya: what the admin panel needs on top of the earlier migrations.

-- Parents may make a topic harder for their child, never easier: a pass mark
-- from 44 to 60 of 68, and 1 or 2 marks off for a wrong first try (cp's
-- choice, 2026-10-25). The admin can change these per topic in the panel.
update public.topic_settings
   set pass_marks_min = 44, pass_marks_max = 60, wrong_penalty_min = 1, wrong_penalty_max = 2
 where pass_marks_min = 44 and pass_marks_max = 44 and wrong_penalty_min = 1 and wrong_penalty_max = 1;

-- An admin's decision on a question in the review queue, all at once: the
-- question's new status (and new content, for a fix, with its new check run)
-- and the review record. Only a question still waiting can be reviewed.
-- It runs as its owner so a fix can reset the live stats, which the app can't
-- write; the admin check below is what guards it.
create function public.review_question(
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
  select * into q from public.questions where id = p_question_id for update;
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

-- The level bands as three cut points (first-try success rates): L1 from
-- p_l1 up, L2 from p_l2 to p_l1, L3 from p_l3 to p_l2, L4 below p_l3. All
-- four rows change in one transaction, so the no-gaps check passes at commit.
create function public.set_level_bands(p_l1 numeric, p_l2 numeric, p_l3 numeric) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change the level bands.' using errcode = '42501';
  end if;
  if not (1 > p_l1 and p_l1 > p_l2 and p_l2 > p_l3 and p_l3 > 0) then
    raise exception 'Each level must start lower than the one before.';
  end if;
  update public.level_bands set min_rate = p_l1, max_rate = 1 where level = 1;
  update public.level_bands set min_rate = p_l2, max_rate = p_l1 where level = 2;
  update public.level_bands set min_rate = p_l3, max_rate = p_l2 where level = 3;
  update public.level_bands set min_rate = 0, max_rate = p_l3 where level = 4;
end;
$$;

revoke execute on function public.review_question(text, text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.set_level_bands(numeric, numeric, numeric) from public, anon;
grant execute on function public.review_question(text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.set_level_bands(numeric, numeric, numeric) to authenticated;
