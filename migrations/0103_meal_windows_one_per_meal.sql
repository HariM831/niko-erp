-- One meal window per meal, and the hours the farm actually eats in.
--
-- The table already carried a unique index on (canteen_id, meal), but the
-- windows that apply everywhere have canteen_id NULL, and Postgres counts two
-- NULLs as different — so the Amino import could add a second global window
-- for every meal beside niko's own. Which of the pair applied was then
-- whichever row the query happened to return last:
--
--     lunch 12:00-14:30  (niko)      lunch 13:00-15:00  (Amino)
--
-- With the 13:00 one winning, every lunch served before one o'clock was
-- "outside its hours" — 1,170 of 2,849 plates, because the median lunch here
-- is 12:59. The flag stopped meaning anything.
--
-- The hours below are read off 3,917 real servings and confirmed by the farm:
-- breakfast is done by 10:15, lunch runs 12:34 to 13:57, dinner 19:41 to
-- 20:15. Plates already flagged keep their flag: it records what the rule said
-- when the plate went out, and rewriting that to match a new rule would be a
-- worse lie than the wrong flag.

-- Keep one global row per meal — the oldest, so an id somebody has referred to
-- survives — and give it the agreed hours.
DELETE FROM canteen_meal_windows w
 WHERE canteen_id IS NULL
   AND EXISTS (
     SELECT 1 FROM canteen_meal_windows k
      WHERE k.canteen_id IS NULL AND k.meal = w.meal AND k.id < w.id
   );

UPDATE canteen_meal_windows SET start_time = '07:00', end_time = '10:30'
 WHERE canteen_id IS NULL AND meal = 'breakfast';
UPDATE canteen_meal_windows SET start_time = '12:00', end_time = '14:30'
 WHERE canteen_id IS NULL AND meal = 'lunch';
UPDATE canteen_meal_windows SET start_time = '19:00', end_time = '21:00'
 WHERE canteen_id IS NULL AND meal = 'dinner';

-- And the loophole itself: a second global window for a meal is now refused by
-- the database, whatever writes it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_windows_global
    ON canteen_meal_windows (meal) WHERE canteen_id IS NULL;
