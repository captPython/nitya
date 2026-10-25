-- Nitya: reading aloud for each child, and withdrawing consent.
--
-- Voice: true reads lessons, questions and hints aloud, with a sound for right
-- and wrong; null means on for the playful look and off for the clean one. It
-- is kept with the child, like the look, so it holds on every device.

alter table public.profiles
  add column voice boolean;

-- A parent withdraws consent by deleting their account. Deleting their sign-in
-- deletes the parent row and, through "on delete cascade", every consent,
-- profile, play, answer and setting of theirs. The admin's log of New
-- questions requests keeps its counts, with the family's ids set to null.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
