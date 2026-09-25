-- A feed material dosed at a set amount — a premix, an enzyme, a pigment —
-- which the formulator holds locked at its recipe amount. A premix's
-- nutrient profile is matrix values that hold only at its dose; left free,
-- a solve spent it as a cheap source of energy and lysine.
ALTER TABLE "items" ADD COLUMN "fixed_dose" boolean DEFAULT false NOT NULL;
