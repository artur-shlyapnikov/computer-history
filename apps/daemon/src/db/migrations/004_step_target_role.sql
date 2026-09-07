-- M7 (contracts §M6→M7 inherit decisions): semantic_steps gains the UI control
-- role so workflow fingerprints are role-bearing per spec §3.20. Additive and
-- NULLable: historical steps keep NULL, and a NULL role simply omits the role
-- segment from the fingerprint instead of blocking mining.
ALTER TABLE semantic_steps ADD COLUMN target_role TEXT;
