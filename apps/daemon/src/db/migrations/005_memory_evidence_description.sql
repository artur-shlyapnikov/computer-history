-- M5 fix-forward (spec §3.16 candidate shape): the LLM's evidenceDescription
-- is part of every extracted candidate but was dropped before persistence.
-- Additive column on the evidence ledger so observations keep the quoted
-- observation alongside confidence/episode. Historical rows default ''.
ALTER TABLE memory_evidence ADD COLUMN evidence_description TEXT NOT NULL DEFAULT '';
