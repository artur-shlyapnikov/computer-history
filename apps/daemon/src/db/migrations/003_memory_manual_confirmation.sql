-- M5 (spec §3.16/§3.17, contracts §memory.action semantics): a manual
-- confirm stamps the row so retention's zero-evidence cleanup and rejected
-- purge never touch it, and so auto-supersession (§3.17) defers to the
-- user's decision. NULL = no manual decision recorded.
ALTER TABLE memory_candidates ADD COLUMN manual_confirmed_at_ms INTEGER;
