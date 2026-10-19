-- Ridgeline Facilities core schema.
-- Conventions:
--   * All money is stored as BIGINT cents (NZD).
--   * Percentages and multipliers are stored as INTEGER basis points (1% = 100 bps, 1.0x = 10000 bps).
--   * Financial and evidence records are append-only; corrections are made with reversing entries.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Settings & reference data
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trades (
  id                     SERIAL PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  is_specialist          BOOLEAN NOT NULL DEFAULT false,
  required_documents     TEXT[] NOT NULL DEFAULT '{}',
  default_estimate_hours NUMERIC(6,2) NOT NULL DEFAULT 1.5,
  before_photo_required  BOOLEAN NOT NULL DEFAULT true,
  is_active              BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE public_holidays (
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL,
  region       TEXT NOT NULL DEFAULT 'NZ',
  PRIMARY KEY (holiday_date, region)
);

-- Assessment assumptions per facility type (administrator-maintained, never hardcoded).
CREATE TABLE facility_types (
  id                           SERIAL PRIMARY KEY,
  code                         TEXT NOT NULL UNIQUE,
  name                         TEXT NOT NULL,
  category                     TEXT NOT NULL CHECK (category IN ('residential','commercial','body_corporate','industrial','retail','mixed','custom')),
  unit_label                   TEXT NOT NULL DEFAULT 'unit',
  jobs_per_unit_per_month      NUMERIC(8,4) NOT NULL,
  avg_contractor_cost_cents    BIGINT NOT NULL CHECK (avg_contractor_cost_cents >= 0),
  callout_share_bps            INTEGER NOT NULL DEFAULT 10000 CHECK (callout_share_bps BETWEEN 0 AND 10000),
  avg_callout_cost_cents       BIGINT NOT NULL DEFAULT 0 CHECK (avg_callout_cost_cents >= 0),
  emergency_share_bps          INTEGER NOT NULL DEFAULT 0 CHECK (emergency_share_bps BETWEEN 0 AND 10000),
  emergency_cost_multiplier_bps INTEGER NOT NULL DEFAULT 15000 CHECK (emergency_cost_multiplier_bps >= 10000),
  planned_monthly_cost_per_unit_cents BIGINT NOT NULL DEFAULT 0,
  is_custom                    BOOLEAN NOT NULL DEFAULT false,
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  updated_by                   UUID,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Coverage factor by customer category and service agreement level.
CREATE TABLE coverage_factors (
  id                SERIAL PRIMARY KEY,
  customer_category TEXT NOT NULL,
  service_level     TEXT NOT NULL,
  factor_bps        INTEGER NOT NULL CHECK (factor_bps > 0),
  description       TEXT,
  UNIQUE (customer_category, service_level)
);

-- ---------------------------------------------------------------------------
-- Customers, facilities, users
-- ---------------------------------------------------------------------------

CREATE SEQUENCE customer_ref_seq START 1001;

CREATE TABLE customers (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_ref                TEXT NOT NULL UNIQUE DEFAULT ('RFC-' || nextval('customer_ref_seq')),
  name                       TEXT NOT NULL,
  legal_name                 TEXT,
  nzbn                       TEXT,
  gst_number                 TEXT,
  billing_email              CITEXT NOT NULL,
  phone                      TEXT,
  billing_address            TEXT,
  customer_category          TEXT NOT NULL DEFAULT 'residential',
  service_level              TEXT NOT NULL DEFAULT 'standard',
  emergency_cover            TEXT NOT NULL DEFAULT 'business_hours' CHECK (emergency_cover IN ('none','business_hours','24x7')),
  status                     TEXT NOT NULL DEFAULT 'pending_assessment'
                               CHECK (status IN ('pending_assessment','pending_deposit','active','suspended','closed')),
  agreed_minimum_balance_cents BIGINT,
  custom_arrangement         BOOLEAN NOT NULL DEFAULT false,
  custom_arrangement_notes   TEXT,
  authority_limit_cents      BIGINT NOT NULL DEFAULT 100000,
  payment_terms_days         INTEGER NOT NULL DEFAULT 20,
  po_required                BOOLEAN NOT NULL DEFAULT false,
  acknowledgement_required   BOOLEAN NOT NULL DEFAULT false,
  cancellation_fees_apply    BOOLEAN NOT NULL DEFAULT true,
  auto_apply_prepaid         BOOLEAN NOT NULL DEFAULT true,
  -- Cached sub-ledger balance; authoritative history is prepaid_transactions (kept in sync inside the same DB transaction).
  prepaid_balance_cents      BIGINT NOT NULL DEFAULT 0 CHECK (prepaid_balance_cents >= 0),
  low_balance_alerted_at     TIMESTAMPTZ,
  region                     TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contractors (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name              TEXT NOT NULL,
  trading_name            TEXT,
  nzbn                    TEXT,
  business_address        TEXT,
  email                   CITEXT NOT NULL,
  phone                   TEXT,
  gst_registered          BOOLEAN NOT NULL DEFAULT false,
  gst_number              TEXT,
  bank_account_name       TEXT,
  bank_account_number     TEXT,
  payment_terms_days      INTEGER NOT NULL DEFAULT 7,
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','archived')),
  service_regions         TEXT[] NOT NULL DEFAULT '{}',
  base_lat                NUMERIC(9,6),
  base_lng                NUMERIC(9,6),
  service_radius_km       INTEGER,
  available               BOOLEAN NOT NULL DEFAULT true,
  after_hours_available   BOOLEAN NOT NULL DEFAULT false,
  emergency_available     BOOLEAN NOT NULL DEFAULT false,
  max_concurrent_jobs     INTEGER NOT NULL DEFAULT 5,
  equipment               TEXT[] NOT NULL DEFAULT '{}',
  independent_contractor_ack_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT gst_registered OR gst_number IS NOT NULL)
);

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  name             TEXT NOT NULL,
  phone            TEXT,
  role             TEXT NOT NULL CHECK (role IN ('admin','ops','finance','customer','contractor')),
  customer_id      UUID REFERENCES customers(id),
  customer_role    TEXT CHECK (customer_role IN ('owner','approver','booker','viewer')),
  approval_limit_cents BIGINT,
  contractor_id    UUID REFERENCES contractors(id),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'customer') = (customer_id IS NOT NULL)),
  CHECK ((role = 'contractor') = (contractor_id IS NOT NULL)),
  CHECK (role <> 'customer' OR customer_role IS NOT NULL)
);

CREATE TABLE sites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  name           TEXT NOT NULL,
  address        TEXT NOT NULL,
  suburb         TEXT,
  city           TEXT,
  region         TEXT NOT NULL,
  postcode       TEXT,
  lat            NUMERIC(9,6),
  lng            NUMERIC(9,6),
  access_notes   TEXT,
  hazards        TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sites_customer_idx ON sites(customer_id);

-- A facility is a building or group of like units at a site (e.g. "Block A - 20 x one-bedroom units").
CREATE TABLE facilities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES customers(id),
  site_id          UUID NOT NULL REFERENCES sites(id),
  facility_type_id INTEGER NOT NULL REFERENCES facility_types(id),
  name             TEXT NOT NULL,
  unit_count       INTEGER NOT NULL CHECK (unit_count > 0),
  notes            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX facilities_customer_idx ON facilities(customer_id);

CREATE TABLE units (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  facility_id  UUID NOT NULL REFERENCES facilities(id),
  label        TEXT NOT NULL,
  UNIQUE (facility_id, label)
);

CREATE TABLE account_assessments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id),
  inputs              JSONB NOT NULL,
  assumptions         JSONB NOT NULL,
  breakdown           JSONB NOT NULL,
  monthly_spend_cents BIGINT NOT NULL,
  coverage_factor_bps INTEGER NOT NULL,
  calculated_cents    BIGINT NOT NULL,
  recommended_cents   BIGINT NOT NULL,
  requires_custom     BOOLEAN NOT NULL,
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','superseded')),
  agreed_cents        BIGINT,
  agreed_notes        TEXT,
  created_by          UUID REFERENCES users(id),
  accepted_by         UUID REFERENCES users(id),
  accepted_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Contractor compliance and rate cards
-- ---------------------------------------------------------------------------

CREATE TABLE contractor_trades (
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  trade_id      INTEGER NOT NULL REFERENCES trades(id),
  qualification TEXT,
  verified      BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (contractor_id, trade_id)
);

CREATE TABLE files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  customer_id   UUID REFERENCES customers(id),
  contractor_id UUID REFERENCES contractors(id),
  job_id        UUID,
  purpose       TEXT NOT NULL,
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  doc_type      TEXT NOT NULL,
  reference     TEXT,
  issued_at     DATE,
  expires_at    DATE,
  file_id       UUID REFERENCES files(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','superseded')),
  verified_by   UUID REFERENCES users(id),
  verified_at   TIMESTAMPTZ,
  expiry_alerted_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX compliance_contractor_idx ON compliance_documents(contractor_id);

-- Contractor cost rates (what the contractor may charge Ridgeline).
CREATE TABLE contractor_rate_cards (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id               UUID NOT NULL REFERENCES contractors(id),
  trade_id                    INTEGER NOT NULL REFERENCES trades(id),
  labour_rate_cents           BIGINT NOT NULL CHECK (labour_rate_cents >= 0),
  callout_cents               BIGINT NOT NULL DEFAULT 0,
  emergency_callout_cents     BIGINT NOT NULL DEFAULT 0,
  after_hours_multiplier_bps  INTEGER NOT NULL DEFAULT 15000,
  weekend_multiplier_bps      INTEGER NOT NULL DEFAULT 15000,
  public_holiday_multiplier_bps INTEGER NOT NULL DEFAULT 20000,
  overnight_multiplier_bps    INTEGER NOT NULL DEFAULT 20000,
  travel_per_km_cents         BIGINT NOT NULL DEFAULT 0,
  min_charge_cents            BIGINT NOT NULL DEFAULT 0,
  materials_margin_bps        INTEGER NOT NULL DEFAULT 0,
  cancellation_fee_cents      BIGINT NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','retired')),
  effective_from              DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to                DATE,
  approved_by                 UUID REFERENCES users(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_cards_lookup_idx ON contractor_rate_cards(contractor_id, trade_id, status);

-- ---------------------------------------------------------------------------
-- Customer pricing rules (what Ridgeline charges customers). Only 'approved' rules are used.
-- ---------------------------------------------------------------------------

CREATE TABLE pricing_rules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category                 TEXT NOT NULL CHECK (category IN (
                              'standard_labour','standard_callout','emergency_callout','after_hours','weekend',
                              'public_holiday','overnight','travel','materials','specialist','minimum_charge',
                              'variation','cancellation')),
  customer_id              UUID REFERENCES customers(id),
  trade_id                 INTEGER REFERENCES trades(id),
  priority                 TEXT CHECK (priority IN ('routine','urgent','emergency')),
  method                   TEXT NOT NULL CHECK (method IN ('markup','fixed_rate','standard_multiplier','minimum')),
  markup_bps               INTEGER,
  customer_rate_cents      BIGINT,
  customer_multiplier_bps  INTEGER,
  minimum_cents            BIGINT,
  reference_contractor_rate_cents BIGINT,
  unit                     TEXT NOT NULL DEFAULT 'each',
  description              TEXT,
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  created_by               UUID REFERENCES users(id),
  approved_by              UUID REFERENCES users(id),
  approved_at              TIMESTAMPTZ,
  retired_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (method <> 'markup' OR markup_bps IS NOT NULL),
  CHECK (method <> 'fixed_rate' OR customer_rate_cents IS NOT NULL),
  CHECK (method <> 'standard_multiplier' OR customer_multiplier_bps IS NOT NULL),
  CHECK (method <> 'minimum' OR minimum_cents IS NOT NULL)
);
-- At most one approved rule per scope.
CREATE UNIQUE INDEX pricing_rules_one_approved_idx ON pricing_rules (
  category, COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'), COALESCE(trade_id, 0), COALESCE(priority, '')
) WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- Jobs, dispatch, evidence
-- ---------------------------------------------------------------------------

CREATE SEQUENCE job_ref_seq START 100001;

CREATE TABLE jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                      TEXT NOT NULL UNIQUE DEFAULT ('RF-J-' || nextval('job_ref_seq')),
  customer_id              UUID NOT NULL REFERENCES customers(id),
  site_id                  UUID NOT NULL REFERENCES sites(id),
  facility_id              UUID REFERENCES facilities(id),
  unit_id                  UUID REFERENCES units(id),
  trade_id                 INTEGER NOT NULL REFERENCES trades(id),
  priority                 TEXT NOT NULL CHECK (priority IN ('routine','urgent','emergency')),
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,
  access_instructions      TEXT,
  site_contact_name        TEXT,
  site_contact_phone       TEXT,
  preferred_start          TIMESTAMPTZ,
  preferred_end            TIMESTAMPTZ,
  po_number                TEXT,
  status                   TEXT NOT NULL,
  hold_reason              TEXT,
  estimate                 JSONB,
  estimate_total_cents     BIGINT,
  authorised_contractor_cost_cents BIGINT,
  requires_quote           BOOLEAN NOT NULL DEFAULT false,
  customer_approved_by     UUID REFERENCES users(id),
  customer_approved_at     TIMESTAMPTZ,
  funding_exception_id     UUID,
  respond_by               TIMESTAMPTZ,
  attend_by                TIMESTAMPTZ,
  sla_alerted_at           TIMESTAMPTZ,
  assigned_contractor_id   UUID REFERENCES contractors(id),
  accepted_at              TIMESTAMPTZ,
  arrived_at               TIMESTAMPTZ,
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancellation_reason      TEXT,
  cancellation_billable    BOOLEAN NOT NULL DEFAULT false,
  booked_by                UUID REFERENCES users(id),
  idempotency_key          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key),
  CHECK (status IN ('pending_funds','awaiting_customer_approval','awaiting_quote','dispatch','offered','assigned',
                    'on_site','in_progress','evidence_submitted','evidence_rejected','evidence_approved',
                    'invoice_submitted','invoice_approved','customer_invoiced','closed','cancelled'))
);
CREATE INDEX jobs_customer_idx ON jobs(customer_id);
CREATE INDEX jobs_status_idx ON jobs(status);
CREATE INDEX jobs_contractor_idx ON jobs(assigned_contractor_id);

CREATE TABLE funding_exceptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  job_id        UUID REFERENCES jobs(id),
  reason        TEXT NOT NULL,
  max_cents     BIGINT,
  approved_by   UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id),
  event_type  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor_id    UUID REFERENCES users(id),
  note        TEXT,
  lat         NUMERIC(9,6),
  lng         NUMERIC(9,6),
  accuracy_m  NUMERIC(10,2),
  -- Server-generated timestamp; device clocks are never trusted for event times.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events(job_id);

CREATE TABLE job_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  status        TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','expired','withdrawn')),
  offered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  responded_at  TIMESTAMPTZ,
  decline_reason TEXT
);
CREATE UNIQUE INDEX job_offers_one_live_idx ON job_offers(job_id, contractor_id) WHERE status = 'offered';
CREATE UNIQUE INDEX job_offers_one_accepted_idx ON job_offers(job_id) WHERE status = 'accepted';

CREATE TABLE job_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  method        TEXT NOT NULL CHECK (method IN ('accepted','manual')),
  assigned_by   UUID REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_reason  TEXT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);
-- Database-level guarantee against duplicate assignment.
CREATE UNIQUE INDEX job_assignments_one_active_idx ON job_assignments(job_id) WHERE status = 'active';

CREATE TABLE job_evidence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id),
  kind            TEXT NOT NULL CHECK (kind IN ('booking_photo','before_photo','after_photo','receipt','document','signature')),
  file_id         UUID NOT NULL REFERENCES files(id),
  caption         TEXT,
  device_captured_at TIMESTAMPTZ,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),
  uploaded_by     UUID REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at    TIMESTAMPTZ,
  withdrawn_by    UUID REFERENCES users(id),
  withdrawn_reason TEXT
);
CREATE INDEX job_evidence_job_idx ON job_evidence(job_id);

-- Each submission is a new version; earlier versions are preserved.
CREATE TABLE completion_reports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES jobs(id),
  version               INTEGER NOT NULL,
  work_performed        TEXT NOT NULL,
  labour_minutes        INTEGER NOT NULL CHECK (labour_minutes >= 0),
  workers               INTEGER NOT NULL DEFAULT 1 CHECK (workers >= 1),
  materials             JSONB NOT NULL DEFAULT '[]',
  site_notes            TEXT,
  issues_found          TEXT,
  acknowledged_by_name  TEXT,
  acknowledged_at       TIMESTAMPTZ,
  submitted_by          UUID REFERENCES users(id),
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status         TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  review_notes          TEXT,
  review_flags          JSONB NOT NULL DEFAULT '[]',
  reviewed_by           UUID REFERENCES users(id),
  reviewed_at           TIMESTAMPTZ,
  UNIQUE (job_id, version)
);

-- Quotes and variations: contractor proposes cost; Ridgeline prices; customer approves.
CREATE TABLE quotes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id),
  contractor_id          UUID REFERENCES contractors(id),
  kind                   TEXT NOT NULL CHECK (kind IN ('quote','variation')),
  description            TEXT NOT NULL,
  lines                  JSONB NOT NULL,
  contractor_cost_cents  BIGINT NOT NULL,
  customer_price_ex_gst_cents BIGINT,
  customer_gst_cents     BIGINT,
  customer_total_cents   BIGINT,
  pricing                JSONB,
  status                 TEXT NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted','sent_to_customer','approved','declined','withdrawn')),
  submitted_by           UUID REFERENCES users(id),
  reviewed_by            UUID REFERENCES users(id),
  customer_decision_by   UUID REFERENCES users(id),
  customer_decision_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- General ledger (double entry) and customer prepaid sub-ledger
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  type   TEXT NOT NULL CHECK (type IN ('asset','liability','income','expense','equity'))
);

CREATE TABLE journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  description     TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_id       TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  reverses_entry_id UUID REFERENCES journal_entries(id),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id            BIGSERIAL PRIMARY KEY,
  entry_id      UUID NOT NULL REFERENCES journal_entries(id),
  account_code  TEXT NOT NULL REFERENCES ledger_accounts(code),
  customer_id   UUID REFERENCES customers(id),
  contractor_id UUID REFERENCES contractors(id),
  job_id        UUID REFERENCES jobs(id),
  debit_cents   BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents  BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_code, customer_id);

-- Every journal entry must balance; checked at commit time.
CREATE FUNCTION check_journal_balanced() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit_cents),0), COALESCE(SUM(credit_cents),0) INTO d, c
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c THEN
    RAISE EXCEPTION 'Journal entry % does not balance (debits %, credits %)', NEW.entry_id, d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

CREATE TABLE prepaid_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id),
  txn_type           TEXT NOT NULL CHECK (txn_type IN ('deposit','top_up','job_charge','refund','adjustment','credit_note','reversal','receivable_settlement')),
  amount_cents       BIGINT NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  description        TEXT NOT NULL,
  reference          TEXT,
  job_id             UUID REFERENCES jobs(id),
  customer_invoice_id UUID,
  payment_id         UUID,
  journal_entry_id   UUID NOT NULL REFERENCES journal_entries(id),
  idempotency_key    TEXT NOT NULL UNIQUE,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prepaid_txn_customer_idx ON prepaid_transactions(customer_id, created_at);

-- Funds earmarked for booked jobs (reduces available balance, not the prepaid balance).
CREATE TABLE job_commitments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  job_id       UUID NOT NULL REFERENCES jobs(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','settled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX job_commitments_one_active_idx ON job_commitments(job_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Customer payments (top-ups, receivable payments) and refunds
-- ---------------------------------------------------------------------------

CREATE SEQUENCE payment_ref_seq START 5001;

CREATE TABLE customer_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           TEXT NOT NULL UNIQUE DEFAULT ('RFP-' || nextval('payment_ref_seq')),
  customer_id         UUID NOT NULL REFERENCES customers(id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('deposit','top_up','invoice')),
  customer_invoice_id UUID,
  method              TEXT NOT NULL CHECK (method IN ('bank_transfer','card','other')),
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','cancelled','reversed')),
  provider            TEXT,
  provider_session_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  bank_reference      TEXT,
  received_date       DATE,
  failure_reason      TEXT,
  is_auto_topup       BOOLEAN NOT NULL DEFAULT false,
  requested_by        UUID REFERENCES users(id),
  confirmed_by        UUID REFERENCES users(id),
  confirmed_at        TIMESTAMPTZ,
  idempotency_key     TEXT UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auto_topup_consents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id),
  consented_by       UUID NOT NULL REFERENCES users(id),
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  trigger_below_cents BIGINT NOT NULL CHECK (trigger_below_cents >= 0),
  consent_text       TEXT NOT NULL,
  consented_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  revoked_by         UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX auto_topup_one_active_idx ON auto_topup_consents(customer_id) WHERE revoked_at IS NULL;

CREATE TABLE refunds (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  requested_by   UUID REFERENCES users(id),
  approved_by    UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  paid_reference TEXT,
  paid_date      DATE,
  paid_by        UUID REFERENCES users(id),
  rejection_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Contractor invoices (to Ridgeline) and customer invoices (from Ridgeline)
-- ---------------------------------------------------------------------------

CREATE TABLE contractor_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id      UUID NOT NULL REFERENCES contractors(id),
  job_id             UUID NOT NULL REFERENCES jobs(id),
  invoice_number     TEXT NOT NULL,
  invoice_date       DATE NOT NULL,
  subtotal_ex_gst_cents BIGINT NOT NULL CHECK (subtotal_ex_gst_cents >= 0),
  gst_cents          BIGINT NOT NULL CHECK (gst_cents >= 0),
  total_cents        BIGINT NOT NULL CHECK (total_cents >= 0),
  gst_registered     BOOLEAN NOT NULL,
  contractor_gst_number TEXT,
  contractor_legal_name TEXT NOT NULL,
  contractor_nzbn    TEXT,
  payment_terms_days INTEGER NOT NULL,
  is_tax_invoice     BOOLEAN NOT NULL DEFAULT false,
  file_id            UUID REFERENCES files(id),
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','flagged','approved','rejected','void')),
  validation         JSONB NOT NULL DEFAULT '{}',
  override_reason    TEXT,
  rejection_reason   TEXT,
  submitted_by       UUID REFERENCES users(id),
  reviewed_by        UUID REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  idempotency_key    TEXT UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (subtotal_ex_gst_cents + gst_cents = total_cents)
);
CREATE UNIQUE INDEX contractor_invoice_number_idx ON contractor_invoices(contractor_id, lower(invoice_number));
CREATE UNIQUE INDEX contractor_invoice_one_live_per_job_idx ON contractor_invoices(job_id) WHERE status IN ('submitted','flagged','approved');

CREATE TABLE contractor_invoice_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES contractor_invoices(id),
  line_no           INTEGER NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('labour','callout','travel','materials','variation','cancellation','minimum_charge')),
  description       TEXT NOT NULL,
  quantity_milli    BIGINT NOT NULL CHECK (quantity_milli > 0),
  unit_rate_cents   BIGINT NOT NULL CHECK (unit_rate_cents >= 0),
  amount_cents      BIGINT NOT NULL CHECK (amount_cents >= 0),
  time_window       TEXT NOT NULL DEFAULT 'standard' CHECK (time_window IN ('standard','after_hours','weekend','public_holiday','overnight')),
  variation_id      UUID REFERENCES quotes(id),
  UNIQUE (invoice_id, line_no)
);

CREATE SEQUENCE customer_invoice_seq START 10001;
CREATE SEQUENCE credit_note_seq START 1001;

CREATE TABLE customer_invoices (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number         TEXT UNIQUE,
  customer_id            UUID NOT NULL REFERENCES customers(id),
  job_id                 UUID NOT NULL REFERENCES jobs(id),
  contractor_invoice_id  UUID NOT NULL REFERENCES contractor_invoices(id),
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','void')),
  issue_date             DATE,
  due_date               DATE,
  po_number              TEXT,
  subtotal_ex_gst_cents  BIGINT NOT NULL,
  gst_cents              BIGINT NOT NULL,
  total_cents            BIGINT NOT NULL,
  prepaid_applied_cents  BIGINT NOT NULL DEFAULT 0,
  amount_paid_cents      BIGINT NOT NULL DEFAULT 0,
  credited_cents         BIGINT NOT NULL DEFAULT 0,
  -- Portion of credit notes returned to the prepaid balance (reverses earlier prepaid/cash settlement).
  credit_to_prepaid_cents BIGINT NOT NULL DEFAULT 0,
  -- Internal-only figures (never shown on customer documents).
  contractor_cost_ex_gst_cents BIGINT NOT NULL,
  markup_cents           BIGINT NOT NULL,
  pricing                JSONB NOT NULL,
  created_by             UUID REFERENCES users(id),
  issued_by              UUID REFERENCES users(id),
  issued_at              TIMESTAMPTZ,
  sent_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (subtotal_ex_gst_cents + gst_cents = total_cents),
  CHECK (credit_to_prepaid_cents <= prepaid_applied_cents + amount_paid_cents),
  CHECK (prepaid_applied_cents + amount_paid_cents - credit_to_prepaid_cents + credited_cents <= total_cents)
);
-- One live customer invoice per job: the primary guard against double billing.
CREATE UNIQUE INDEX customer_invoice_one_per_job_idx ON customer_invoices(job_id) WHERE status <> 'void';
CREATE UNIQUE INDEX customer_invoice_per_contractor_invoice_idx ON customer_invoices(contractor_invoice_id) WHERE status <> 'void';

CREATE TABLE customer_invoice_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         UUID NOT NULL REFERENCES customer_invoices(id),
  line_no            INTEGER NOT NULL,
  category           TEXT NOT NULL,
  description        TEXT NOT NULL,
  quantity_milli     BIGINT NOT NULL,
  unit_price_cents   BIGINT NOT NULL,
  amount_ex_gst_cents BIGINT NOT NULL,
  contractor_line_id UUID REFERENCES contractor_invoice_lines(id),
  contractor_cost_cents BIGINT NOT NULL DEFAULT 0,
  pricing_rule_id    UUID REFERENCES pricing_rules(id),
  pricing_explanation TEXT NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE credit_notes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number   TEXT NOT NULL UNIQUE DEFAULT ('RF-CN-' || nextval('credit_note_seq')),
  customer_invoice_id  UUID NOT NULL REFERENCES customer_invoices(id),
  customer_id          UUID NOT NULL REFERENCES customers(id),
  dispute_id           UUID,
  amount_ex_gst_cents  BIGINT NOT NULL CHECK (amount_ex_gst_cents > 0),
  gst_cents            BIGINT NOT NULL CHECK (gst_cents >= 0),
  total_cents          BIGINT NOT NULL,
  to_prepaid_cents     BIGINT NOT NULL DEFAULT 0,
  to_receivable_cents  BIGINT NOT NULL DEFAULT 0,
  reason               TEXT NOT NULL,
  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_ex_gst_cents + gst_cents = total_cents),
  CHECK (to_prepaid_cents + to_receivable_cents = total_cents)
);

-- ---------------------------------------------------------------------------
-- Contractor payables & payments (separate from customer ledger)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE payment_batch_seq START 101;

CREATE TABLE contractor_payables (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id         UUID NOT NULL REFERENCES contractors(id),
  contractor_invoice_id UUID NOT NULL UNIQUE REFERENCES contractor_invoices(id),
  job_id                UUID NOT NULL REFERENCES jobs(id),
  invoice_total_cents   BIGINT NOT NULL CHECK (invoice_total_cents >= 0),
  adjustments_cents     BIGINT NOT NULL DEFAULT 0,
  due_date              DATE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'awaiting_payment_approval'
                          CHECK (status IN ('awaiting_payment_approval','approved_for_payment','in_batch','paid','on_hold','cancelled')),
  hold_reason           TEXT,
  documentation_ok      BOOLEAN NOT NULL DEFAULT false,
  payment_approved_by   UUID REFERENCES users(id),
  payment_approved_at   TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (invoice_total_cents + adjustments_cents >= 0)
);

CREATE TABLE payable_adjustments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id   UUID NOT NULL REFERENCES contractor_payables(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  created_by   UUID REFERENCES users(id),
  approved_by  UUID REFERENCES users(id),
  contractor_agreed BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);

CREATE TABLE payment_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         TEXT NOT NULL UNIQUE DEFAULT ('RF-PB-' || nextval('payment_batch_seq')),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','exported','completed','cancelled')),
  created_by  UUID REFERENCES users(id),
  exported_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contractor_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id       UUID NOT NULL REFERENCES contractor_payables(id),
  batch_id         UUID REFERENCES payment_batches(id),
  contractor_id    UUID NOT NULL REFERENCES contractors(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','failed','cancelled')),
  scheduled_date   DATE,
  paid_date        DATE,
  payment_reference TEXT,
  confirmation_source TEXT CHECK (confirmation_source IN ('manual','bank_statement','provider')),
  failure_reason   TEXT,
  confirmed_by     UUID REFERENCES users(id),
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR (paid_date IS NOT NULL AND payment_reference IS NOT NULL))
);
CREATE UNIQUE INDEX contractor_payment_one_live_idx ON contractor_payments(payable_id) WHERE status IN ('scheduled','confirmed');

-- ---------------------------------------------------------------------------
-- Disputes, notifications, integrations, webhooks, idempotency, audit
-- ---------------------------------------------------------------------------

CREATE TABLE disputes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  customer_invoice_id UUID REFERENCES customer_invoices(id),
  raised_by           UUID REFERENCES users(id),
  raised_by_party     TEXT NOT NULL CHECK (raised_by_party IN ('customer','contractor','ridgeline')),
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected')),
  resolution          TEXT,
  resolved_by         UUID REFERENCES users(id),
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email CITEXT,
  recipient_user_id UUID REFERENCES users(id),
  channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  template        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  attachments     JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','not_sent_unconfigured')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  provider_message_id TEXT,
  idempotency_key TEXT UNIQUE,
  related_type    TEXT,
  related_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_queue_idx ON notifications(status, next_attempt_at);

CREATE TABLE integration_sync (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','failed','skipped_unconfigured')),
  external_id   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, entity_type, entity_id)
);

CREATE TABLE webhook_events (
  provider       TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  processed_at   TIMESTAMPTZ,
  result         TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Generic idempotency store for HTTP form submissions that create financial records.
CREATE TABLE idempotency_keys (
  key          TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  user_id      UUID,
  result_ref   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     UUID,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  customer_id  UUID,
  contractor_id UUID,
  details      JSONB NOT NULL DEFAULT '{}',
  ip           TEXT
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);

-- Append-only protection for audit, journal, evidence and event history.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER prepaid_txn_append_only BEFORE UPDATE OR DELETE ON prepaid_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON job_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER files_append_only BEFORE UPDATE OR DELETE ON files FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER completion_reports_no_delete BEFORE DELETE ON completion_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER job_evidence_no_delete BEFORE DELETE ON job_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Session store for express-session (connect-pg-simple layout).
CREATE TABLE user_sessions (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX user_sessions_expire_idx ON user_sessions(expire);
