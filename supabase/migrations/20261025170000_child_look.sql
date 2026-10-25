-- Nitya: how the app looks for each child.
--
-- 'play' is bright and game-like, 'focus' is clean and calm. Null means the
-- class decides: playful up to Class 5, clean from Class 6 (src/looks.ts).
-- A parent can choose either for any child, and the "edit own profiles"
-- policy already limits that to their own children.

alter table public.profiles
  add column look text check (look in ('play', 'focus'));
