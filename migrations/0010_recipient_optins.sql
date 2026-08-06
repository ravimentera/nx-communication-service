-- =============================================================================
-- 0010_recipient_optins.sql
--
-- The five per-channel opt-in flags, restored to `recipient_preferences`.
--
-- NEVER RUN BY TOOLING. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0010_recipient_optins.sql
--
-- Requires 0001 (recipient_preferences).
-- Must be applied BEFORE 9006_preferences.sql, which loads these columns.
--
-- -----------------------------------------------------------------------------
-- WHY: P9 DROPPED FIVE COLUMNS THAT SEAM B TURNS OUT TO NEED
--
-- Found while resolving §0.5 Seam B in P10. `9006_preferences.sql` migrates
-- eighteen columns off the source's `communication_preferences` and none of
-- these five:
--
--   email_opt_in  sms_opt_in  push_opt_in  voice_opt_in  direct_mail_opt_in
--
-- That was not visibly wrong at P9, because nothing in the engine reads them
-- and nothing in the source service does either — a grep for `email_opt_in`
-- over the whole of `services/communication-service/src/` returns zero. The
-- engine gates per-channel consent on `preferred_channels` and global consent
-- on `allow_communications`, and 9006 carries both.
--
-- Seam B is what surfaced them. patient-service LEFT JOINs the source table
-- onto every patient lookup (`patient.repository.ts:151-158`) and returns the
-- whole row to the FE as `communicationPreference`. The FE reads exactly these
-- five booleans, in six places across web and mobile — `types/patient.ts:46`,
-- `utils/patient.utils.ts:127`, `utils/approvals.utils.ts:54`,
-- `PatientOverview.tsx:61`, `demographicsProvider.ts:38`, and the mobile
-- `PatientDetailsScreen.tsx:259`. Dropping that JOIN without a replacement
-- would remove data a rendered screen consumes.
--
-- -----------------------------------------------------------------------------
-- WHAT THESE FLAGS ACTUALLY ARE, RECORDED SO NOBODY RE-DERIVES IT
--
-- They are inert, and it took four greps to be sure of it:
--
--   1. Nothing writes them. The only occurrence of `email_opt_in` anywhere in
--      mentera_core is the column declaration itself
--      (`patient-service/src/db/schema.ts:156`). No INSERT, no UPDATE.
--   2. The source communication-service never reads them.
--   3. The FE's toggles do not persist — `handleTogglePreference` sets React
--      state and there is no mutation behind it.
--   4. No send has ever been gated on them, in either system.
--
-- So every row holds the column DEFAULT and always has. The card renders five
-- toggles that are permanently on, and flipping one survives until the next
-- refresh.
--
-- They are carried across anyway, and deliberately: hard rule 3 of the plan is
-- preserve behaviour over elegance, the flags are the shape a live screen
-- reads, and inventing a mapping from `preferred_channels` would make the
-- toggles start meaning something they have never meant. Retiring dead UI is a
-- product decision, and it is not P10's to take mid-cutover.
--
-- NULLABLE WITH DEFAULT true, matching the source exactly. `.default(true)`
-- without `.notNull()` is what `patient-service/src/db/schema.ts:156-160`
-- declares, so a NULL there stays a NULL here and 9006 can carry the column
-- through untouched. ADD COLUMN ... DEFAULT fills existing engine rows with
-- true, which is the value the source would have given them.
--
-- No index. Nothing filters on these, because nothing reads them.
-- -----------------------------------------------------------------------------

BEGIN;

ALTER TABLE recipient_preferences
  ADD COLUMN IF NOT EXISTS email_opt_in       boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_opt_in         boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_opt_in        boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS voice_opt_in       boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS direct_mail_opt_in boolean DEFAULT true;

COMMENT ON COLUMN recipient_preferences.email_opt_in IS
  'Display-only, carried from the source for FE parity. Consent is enforced via allow_communications and preferred_channels — see 0010_recipient_optins.sql.';

COMMIT;

-- -----------------------------------------------------------------------------
-- VERIFY
--
--   -- must return 5
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name = 'recipient_preferences' AND column_name LIKE '%_opt_in';
--
--   -- all five nullable, all five defaulting to true
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'recipient_preferences' AND column_name LIKE '%_opt_in'
--   ORDER BY column_name;
-- -----------------------------------------------------------------------------
