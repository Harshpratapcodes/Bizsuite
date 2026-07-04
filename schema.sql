-- ============================================================================
-- BizSuite — Full PostgreSQL Schema
-- Modular business management suite: Core / CRM / Sales / Accounting / Inventory
-- Target: PostgreSQL 16+
--
-- Design principles (see project plan §4–§5):
--   1. Append-only financial & stock ledgers — corrections via reversals only.
--   2. Submitted documents are immutable (enforced by triggers, not convention).
--   3. Balances are DERIVED (views) — never trusted mutable columns,
--      except the item_warehouse cache which exists as a lock anchor and is
--      trigger-maintained + nightly-verified.
--   4. Money is NUMERIC(15,2), quantity NUMERIC(12,3). No floats. Ever.
--   5. The application sets `SET LOCAL app.user_id = '<uuid>'` per transaction
--      so audit triggers know the actor.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ============================================================================
-- SECTION 0: ENUM TYPES
-- ============================================================================

CREATE TYPE doc_status        AS ENUM ('draft', 'submitted', 'cancelled');
CREATE TYPE account_type      AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE journal_status    AS ENUM ('draft', 'posted', 'cancelled');
CREATE TYPE voucher_type      AS ENUM ('sales_invoice', 'credit_note', 'payment_in',
                                       'purchase_receipt', 'stock_adjustment',
                                       'stock_transfer', 'manual_journal');
CREATE TYPE deal_status       AS ENUM ('open', 'won', 'lost');
CREATE TYPE activity_type     AS ENUM ('call', 'email', 'meeting', 'note', 'task');
CREATE TYPE invoice_kind      AS ENUM ('invoice', 'credit_note');
CREATE TYPE gst_treatment     AS ENUM ('registered', 'unregistered', 'overseas', 'sez');

-- ============================================================================
-- SECTION 1: HELPER FUNCTIONS (used by triggers everywhere)
-- ============================================================================

-- Maintain updated_at on every UPDATE
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Current actor: read from per-transaction setting; NULL when unset (jobs, psql)
CREATE OR REPLACE FUNCTION fn_current_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ============================================================================
-- SECTION 2: CORE PLATFORM — users, RBAC, settings, sequences, audit
-- ============================================================================

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,            -- 'admin','accounts','sales','inventory','readonly'
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-module, per-action permission matrix
CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module     text NOT NULL CHECK (module IN ('crm','sales','invoicing','accounting','inventory','core')),
  can_read   boolean NOT NULL DEFAULT false,
  can_write  boolean NOT NULL DEFAULT false,   -- create/edit drafts
  can_submit boolean NOT NULL DEFAULT false,   -- post documents
  can_cancel boolean NOT NULL DEFAULT false,   -- cancel posted documents
  PRIMARY KEY (role_id, module)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name     text NOT NULL,
  password_hash text NOT NULL,                 -- argon2id
  role_id       uuid NOT NULL REFERENCES roles(id),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE sessions (
  id         text PRIMARY KEY,                 -- random 256-bit token (hashed by app)
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Single-row company settings (id=1 enforced)
CREATE TABLE company_settings (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name           text NOT NULL,
  gstin                text CHECK (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code           text NOT NULL,          -- '09' = Uttar Pradesh; drives intra/inter-state
  address              jsonb NOT NULL DEFAULT '{}',
  bank_details         jsonb NOT NULL DEFAULT '{}',
  logo_url             text,
  financial_year_start date NOT NULL DEFAULT '2026-04-01',
  allow_negative_stock boolean NOT NULL DEFAULT false,
  invoice_terms        text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON company_settings
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- Document numbering: gapless, duplicate-free, issued AT SUBMISSION inside
-- the submitting transaction. UPDATE..RETURNING takes a row lock — concurrent
-- submitters serialize on the series row.
-- ---------------------------------------------------------------------------
CREATE TABLE document_sequences (
  series        text PRIMARY KEY,              -- e.g. 'INV-2026'
  prefix        text NOT NULL,                 -- 'INV-2026-'
  padding       smallint NOT NULL DEFAULT 5 CHECK (padding BETWEEN 3 AND 8),
  current_value bigint NOT NULL DEFAULT 0 CHECK (current_value >= 0)
);

CREATE OR REPLACE FUNCTION next_doc_number(p_series text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_prefix  text;
  v_padding smallint;
  v_value   bigint;
BEGIN
  UPDATE document_sequences
     SET current_value = current_value + 1
   WHERE series = p_series
   RETURNING prefix, padding, current_value INTO v_prefix, v_padding, v_value;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown document series: %', p_series
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_prefix || lpad(v_value::text, v_padding, '0');
END $$;

-- ---------------------------------------------------------------------------
-- Audit log: generic row-change capture. Attached to every business table.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,                            -- NULL for system jobs
  table_name  text NOT NULL,
  record_id   uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_data    jsonb,
  new_data    jsonb
);
CREATE INDEX idx_audit_record ON audit_log(table_name, record_id, occurred_at);
CREATE INDEX idx_audit_actor  ON audit_log(actor_id, occurred_at);

CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (actor_id, table_name, record_id, action, old_data, new_data)
  VALUES (
    fn_current_actor(),
    TG_TABLE_NAME,
    COALESCE(
      CASE WHEN TG_OP = 'DELETE' THEN (to_jsonb(OLD)->>'id')::uuid
           ELSE (to_jsonb(NEW)->>'id')::uuid END),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- The audit log itself is append-only.
CREATE OR REPLACE FUNCTION fn_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

-- ============================================================================
-- SECTION 3: CRM — companies, contacts, pipeline, deals, activities
-- ============================================================================

CREATE TABLE companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  gstin            text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  gst_treatment    gst_treatment NOT NULL DEFAULT 'unregistered',
  state_code       text,                       -- buyer state; needed for place of supply default
  industry         text,
  website          text,
  billing_address  jsonb NOT NULL DEFAULT '{}',
  shipping_address jsonb NOT NULL DEFAULT '{}',
  notes            text,
  is_customer      boolean NOT NULL DEFAULT true,
  is_supplier      boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registered_needs_gstin CHECK (gst_treatment <> 'registered' OR gstin IS NOT NULL)
);
CREATE UNIQUE INDEX uq_companies_name  ON companies (lower(name));
CREATE INDEX idx_companies_gstin       ON companies (gstin) WHERE gstin IS NOT NULL;
CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_companies_audit AFTER INSERT OR UPDATE OR DELETE ON companies
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text CHECK (email IS NULL OR email = lower(email)),
  phone       text,
  designation text,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contacts_company ON contacts(company_id);
-- At most one primary contact per company
CREATE UNIQUE INDEX uq_contacts_primary ON contacts(company_id) WHERE is_primary;
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE pipeline_stages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL UNIQUE,
  sort_order          smallint NOT NULL UNIQUE,
  default_probability smallint NOT NULL DEFAULT 0 CHECK (default_probability BETWEEN 0 AND 100),
  is_active           boolean NOT NULL DEFAULT true
);

CREATE TABLE deals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  company_id          uuid NOT NULL REFERENCES companies(id),
  contact_id          uuid REFERENCES contacts(id),
  pipeline_stage_id   uuid NOT NULL REFERENCES pipeline_stages(id),
  value               numeric(15,2) CHECK (value IS NULL OR value >= 0),
  probability         smallint CHECK (probability BETWEEN 0 AND 100),
  expected_close_date date,
  status              deal_status NOT NULL DEFAULT 'open',
  lost_reason         text,
  source              text,
  owner_id            uuid NOT NULL REFERENCES users(id),
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lost_needs_reason  CHECK (status <> 'lost' OR lost_reason IS NOT NULL),
  CONSTRAINT closed_needs_stamp CHECK (status = 'open' OR closed_at IS NOT NULL)
);
CREATE INDEX idx_deals_stage  ON deals(pipeline_stage_id) WHERE status = 'open';
CREATE INDEX idx_deals_owner  ON deals(owner_id);
CREATE INDEX idx_deals_company ON deals(company_id);
CREATE TRIGGER trg_deals_updated BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_deals_audit AFTER INSERT OR UPDATE OR DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         activity_type NOT NULL,
  subject      text NOT NULL,
  body         text,
  due_at       timestamptz,
  completed_at timestamptz,
  owner_id     uuid NOT NULL REFERENCES users(id),
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id)  ON DELETE SET NULL,
  deal_id      uuid REFERENCES deals(id)     ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_has_anchor CHECK (company_id IS NOT NULL OR deal_id IS NOT NULL)
);
CREATE INDEX idx_activities_owner_due ON activities(owner_id, due_at) WHERE completed_at IS NULL;
CREATE INDEX idx_activities_deal      ON activities(deal_id);
CREATE TRIGGER trg_activities_updated BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================================
-- SECTION 4: INVENTORY MASTERS — items, warehouses
-- (Masters precede sales documents because invoice lines reference items.)
-- ============================================================================

CREATE TABLE items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                   text NOT NULL UNIQUE,
  name                  text NOT NULL,
  description           text,
  uom                   text NOT NULL DEFAULT 'Nos',
  hsn_sac_code          text NOT NULL CHECK (hsn_sac_code ~ '^[0-9]{4,8}$'),
  gst_rate              numeric(5,2) NOT NULL CHECK (gst_rate IN (0, 0.25, 3, 5, 12, 18, 28)),
  is_stock_item         boolean NOT NULL DEFAULT true,   -- false = service
  reorder_level         numeric(12,3) CHECK (reorder_level IS NULL OR reorder_level >= 0),
  standard_selling_rate numeric(15,2) CHECK (standard_selling_rate IS NULL OR standard_selling_rate >= 0),
  standard_buying_rate  numeric(15,2) CHECK (standard_buying_rate  IS NULL OR standard_buying_rate  >= 0),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_items_audit AFTER INSERT OR UPDATE OR DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  address    jsonb NOT NULL DEFAULT '{}',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- SECTION 5: ACCOUNTING — chart of accounts, journal, GL
-- ============================================================================

CREATE TABLE accounts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  type      account_type NOT NULL,
  parent_id uuid REFERENCES accounts(id),
  is_group  boolean NOT NULL DEFAULT false,    -- group accounts cannot be posted to
  is_active boolean NOT NULL DEFAULT true,
  -- system accounts (Debtors, Sales, GST Output...) are wired into posting
  -- logic by key and cannot be deleted or re-typed from the UI
  system_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_parent ON accounts(parent_id);
CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_accounts_audit AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

-- Children must keep the parent's type; parents must be groups.
CREATE OR REPLACE FUNCTION fn_account_tree_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent accounts%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM accounts WHERE id = NEW.parent_id;
    IF NOT v_parent.is_group THEN
      RAISE EXCEPTION 'Parent account % is not a group account', v_parent.code;
    END IF;
    IF v_parent.type <> NEW.type THEN
      RAISE EXCEPTION 'Account type % must match parent type %', NEW.type, v_parent.type;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_tree BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION fn_account_tree_check();

CREATE TABLE journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no     text UNIQUE,                    -- issued by next_doc_number at posting
  posting_date date NOT NULL,
  voucher_type voucher_type NOT NULL,
  voucher_id   uuid,                           -- source document (invoice, payment, stock doc)
  narration    text,
  status       journal_status NOT NULL DEFAULT 'draft',
  posted_by    uuid REFERENCES users(id),
  posted_at    timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  reverses_id  uuid REFERENCES journal_entries(id),  -- set on reversal entries
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posted_has_no    CHECK (status = 'draft' OR entry_no IS NOT NULL),
  CONSTRAINT posted_has_stamp CHECK (status <> 'posted' OR (posted_by IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE INDEX idx_je_voucher ON journal_entries(voucher_type, voucher_id);
CREATE INDEX idx_je_date    ON journal_entries(posting_date) WHERE status = 'posted';
CREATE TRIGGER trg_je_updated BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_je_audit AFTER INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE journal_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  debit            numeric(15,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit           numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- sub-ledger dimension (receivables/payables per party)
  party_type       text CHECK (party_type IN ('customer','supplier')),
  party_id         uuid REFERENCES companies(id),
  remarks          text,
  CONSTRAINT one_side_only   CHECK (NOT (debit > 0 AND credit > 0)),
  CONSTRAINT nonzero_line    CHECK (debit > 0 OR credit > 0),
  CONSTRAINT party_pairing   CHECK ((party_type IS NULL) = (party_id IS NULL))
);
CREATE INDEX idx_jl_entry   ON journal_lines(journal_entry_id);
CREATE INDEX idx_jl_account ON journal_lines(account_id);
CREATE INDEX idx_jl_party   ON journal_lines(party_type, party_id) WHERE party_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- LEDGER INTEGRITY TRIGGERS
-- ---------------------------------------------------------------------------

-- (a) Posting to group accounts is forbidden
CREATE OR REPLACE FUNCTION fn_no_group_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_group FROM accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'Cannot post to group account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_jl_no_group BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fn_no_group_posting();

-- (b) Lines of a non-draft entry are frozen (no update/delete/insert)
CREATE OR REPLACE FUNCTION fn_jl_frozen_when_posted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status journal_status;
BEGIN
  SELECT status INTO v_status FROM journal_entries
   WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Journal lines are immutable once the entry is %', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_jl_frozen BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fn_jl_frozen_when_posted();

-- (c) Posted journal entries: only allowed transition is posted -> cancelled,
--     touching only the cancellation columns. Deletion is always forbidden.
CREATE OR REPLACE FUNCTION fn_je_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  guard text[] := ARRAY['status','cancelled_by','cancelled_at','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted/cancelled journal entries cannot be deleted; post a reversal instead';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status = 'cancelled'
       AND NEW.cancelled_by IS NOT NULL AND NEW.cancelled_at IS NOT NULL
       AND (to_jsonb(OLD) - guard) = (to_jsonb(NEW) - guard) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Posted journal entries are immutable (only cancellation is allowed)';
  ELSIF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled journal entries are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_je_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_je_immutable();

-- (d) THE BALANCE INVARIANT: at commit, every posted entry's debits = credits
--     and it has at least two lines. Deferred constraint trigger => the app
--     can insert header + lines in any order inside the transaction.
CREATE OR REPLACE FUNCTION fn_je_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debit  numeric(15,2);
  v_credit numeric(15,2);
  v_count  int;
BEGIN
  SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0), count(*)
    INTO v_debit, v_credit, v_count
    FROM journal_lines WHERE journal_entry_id = NEW.id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least two lines', NEW.entry_no;
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debit % <> credit %',
      NEW.entry_no, v_debit, v_credit;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_je_balanced
  AFTER INSERT OR UPDATE OF status ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION fn_je_balanced();

-- ============================================================================
-- SECTION 6: SALES — quotations, invoices, payments
-- ============================================================================

CREATE TABLE quotations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no               text UNIQUE,            -- issued at submission
  doc_date             date NOT NULL DEFAULT CURRENT_DATE,
  status               doc_status NOT NULL DEFAULT 'draft',
  customer_id          uuid NOT NULL REFERENCES companies(id),
  contact_id           uuid REFERENCES contacts(id),
  deal_id              uuid REFERENCES deals(id),
  place_of_supply      text NOT NULL,          -- state code
  is_inter_state       boolean NOT NULL DEFAULT false,
  valid_until          date,
  subtotal             numeric(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total       numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  taxable_total        numeric(15,2) NOT NULL DEFAULT 0 CHECK (taxable_total >= 0),
  cgst_total           numeric(15,2) NOT NULL DEFAULT 0 CHECK (cgst_total >= 0),
  sgst_total           numeric(15,2) NOT NULL DEFAULT 0 CHECK (sgst_total >= 0),
  igst_total           numeric(15,2) NOT NULL DEFAULT 0 CHECK (igst_total >= 0),
  grand_total          numeric(15,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  converted_invoice_id uuid,                   -- FK added after invoices exists
  terms                text,
  notes                text,
  submitted_by         uuid REFERENCES users(id),
  submitted_at         timestamptz,
  cancelled_by         uuid REFERENCES users(id),
  cancelled_at         timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- intra-state uses CGST+SGST, inter-state uses IGST — never both
  CONSTRAINT tax_split_consistent CHECK (
    (is_inter_state AND cgst_total = 0 AND sgst_total = 0)
    OR (NOT is_inter_state AND igst_total = 0)),
  CONSTRAINT submitted_has_no CHECK (status = 'draft' OR doc_no IS NOT NULL)
);
CREATE INDEX idx_quotations_customer ON quotations(customer_id);
CREATE INDEX idx_quotations_status   ON quotations(status, doc_date);
CREATE TRIGGER trg_qtn_updated BEFORE UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_qtn_audit AFTER INSERT OR UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE quotation_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id  uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES items(id),
  description   text NOT NULL,
  hsn_sac_code  text NOT NULL,
  qty           numeric(12,3) NOT NULL CHECK (qty > 0),
  uom           text NOT NULL DEFAULT 'Nos',
  rate          numeric(15,2) NOT NULL CHECK (rate >= 0),
  discount_pct  numeric(5,2)  NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  taxable_value numeric(15,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate      numeric(5,2)  NOT NULL,
  cgst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  sgst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  igst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  line_total    numeric(15,2) NOT NULL,
  sort_order    smallint NOT NULL DEFAULT 0
);
CREATE INDEX idx_qtn_lines ON quotation_lines(quotation_id);

CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                invoice_kind NOT NULL DEFAULT 'invoice',
  doc_no              text UNIQUE,
  doc_date            date NOT NULL DEFAULT CURRENT_DATE,
  status              doc_status NOT NULL DEFAULT 'draft',
  customer_id         uuid NOT NULL REFERENCES companies(id),
  contact_id          uuid REFERENCES contacts(id),
  quotation_id        uuid REFERENCES quotations(id),
  -- credit notes must reference the invoice they reverse (GSTR-1 requirement)
  against_invoice_id  uuid REFERENCES invoices(id),
  source_warehouse_id uuid REFERENCES warehouses(id),  -- stock issued from here
  company_gstin       text,
  customer_gstin      text,
  place_of_supply     text NOT NULL,
  is_inter_state      boolean NOT NULL DEFAULT false,
  due_date            date,
  subtotal            numeric(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total      numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  taxable_total       numeric(15,2) NOT NULL DEFAULT 0 CHECK (taxable_total >= 0),
  cgst_total          numeric(15,2) NOT NULL DEFAULT 0 CHECK (cgst_total >= 0),
  sgst_total          numeric(15,2) NOT NULL DEFAULT 0 CHECK (sgst_total >= 0),
  igst_total          numeric(15,2) NOT NULL DEFAULT 0 CHECK (igst_total >= 0),
  rounding_adjustment numeric(4,2)  NOT NULL DEFAULT 0 CHECK (rounding_adjustment BETWEEN -0.99 AND 0.99),
  grand_total         numeric(15,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  -- e-invoicing (nullable until applicable; populated post-IRP registration)
  irn                 text UNIQUE,
  irn_ack_no          text,
  irn_ack_date        timestamptz,
  signed_qr           text,
  terms               text,
  notes               text,
  journal_entry_id    uuid REFERENCES journal_entries(id),  -- set at submission
  submitted_by        uuid REFERENCES users(id),
  submitted_at        timestamptz,
  cancelled_by        uuid REFERENCES users(id),
  cancelled_at        timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_split_consistent CHECK (
    (is_inter_state AND cgst_total = 0 AND sgst_total = 0)
    OR (NOT is_inter_state AND igst_total = 0)),
  CONSTRAINT submitted_has_no      CHECK (status = 'draft' OR doc_no IS NOT NULL),
  CONSTRAINT submitted_is_booked   CHECK (status <> 'submitted' OR journal_entry_id IS NOT NULL),
  CONSTRAINT credit_note_reference CHECK (kind <> 'credit_note' OR against_invoice_id IS NOT NULL)
);
ALTER TABLE quotations
  ADD CONSTRAINT fk_qtn_converted_invoice
  FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id);

CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status   ON invoices(status, doc_date);
CREATE INDEX idx_invoices_due      ON invoices(due_date) WHERE status = 'submitted';
CREATE TRIGGER trg_inv_updated BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_inv_audit AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES items(id),
  description   text NOT NULL,
  hsn_sac_code  text NOT NULL,
  qty           numeric(12,3) NOT NULL CHECK (qty > 0),
  uom           text NOT NULL DEFAULT 'Nos',
  rate          numeric(15,2) NOT NULL CHECK (rate >= 0),
  discount_pct  numeric(5,2)  NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  taxable_value numeric(15,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate      numeric(5,2)  NOT NULL,
  cgst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  sgst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  igst_amount   numeric(15,2) NOT NULL DEFAULT 0,
  line_total    numeric(15,2) NOT NULL,
  sort_order    smallint NOT NULL DEFAULT 0
);
CREATE INDEX idx_inv_lines ON invoice_lines(invoice_id);

-- Submitted/cancelled sales documents are immutable except for the
-- explicitly whitelisted transitions (cancellation; IRN fields on invoices,
-- which arrive AFTER submission from the IRP; quotation conversion link).
CREATE OR REPLACE FUNCTION fn_sales_doc_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  guard text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '% % cannot be deleted once submitted; cancel it instead',
        TG_TABLE_NAME, OLD.doc_no;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'invoices' THEN
    guard := ARRAY['status','cancelled_by','cancelled_at','updated_at',
                   'irn','irn_ack_no','irn_ack_date','signed_qr'];
  ELSE
    guard := ARRAY['status','cancelled_by','cancelled_at','updated_at',
                   'converted_invoice_id'];
  END IF;

  IF (to_jsonb(OLD) - guard) = (to_jsonb(NEW) - guard)
     AND (NEW.status = OLD.status OR (OLD.status = 'submitted' AND NEW.status = 'cancelled')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% % is immutable after submission', TG_TABLE_NAME, OLD.doc_no;
END $$;

CREATE TRIGGER trg_qtn_immutable BEFORE UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION fn_sales_doc_immutable();
CREATE TRIGGER trg_inv_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_sales_doc_immutable();

-- Lines of submitted sales documents are frozen
CREATE OR REPLACE FUNCTION fn_sales_lines_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status doc_status;
BEGIN
  IF TG_TABLE_NAME = 'invoice_lines' THEN
    SELECT status INTO v_status FROM invoices
     WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  ELSE
    SELECT status INTO v_status FROM quotations
     WHERE id = COALESCE(NEW.quotation_id, OLD.quotation_id);
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines are immutable once the document is %', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_inv_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_sales_lines_frozen();
CREATE TRIGGER trg_qtn_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION fn_sales_lines_frozen();

-- ---------------------------------------------------------------------------
-- Payments in: header + allocations against invoices
-- ---------------------------------------------------------------------------
CREATE TABLE payment_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no           text UNIQUE,
  doc_date         date NOT NULL DEFAULT CURRENT_DATE,
  status           doc_status NOT NULL DEFAULT 'draft',
  customer_id      uuid NOT NULL REFERENCES companies(id),
  amount           numeric(15,2) NOT NULL CHECK (amount > 0),
  mode             text NOT NULL CHECK (mode IN ('cash','bank_transfer','upi','cheque','card')),
  reference_no     text,                       -- UTR / cheque no
  deposit_account_id uuid NOT NULL REFERENCES accounts(id),  -- Cash or Bank
  journal_entry_id uuid REFERENCES journal_entries(id),
  notes            text,
  submitted_by     uuid REFERENCES users(id),
  submitted_at     timestamptz,
  cancelled_by     uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submitted_has_no    CHECK (status = 'draft' OR doc_no IS NOT NULL),
  CONSTRAINT submitted_is_booked CHECK (status <> 'submitted' OR journal_entry_id IS NOT NULL)
);
CREATE INDEX idx_payments_customer ON payment_entries(customer_id);
CREATE TRIGGER trg_pay_updated BEFORE UPDATE ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_pay_audit AFTER INSERT OR UPDATE OR DELETE ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE payment_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_entry_id uuid NOT NULL REFERENCES payment_entries(id) ON DELETE CASCADE,
  invoice_id       uuid NOT NULL REFERENCES invoices(id),
  allocated_amount numeric(15,2) NOT NULL CHECK (allocated_amount > 0),
  UNIQUE (payment_entry_id, invoice_id)
);
CREATE INDEX idx_alloc_invoice ON payment_allocations(invoice_id);

-- Allocations must not exceed the payment amount (deferred: lines first, check at commit)
CREATE OR REPLACE FUNCTION fn_alloc_within_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_amount numeric(15,2);
  v_alloc  numeric(15,2);
BEGIN
  SELECT amount INTO v_amount FROM payment_entries WHERE id = NEW.payment_entry_id;
  SELECT COALESCE(sum(allocated_amount),0) INTO v_alloc
    FROM payment_allocations WHERE payment_entry_id = NEW.payment_entry_id;
  IF v_alloc > v_amount THEN
    RAISE EXCEPTION 'Allocations (%) exceed payment amount (%)', v_alloc, v_amount;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_alloc_within
  AFTER INSERT OR UPDATE ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_alloc_within_payment();

-- ============================================================================
-- SECTION 7: STOCK LEDGER (append-only) + item_warehouse cache/lock anchor
-- ============================================================================

CREATE TABLE item_warehouse (
  item_id        uuid NOT NULL REFERENCES items(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  qty_on_hand    numeric(12,3) NOT NULL DEFAULT 0,
  valuation_rate numeric(15,2) NOT NULL DEFAULT 0 CHECK (valuation_rate >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, warehouse_id)
);
-- NOTE: the application MUST `SELECT ... FOR UPDATE` this row before writing
-- any stock_ledger_entries for the (item, warehouse) pair. That serializes
-- concurrent movements and makes the running balances race-free.

CREATE TABLE stock_ledger_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id           uuid NOT NULL REFERENCES items(id),
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  posting_datetime  timestamptz NOT NULL DEFAULT now(),
  voucher_type      voucher_type NOT NULL,
  voucher_id        uuid NOT NULL,
  qty_change        numeric(12,3) NOT NULL CHECK (qty_change <> 0),
  incoming_rate     numeric(15,2) CHECK (incoming_rate IS NULL OR incoming_rate >= 0),
  valuation_rate    numeric(15,2) NOT NULL CHECK (valuation_rate >= 0),  -- rate AFTER this entry
  qty_after         numeric(12,3) NOT NULL,
  stock_value_after numeric(15,2) NOT NULL CHECK (stock_value_after >= 0),
  created_by        uuid REFERENCES users(id),
  CONSTRAINT receipts_have_rate CHECK (qty_change < 0 OR incoming_rate IS NOT NULL)
);
CREATE INDEX idx_sle_item_wh  ON stock_ledger_entries(item_id, warehouse_id, posting_datetime);
CREATE INDEX idx_sle_voucher  ON stock_ledger_entries(voucher_type, voucher_id);

-- (a) Append-only: no UPDATE or DELETE, ever. Reversals are new rows.
CREATE TRIGGER trg_sle_immutable BEFORE UPDATE OR DELETE ON stock_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

-- (b) Negative-stock guard + cache maintenance.
--     qty_after/valuation_rate are computed by the application (which holds
--     the item_warehouse lock); the trigger VERIFIES the arithmetic and
--     keeps the cache in sync — defense in depth.
CREATE OR REPLACE FUNCTION fn_sle_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev_qty   numeric(12,3);
  v_allow_neg  boolean;
BEGIN
  INSERT INTO item_warehouse (item_id, warehouse_id)
  VALUES (NEW.item_id, NEW.warehouse_id)
  ON CONFLICT (item_id, warehouse_id) DO NOTHING;

  SELECT qty_on_hand INTO v_prev_qty
    FROM item_warehouse
   WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id
   FOR UPDATE;  -- no-op if app already holds it (same tx), safety net if not

  IF v_prev_qty + NEW.qty_change <> NEW.qty_after THEN
    RAISE EXCEPTION 'Stock ledger arithmetic error: % + % <> %',
      v_prev_qty, NEW.qty_change, NEW.qty_after;
  END IF;

  IF NEW.qty_after < 0 THEN
    SELECT allow_negative_stock INTO v_allow_neg FROM company_settings WHERE id = 1;
    IF NOT COALESCE(v_allow_neg, false) THEN
      RAISE EXCEPTION 'Insufficient stock: item % in warehouse % would go to %',
        NEW.item_id, NEW.warehouse_id, NEW.qty_after
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  UPDATE item_warehouse
     SET qty_on_hand    = NEW.qty_after,
         valuation_rate = NEW.valuation_rate,
         updated_at     = now()
   WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id;

  RETURN NEW;
END $$;
CREATE TRIGGER trg_sle_apply BEFORE INSERT ON stock_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_sle_apply();

-- ---------------------------------------------------------------------------
-- Inventory documents: purchase receipts & stock adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no           text UNIQUE,
  doc_date         date NOT NULL DEFAULT CURRENT_DATE,
  status           doc_status NOT NULL DEFAULT 'draft',
  supplier_id      uuid NOT NULL REFERENCES companies(id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  supplier_inv_no  text,
  total_value      numeric(15,2) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  journal_entry_id uuid REFERENCES journal_entries(id),
  notes            text,
  submitted_by     uuid REFERENCES users(id),
  submitted_at     timestamptz,
  cancelled_by     uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submitted_has_no CHECK (status = 'draft' OR doc_no IS NOT NULL)
);
CREATE TRIGGER trg_pr_updated BEFORE UPDATE ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_pr_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

CREATE TABLE purchase_receipt_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_receipt_id uuid NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  item_id             uuid NOT NULL REFERENCES items(id),
  qty                 numeric(12,3) NOT NULL CHECK (qty > 0),
  rate                numeric(15,2) NOT NULL CHECK (rate >= 0),
  amount              numeric(15,2) NOT NULL CHECK (amount >= 0)
);
CREATE INDEX idx_pr_lines ON purchase_receipt_lines(purchase_receipt_id);

CREATE TABLE stock_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no       text UNIQUE,
  doc_date     date NOT NULL DEFAULT CURRENT_DATE,
  status       doc_status NOT NULL DEFAULT 'draft',
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  reason       text NOT NULL CHECK (reason IN ('physical_count','damage','theft','expiry','correction','other')),
  notes        text,
  journal_entry_id uuid REFERENCES journal_entries(id),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submitted_has_no CHECK (status = 'draft' OR doc_no IS NOT NULL)
);
CREATE TRIGGER trg_adj_updated BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE stock_adjustment_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_adjustment_id uuid NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  item_id             uuid NOT NULL REFERENCES items(id),
  qty_change          numeric(12,3) NOT NULL CHECK (qty_change <> 0),
  rate                numeric(15,2) CHECK (rate IS NULL OR rate >= 0)  -- required for positive adjustments
);

-- ============================================================================
-- SECTION 8: DERIVED VIEWS — balances are always computed, never trusted
-- ============================================================================

-- Account balances (signed by accounting convention)
CREATE VIEW v_account_balances AS
SELECT a.id, a.code, a.name, a.type,
       COALESCE(sum(jl.debit), 0)                       AS total_debit,
       COALESCE(sum(jl.credit), 0)                      AS total_credit,
       COALESCE(sum(jl.debit), 0) - COALESCE(sum(jl.credit), 0) AS balance
FROM accounts a
LEFT JOIN journal_lines jl   ON jl.account_id = a.id
LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
WHERE NOT a.is_group
GROUP BY a.id;

-- Party (customer/supplier) balances — the receivables/payables sub-ledger
CREATE VIEW v_party_balances AS
SELECT jl.party_type, jl.party_id, c.name AS party_name,
       sum(jl.debit) - sum(jl.credit) AS balance   -- +ve = they owe us
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
JOIN companies c        ON c.id = jl.party_id
WHERE jl.party_id IS NOT NULL
GROUP BY jl.party_type, jl.party_id, c.name;

-- Invoice outstanding = grand total − allocations from submitted payments
CREATE VIEW v_invoice_outstanding AS
SELECT i.id, i.doc_no, i.customer_id, i.doc_date, i.due_date, i.grand_total,
       COALESCE(p.paid, 0)                  AS amount_paid,
       i.grand_total - COALESCE(p.paid, 0)  AS outstanding,
       CASE
         WHEN i.grand_total - COALESCE(p.paid,0) <= 0 THEN 'paid'
         WHEN COALESCE(p.paid,0) > 0                  THEN 'partially_paid'
         WHEN i.due_date < CURRENT_DATE               THEN 'overdue'
         ELSE 'unpaid'
       END AS payment_status
FROM invoices i
LEFT JOIN (
  SELECT pa.invoice_id, sum(pa.allocated_amount) AS paid
  FROM payment_allocations pa
  JOIN payment_entries pe ON pe.id = pa.payment_entry_id AND pe.status = 'submitted'
  GROUP BY pa.invoice_id
) p ON p.invoice_id = i.id
WHERE i.status = 'submitted' AND i.kind = 'invoice';

-- Receivables aging buckets
CREATE VIEW v_receivables_aging AS
SELECT customer_id,
       sum(outstanding) FILTER (WHERE CURRENT_DATE - due_date <= 0)                    AS current,
       sum(outstanding) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 1  AND 30)       AS d1_30,
       sum(outstanding) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 31 AND 60)       AS d31_60,
       sum(outstanding) FILTER (WHERE CURRENT_DATE - due_date BETWEEN 61 AND 90)       AS d61_90,
       sum(outstanding) FILTER (WHERE CURRENT_DATE - due_date > 90)                    AS d90_plus,
       sum(outstanding)                                                                AS total
FROM v_invoice_outstanding
WHERE outstanding > 0
GROUP BY customer_id;

-- Stock on hand straight from the ledger (the source of truth)
CREATE VIEW v_stock_on_hand AS
SELECT sle.item_id, i.sku, i.name, sle.warehouse_id, w.name AS warehouse,
       sum(sle.qty_change) AS qty_on_hand,
       (array_agg(sle.valuation_rate ORDER BY sle.posting_datetime DESC, sle.id DESC))[1]
         AS valuation_rate,
       (array_agg(sle.stock_value_after ORDER BY sle.posting_datetime DESC, sle.id DESC))[1]
         AS stock_value
FROM stock_ledger_entries sle
JOIN items i      ON i.id = sle.item_id
JOIN warehouses w ON w.id = sle.warehouse_id
GROUP BY sle.item_id, i.sku, i.name, sle.warehouse_id, w.name;

-- GSTR-1 style B2B register (rate-wise per invoice)
CREATE VIEW v_gst_sales_register AS
SELECT i.doc_no, i.doc_date, i.kind, c.name AS customer, i.customer_gstin,
       i.place_of_supply, i.is_inter_state,
       il.gst_rate,
       sum(il.taxable_value) AS taxable_value,
       sum(il.cgst_amount)   AS cgst,
       sum(il.sgst_amount)   AS sgst,
       sum(il.igst_amount)   AS igst,
       i.irn
FROM invoices i
JOIN companies c      ON c.id = i.customer_id
JOIN invoice_lines il ON il.invoice_id = i.id
WHERE i.status = 'submitted'
GROUP BY i.id, c.name, il.gst_rate;

-- ============================================================================
-- SECTION 9: INTEGRITY VERIFICATION (run nightly by pg-boss job)
-- ============================================================================

-- 9a. The whole GL must sum to zero and every posted entry must balance.
CREATE OR REPLACE FUNCTION fn_verify_gl()
RETURNS TABLE (check_name text, ok boolean, detail text)
LANGUAGE plpgsql AS $$
DECLARE
  v_diff numeric;
  v_bad  bigint;
BEGIN
  SELECT COALESCE(sum(jl.debit) - sum(jl.credit), 0) INTO v_diff
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  WHERE je.status = 'posted';
  RETURN QUERY SELECT 'gl_sums_to_zero', v_diff = 0,
                      'net difference = ' || v_diff::text;

  SELECT count(*) INTO v_bad FROM (
    SELECT jl.journal_entry_id
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.status = 'posted'
    GROUP BY jl.journal_entry_id
    HAVING sum(jl.debit) <> sum(jl.credit)
  ) x;
  RETURN QUERY SELECT 'every_entry_balanced', v_bad = 0,
                      v_bad::text || ' unbalanced entries';
END $$;

-- 9b. item_warehouse cache must equal the stock ledger sums.
CREATE OR REPLACE FUNCTION fn_verify_stock_cache()
RETURNS TABLE (item_id uuid, warehouse_id uuid, cached numeric, actual numeric)
LANGUAGE sql AS $$
  SELECT iw.item_id, iw.warehouse_id, iw.qty_on_hand,
         COALESCE(s.qty, 0)
  FROM item_warehouse iw
  LEFT JOIN (
    SELECT sle.item_id, sle.warehouse_id, sum(sle.qty_change) AS qty
    FROM stock_ledger_entries sle
    GROUP BY sle.item_id, sle.warehouse_id
  ) s ON s.item_id = iw.item_id AND s.warehouse_id = iw.warehouse_id
  WHERE iw.qty_on_hand <> COALESCE(s.qty, 0)
$$;

-- ============================================================================
-- SECTION 10: SEED DATA — roles, stages, sequences, Indian chart of accounts
-- ============================================================================

INSERT INTO roles (name, description) VALUES
  ('admin',     'Full access including cancellations and chart of accounts'),
  ('accounts',  'Accounting, invoicing, payments'),
  ('sales',     'CRM, quotations, invoices (draft)'),
  ('inventory', 'Stock documents and item masters'),
  ('readonly',  'Read-only across all modules');

INSERT INTO role_permissions (role_id, module, can_read, can_write, can_submit, can_cancel)
SELECT r.id, m.module,
       true,
       r.name <> 'readonly' AND (r.name = 'admin' OR m.module = ANY (
         CASE r.name
           WHEN 'accounts'  THEN ARRAY['accounting','invoicing','sales']
           WHEN 'sales'     THEN ARRAY['crm','sales','invoicing']
           WHEN 'inventory' THEN ARRAY['inventory']
           ELSE ARRAY[]::text[]
         END)),
       -- Eng review D4 (2026-07-04): counter staff ('sales' role) can SUBMIT invoices —
       -- sales complete at the counter; errors are caught by same-day bill-book
       -- reconciliation + weekly attribution review, fixed by reversal. Cancel stays admin-only.
       r.name IN ('admin','accounts')
         OR (r.name = 'sales' AND m.module IN ('crm','sales','invoicing'))
         OR (r.name = 'inventory' AND m.module = 'inventory'),
       r.name = 'admin'
FROM roles r
CROSS JOIN (VALUES ('core'),('crm'),('sales'),('invoicing'),('accounting'),('inventory')) AS m(module);

INSERT INTO pipeline_stages (name, sort_order, default_probability) VALUES
  ('New',           1, 10),
  ('Qualified',     2, 30),
  ('Proposal Sent', 3, 50),
  ('Negotiation',   4, 70),
  ('Won',           5, 100),
  ('Lost',          6, 0);

INSERT INTO document_sequences (series, prefix, padding) VALUES
  ('QTN-2026', 'QTN-2026-', 5),
  ('INV-2026', 'INV-2026-', 5),
  ('CRN-2026', 'CRN-2026-', 5),
  ('PAY-2026', 'PAY-2026-', 5),
  ('JV-2026',  'JV-2026-',  5),
  ('PRC-2026', 'PRC-2026-', 5),
  ('ADJ-2026', 'ADJ-2026-', 5);

-- Compact Indian chart of accounts. Group accounts first, then leaves.
INSERT INTO accounts (code, name, type, is_group, system_key) VALUES
  ('1000', 'Assets',                    'asset',     true,  NULL),
  ('2000', 'Liabilities',               'liability', true,  NULL),
  ('3000', 'Equity',                    'equity',    true,  NULL),
  ('4000', 'Income',                    'income',    true,  NULL),
  ('5000', 'Expenses',                  'expense',   true,  NULL);

INSERT INTO accounts (code, name, type, is_group, system_key, parent_id) VALUES
  ('1100', 'Cash',                      'asset', false, 'cash',              (SELECT id FROM accounts WHERE code='1000')),
  ('1200', 'Bank',                      'asset', false, 'bank',              (SELECT id FROM accounts WHERE code='1000')),
  ('1300', 'Debtors (Receivables)',     'asset', false, 'debtors',           (SELECT id FROM accounts WHERE code='1000')),
  ('1400', 'Stock in Hand',             'asset', false, 'stock_in_hand',     (SELECT id FROM accounts WHERE code='1000')),
  ('1510', 'GST Input CGST',            'asset', false, 'gst_input_cgst',    (SELECT id FROM accounts WHERE code='1000')),
  ('1520', 'GST Input SGST',            'asset', false, 'gst_input_sgst',    (SELECT id FROM accounts WHERE code='1000')),
  ('1530', 'GST Input IGST',            'asset', false, 'gst_input_igst',    (SELECT id FROM accounts WHERE code='1000')),
  ('2100', 'Creditors (Payables)',      'liability', false, 'creditors',     (SELECT id FROM accounts WHERE code='2000')),
  ('2210', 'GST Output CGST',           'liability', false, 'gst_output_cgst',(SELECT id FROM accounts WHERE code='2000')),
  ('2220', 'GST Output SGST',           'liability', false, 'gst_output_sgst',(SELECT id FROM accounts WHERE code='2000')),
  ('2230', 'GST Output IGST',           'liability', false, 'gst_output_igst',(SELECT id FROM accounts WHERE code='2000')),
  ('2300', 'Stock Received Not Billed', 'liability', false, 'srnb',          (SELECT id FROM accounts WHERE code='2000')),
  ('3100', 'Capital',                   'equity', false, 'capital',          (SELECT id FROM accounts WHERE code='3000')),
  ('3200', 'Retained Earnings',         'equity', false, 'retained_earnings',(SELECT id FROM accounts WHERE code='3000')),
  -- Opening Balances: counter-account for bill-book-era dues entered at go-live
  -- (Dr Debtors[party] / Cr 3300 per debtor). Tally-style opening equity — keeps
  -- pre-system receivables out of Capital. Party-level lumps by design; see TODOS.md #2.
  ('3300', 'Opening Balances',          'equity', false, 'opening_balance', (SELECT id FROM accounts WHERE code='3000')),
  ('4100', 'Sales',                     'income', false, 'sales',            (SELECT id FROM accounts WHERE code='4000')),
  ('4200', 'Other Income',              'income', false, NULL,               (SELECT id FROM accounts WHERE code='4000')),
  ('4300', 'Rounding Adjustments',      'income', false, 'rounding',         (SELECT id FROM accounts WHERE code='4000')),
  ('5100', 'Cost of Goods Sold',        'expense', false, 'cogs',            (SELECT id FROM accounts WHERE code='5000')),
  ('5200', 'Stock Adjustment Expense',  'expense', false, 'stock_adjustment',(SELECT id FROM accounts WHERE code='5000')),
  ('5300', 'Rent',                      'expense', false, NULL,              (SELECT id FROM accounts WHERE code='5000')),
  ('5400', 'Salaries',                  'expense', false, NULL,              (SELECT id FROM accounts WHERE code='5000')),
  ('5500', 'Office & Misc Expenses',    'expense', false, NULL,              (SELECT id FROM accounts WHERE code='5000'));

COMMIT;

-- ============================================================================
-- USAGE NOTES FOR THE APPLICATION LAYER
-- ============================================================================
-- 1. Per request transaction:   BEGIN; SET LOCAL app.user_id = '<uuid>'; ... COMMIT;
-- 2. Submitting an invoice (pseudo-order inside ONE transaction):
--      a. SELECT ... FOR UPDATE on item_warehouse rows for all stock lines
--         (ORDER BY item_id, warehouse_id — consistent order avoids deadlocks)
--      b. doc_no := next_doc_number('INV-2026')
--      c. INSERT journal_entries (status='draft'), INSERT journal_lines
--         (Dr Debtors[party] / Cr Sales, Cr GST Output...), then
--         UPDATE journal_entries SET status='posted', entry_no=next_doc_number('JV-2026'),
--         posted_by, posted_at.  (Lines can only be written while draft;
--         flipping to 'posted' arms the deferred balance check.)
--      d. INSERT stock_ledger_entries (issues at current valuation_rate)
--      e. Second journal entry, same draft->lines->posted flow:
--         Dr COGS / Cr Stock in Hand (at issue value)
--      f. UPDATE invoices SET status='submitted', doc_no, journal_entry_id...
--      g. COMMIT — the deferred balance triggers verify (c) and (e) here.
-- 3. Cancelling an invoice = reversal journal entry + opposite stock entries
--    + UPDATE invoices SET status='cancelled' — never deletion.
-- 4. Nightly: SELECT * FROM fn_verify_gl(); SELECT * FROM fn_verify_stock_cache();
--    Alert on any non-ok row.
