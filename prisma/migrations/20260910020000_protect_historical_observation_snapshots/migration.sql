-- Historical observations are snapshots. An in-place rewrite would also evade
-- the insert/delete corpus revision trigger and leave existing cursors valid.
CREATE TRIGGER "HistoricalClassificationObservation_immutable_update"
BEFORE UPDATE ON "HistoricalClassificationObservation"
FOR EACH ROW EXECUTE FUNCTION "prevent_classification_memory_mutation"();
