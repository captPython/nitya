-- Nitya: "upload" is a family's own question, from the question template.
--
-- A new enum value can't be used in the transaction that adds it, so it is
-- added here, on its own, before the migration that uses it.

alter type public.question_source add value if not exists 'upload';
