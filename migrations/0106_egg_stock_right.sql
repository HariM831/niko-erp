-- The Egg stock page gets its own right, farms.egg_stock, and the packing room
-- a role that holds it and nothing else.
--
-- Saving grading and closing asked for farms.create, which Farms does not list
-- — so no role could be given it, and only a wildcard role could save a count.
-- Every role that could see the page (farms.view) keeps it, and can now save.
-- A role holding the module wildcard needs nothing: "*" already covers it.

UPDATE roles
SET permissions = jsonb_set(
      permissions,
      '{farms}',
      (permissions -> 'farms') || '"egg_stock"'::jsonb
    )
WHERE permissions ? 'farms'
  AND jsonb_typeof(permissions -> 'farms') = 'array'
  AND permissions -> 'farms' @> '"view"'::jsonb
  AND NOT permissions -> 'farms' @> '"egg_stock"'::jsonb
  AND NOT permissions -> 'farms' @> '"*"'::jsonb;

INSERT INTO roles (name, description, permissions)
SELECT 'Packing Room',
       'Egg stock only: the day''s grading and the closing count by size.',
       '{"farms": ["egg_stock"]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Packing Room');
