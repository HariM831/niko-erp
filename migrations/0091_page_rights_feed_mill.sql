-- Goods Receipts and Formulas move out from under their module's read floor,
-- so each becomes grantable on its own.
--
-- Every role that could see those pages a moment ago must still see them. The
-- floor is what granted them until now, so anyone holding it inherits the new
-- right; without this a deploy would quietly take two screens away from every
-- role in the system.
--
-- Roles holding the module wildcard need nothing: "*" already expands to
-- whatever the module lists, including actions added after the role was
-- written. The admin map {"*":["*"]} is untouched for the same reason.

UPDATE roles
SET permissions = jsonb_set(
      permissions,
      '{office}',
      (permissions -> 'office') || '"receipts"'::jsonb
    )
WHERE permissions ? 'office'
  AND jsonb_typeof(permissions -> 'office') = 'array'
  AND permissions -> 'office' @> '"view"'::jsonb
  AND NOT permissions -> 'office' @> '"receipts"'::jsonb;

UPDATE roles
SET permissions = jsonb_set(
      permissions,
      '{feed_mill}',
      (permissions -> 'feed_mill') || '"formulas"'::jsonb
    )
WHERE permissions ? 'feed_mill'
  AND jsonb_typeof(permissions -> 'feed_mill') = 'array'
  AND permissions -> 'feed_mill' @> '"view"'::jsonb
  AND NOT permissions -> 'feed_mill' @> '"formulas"'::jsonb;
