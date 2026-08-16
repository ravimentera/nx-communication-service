-- =============================================================================
-- 0016 — playbooks may declare how a caller's field names map onto their contract
--
-- `aliases.json` rewrites variable names inside a template body. It cannot touch
-- the keys of the render context, so a `data_contract` whose required field is
-- named differently from the field the caller actually sends fails validation
-- with no way to reconcile the two short of editing one side.
--
-- That gap was hiding a live defect. The four medspa appointment playbooks
-- require `appointmentDate` / `oldDate` / `newDate`; `scheduling-service`, the
-- only caller that sends those events, posts `startTime` / `oldStartTime` /
-- `newStartTime`. Every appointment event would have produced a FAILED run and
-- no message at cutover.
--
-- `context_mapping` is `{ "<contract field>": ["<path>", "<path>", ...] }` —
-- the first path that resolves wins, and the contract's own field name goes
-- first so a payload that is already correct is untouched. Name-to-name only:
-- no formatting, no arithmetic, no conditionals, held to the same discipline as
-- the `where` predicate for the same reason.
--
-- NOT NULL DEFAULT '{}' so every existing row means "no mapping", which is the
-- behaviour they have today.
-- =============================================================================

BEGIN;

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS context_mapping jsonb NOT NULL DEFAULT '{}'::jsonb;

-- `priority_rules` is `[{when: <predicate>, priority: 'URGENT'}]`, evaluated
-- against the event context with the same seven operators the trigger's `where`
-- uses. It exists because `medspa.system-alert` documented a CRITICAL → URGENT
-- escalation — the source applied it at :716 — that nothing implemented, so a
-- critical system alert queued at MEDIUM behind every appointment reminder.
--
-- Empty array means "no escalation", which is what every existing row does now.
ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS priority_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
