-- Reference data: the UKG topics, the starting level bands and each topic's
-- default settings. test/db/schema.test.ts checks the topics against
-- src/content/ukg so the two never drift apart.

insert into public.topics (id, class_id, position, title, sub_skills) values
  ('ukg-counting-50', 'UKG', 1, 'Counting 1 to 50', '{
    "count-objects": "Counting things", "count-on": "Counting on", "count-back": "Counting back",
    "number-names": "Number words", "skip-count": "Counting in 2s, 5s and 10s"}'),
  ('ukg-before-after', 'UKG', 2, 'Before, after and between', '{
    "after": "Number after", "before": "Number before", "between": "Number between",
    "two-steps": "Steps on the number line"}'),
  ('ukg-comparing', 'UKG', 3, 'Comparing numbers', '{
    "compare-groups": "More and fewer", "compare-numbers": "Bigger and smaller",
    "biggest-smallest": "Biggest and smallest", "in-between": "Numbers in between",
    "ordering": "Putting numbers in order"}'),
  ('ukg-addition-10', 'UKG', 4, 'Adding with objects up to 10', '{
    "count-all": "Counting all", "count-on": "Counting on", "word-problem": "Story sums",
    "add-three": "Adding three numbers", "missing-addend": "Finding the missing number",
    "compare-sums": "Comparing sums", "make-ten": "Making 10", "make-a-number": "Making a number"}'),
  ('ukg-subtraction-10', 'UKG', 5, 'Taking away with objects up to 10', '{
    "take-away-objects": "Taking away objects", "count-back": "Counting back",
    "word-problem": "Story take-aways", "how-many-taken": "Finding how many went",
    "two-step": "Two take-aways", "compare-differences": "Comparing take-aways",
    "missing-start": "Finding the start number"}');

-- L1 85% or more, L2 65 to 85%, L3 50 to 65%, L4 under 50%.
insert into public.level_bands (level, min_rate, max_rate) values
  (1, 0.85, 1.00),
  (2, 0.65, 0.85),
  (3, 0.50, 0.65),
  (4, 0.00, 0.50);

-- Pass mark 44 of 68 and 1 mark off for a wrong first try. The parent limits
-- start equal to the defaults, so nothing can be changed for a child until an
-- admin widens them.
insert into public.topic_settings
  (topic_id, pass_marks, pass_marks_min, pass_marks_max, wrong_penalty, wrong_penalty_min, wrong_penalty_max)
select id, 44, 44, 44, 1, 1, 1 from public.topics;
