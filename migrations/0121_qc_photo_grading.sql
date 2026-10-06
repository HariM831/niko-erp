-- A maize sample graded from a photo at the QC bench: the counts the model
-- made, the percentages worked out from them, the model, the cost, and the
-- attachment holding the photo. Null on every line nobody photographed.
ALTER TABLE "office_receipt_lines" ADD COLUMN IF NOT EXISTS "qc_photo_grading" jsonb;
