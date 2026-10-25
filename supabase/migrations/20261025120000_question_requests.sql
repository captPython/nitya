-- Nitya: a log of New questions requests.
--
-- Each press of New questions (by an admin, a parent, or a child on their
-- parent's account) is logged with what it added, so the admin can see where
-- new questions came from and later limit how often it can be pressed.
-- Only the server writes this table; it runs the generator and the checks.

create table public.question_requests (
  id bigint generated always as identity primary key,
  topic_id text not null references public.topics (id),
  requested_by uuid references auth.users (id) on delete set null,
  -- The child who pressed it, if one did. Kept as null once the profile is deleted.
  profile_id uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  -- Approved questions it added, and questions it sent to the admin's review queue.
  added int not null default 0 check (added >= 0),
  sent_to_review int not null default 0 check (sent_to_review >= 0)
);
create index question_requests_by_topic on public.question_requests (topic_id, requested_at desc);
create index question_requests_by_user on public.question_requests (requested_by, requested_at desc);

alter table public.question_requests enable row level security;

-- A family sees its own requests; the admin sees them all.
create policy "read own requests" on public.question_requests for select to authenticated
  using (requested_by = auth.uid() or public.is_admin());

grant select on public.question_requests to authenticated;
