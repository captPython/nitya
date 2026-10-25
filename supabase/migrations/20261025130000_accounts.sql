-- Nitya: what sign-in, profiles and onboarding need on top of the first schema.

-- The parent PIN guards switching profiles, editing them and opening settings
-- on a shared device. Only a salted PBKDF2 hash is kept, made in the app.
alter table public.parents
  add column pin_hash text check (pin_hash is null or pin_hash ~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$');

create policy "set own PIN" on public.parents for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
grant update (pin_hash) on public.parents to authenticated;

-- Onboarding offers a fixed set of choices, so a profile holds nothing else.
-- New choices need a migration, which keeps the stored data to what the app asks.
alter table public.profiles
  add constraint profiles_avatar_choice check (avatar in ('owl', 'tiger', 'elephant', 'peacock', 'rabbit', 'turtle', 'lion', 'panda')),
  add constraint profiles_board_choice check (board in ('CBSE', 'ICSE', 'State', 'Other')),
  add constraint profiles_language_choice check (language in ('en', 'hi')),
  add constraint profiles_nickname_trimmed check (nickname = btrim(nickname) and char_length(nickname) <= 20);

-- A practice round on one skill is saved as a play too, so its questions
-- count as seen and its answers show in the skills a child is working on.
-- It never changes topic progress.
alter table public.quiz_attempts
  add column practice boolean not null default false;
