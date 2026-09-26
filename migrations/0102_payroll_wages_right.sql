-- The Wages sheet moves out from under the payroll read floor.
--
-- It was granted by `payroll.view`, which every gate account has to hold to
-- see who is at the door — so a security guard could open the wage sheets. It
-- now has its own action, `payroll.wages`.
--
-- Every role that could open it a moment ago must still open it, EXCEPT the
-- gate-only ones, which is the whole point. The discriminator is whether the
-- role does payroll work at all: employees, attendance, pay inputs or the run.
-- A role holding the module wildcard needs nothing — "*" already expands to
-- whatever the module lists, including actions added later.

UPDATE roles
SET permissions = jsonb_set(
      permissions,
      '{payroll}',
      (permissions -> 'payroll') || '"wages"'::jsonb
    )
WHERE permissions ? 'payroll'
  AND jsonb_typeof(permissions -> 'payroll') = 'array'
  AND permissions -> 'payroll' @> '"view"'::jsonb
  AND NOT permissions -> 'payroll' @> '"wages"'::jsonb
  AND (permissions -> 'payroll' @> '"run"'::jsonb
       OR permissions -> 'payroll' @> '"pay_inputs"'::jsonb
       OR permissions -> 'payroll' @> '"employees"'::jsonb
       OR permissions -> 'payroll' @> '"attendance"'::jsonb);
