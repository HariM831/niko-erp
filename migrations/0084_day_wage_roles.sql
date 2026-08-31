-- The role actually worked that day.
--
-- Wage workers change jobs day to day: egg picking today, vaccination helper
-- tomorrow. The role lived once on the worker, so every day of a month priced
-- at whatever the role happened to be at month end. Now the day carries its
-- own role; null keeps meaning "the worker's usual role", which leaves all
-- history and every salaried employee exactly as they were.
ALTER TABLE attendance_days ADD COLUMN wage_role_id uuid REFERENCES wage_roles(id);
