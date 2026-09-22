-- Formula costs move behind their own right, feed_mill.costs.
--
-- Only the Director is given it. Admin holds {"*":["*"]} and any role with the
-- feed_mill wildcard already covers actions added later, so neither needs a
-- row here. Every other role that could see a formula loses sight of its cost
-- on purpose: that is the change asked for.

UPDATE roles
SET permissions = jsonb_set(
      permissions,
      '{feed_mill}',
      (permissions -> 'feed_mill') || '"costs"'::jsonb
    )
WHERE name = 'Director'
  AND permissions ? 'feed_mill'
  AND jsonb_typeof(permissions -> 'feed_mill') = 'array'
  AND NOT permissions -> 'feed_mill' @> '"costs"'::jsonb
  AND NOT permissions -> 'feed_mill' @> '"*"'::jsonb;
