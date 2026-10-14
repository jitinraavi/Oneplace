-- ============================================================================
-- One Place: US Parcel GIS, County Records, Gated Offers & Property Bidding
-- PostgreSQL 16 + PostGIS 3.4 Schema & Security Triggers
-- ============================================================================

-- Enable PostGIS and cryptographic extensions for One Place
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Users & KYC / Proof of Funds Verification
-- ----------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('BUYER', 'OWNER', 'BOTH', 'ADMIN');
CREATE TYPE kyc_status AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_hash VARCHAR(255),
    full_name VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'BUYER',
    kyc_status kyc_status NOT NULL DEFAULT 'UNVERIFIED',
    kyc_provider_ref VARCHAR(128),
    pof_verified_amount_cents BIGINT DEFAULT 0,
    pof_verified_until TIMESTAMPTZ,
    mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. US Parcels (PostGIS MultiPolygon) & Official County Records
-- ----------------------------------------------------------------------------
CREATE TABLE parcels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fips_code VARCHAR(10) NOT NULL, -- 5-digit US State+County FIPS
    apn VARCHAR(64) NOT NULL,       -- County Assessor Parcel Number
    situs_address TEXT,
    city VARCHAR(128),
    state_code CHAR(2) NOT NULL,
    zip_code VARCHAR(10),
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL, -- Exact parcel boundary polygon
    centroid GEOMETRY(Point, 4326) NOT NULL,    -- Precomputed centroid for fast markers
    lot_size_sqft NUMERIC(14, 2),
    lot_size_acres NUMERIC(12, 4),
    zoning_code VARCHAR(64),
    land_use_category VARCHAR(128),
    building_sqft NUMERIC(12, 2),
    year_built SMALLINT,
    stories NUMERIC(4, 1),
    flood_zone VARCHAR(32),
    verified_owner_user_id UUID REFERENCES users(id),
    last_county_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fips_code, apn)
);

-- Spatial GiST indexes for sub-50ms Google Maps / Earth click & viewport queries
CREATE INDEX idx_parcels_geom ON parcels USING GIST (geom);
CREATE INDEX idx_parcels_centroid ON parcels USING GIST (centroid);
CREATE INDEX idx_parcels_fips_apn ON parcels (fips_code, apn);

-- Confidential & Public County Assessor Details (PII Separated)
CREATE TABLE county_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id UUID NOT NULL UNIQUE REFERENCES parcels(id) ON DELETE CASCADE,
    legal_description TEXT,
    assessed_land_value_cents BIGINT,
    assessed_improvement_value_cents BIGINT,
    total_assessed_value_cents BIGINT,
    annual_tax_amount_cents BIGINT,
    tax_year SMALLINT,
    last_sale_date DATE,
    last_sale_price_cents BIGINT,
    deed_book_page VARCHAR(128),
    owner_of_record_name VARCHAR(255) NOT NULL, -- Public entity/owner name per county
    encrypted_tax_mailing_address BYTEA,        -- AES-256-GCM encrypted (used only for mail PIN verification)
    tax_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    deed_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. Multi-Factor Property Ownership Claim Verification
-- ----------------------------------------------------------------------------
CREATE TYPE claim_status AS ENUM ('PENDING_KYC', 'PENDING_MAIL_PIN', 'PENDING_TITLE_REVIEW', 'VERIFIED', 'REVOKED');

CREATE TABLE property_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id UUID NOT NULL REFERENCES parcels(id),
    claimant_user_id UUID NOT NULL REFERENCES users(id),
    status claim_status NOT NULL DEFAULT 'PENDING_KYC',
    deed_document_s3_key TEXT,
    mail_pin_bcrypt_hash TEXT,
    mail_pin_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parcel_id, claimant_user_id)
);

-- ----------------------------------------------------------------------------
-- 4. Request-Gated Messaging & Direct Purchase Offers
-- ----------------------------------------------------------------------------
CREATE TYPE request_gate_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'BLOCKED');
CREATE TYPE financing_type AS ENUM ('CASH', 'CONVENTIONAL', 'COMMERCIAL_LOAN', 'SELLER_FINANCING');

CREATE TABLE message_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id UUID NOT NULL REFERENCES parcels(id),
    buyer_user_id UUID NOT NULL REFERENCES users(id),
    owner_user_id UUID REFERENCES users(id),
    status request_gate_status NOT NULL DEFAULT 'PENDING',
    initial_offer_price_cents BIGINT NOT NULL CHECK (initial_offer_price_cents > 0),
    financing financing_type NOT NULL DEFAULT 'CASH',
    earnest_money_cents BIGINT,
    proposed_closing_days SMALLINT DEFAULT 30,
    intro_message TEXT NOT NULL CHECK (char_length(intro_message) <= 1000),
    buyer_pof_snapshot_cents BIGINT NOT NULL DEFAULT 0,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parcel_id, buyer_user_id) -- Prevents buyer spam: 1 request thread per parcel
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_request_id UUID NOT NULL REFERENCES message_requests(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES users(id),
    body_ciphertext BYTEA NOT NULL, -- Encrypted message payload
    counter_offer_price_cents BIGINT, -- Optional structured counter-offer in thread
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce Gated Messaging at the PostgreSQL Database Layer via Trigger / Policy
CREATE OR REPLACE FUNCTION enforce_message_request_gate()
RETURNS TRIGGER AS $$
DECLARE
    req_status request_gate_status;
BEGIN
    SELECT status INTO req_status
    FROM message_requests
    WHERE id = NEW.message_request_id;

    IF req_status IS DISTINCT FROM 'ACCEPTED' THEN
        RAISE EXCEPTION 'ONE_PLACE_SECURITY_GATE: Messaging is locked until the property owner accepts the request.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_message_gate
BEFORE INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION enforce_message_request_gate();

-- ----------------------------------------------------------------------------
-- 5. Owner-Initiated Property Auctions, Entry Fees & Terms Acceptance
-- ----------------------------------------------------------------------------
CREATE TYPE auction_status AS ENUM ('DRAFT', 'PUBLISHED', 'LIVE', 'EXTENDED', 'CLOSED', 'SETTLED', 'CANCELLED');

CREATE TABLE auctions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id UUID NOT NULL REFERENCES parcels(id),
    seller_user_id UUID NOT NULL REFERENCES users(id),
    status auction_status NOT NULL DEFAULT 'DRAFT',
    starting_bid_cents BIGINT NOT NULL CHECK (starting_bid_cents > 0),
    reserve_price_cents BIGINT,
    min_increment_cents BIGINT NOT NULL CHECK (min_increment_cents > 0),
    entry_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee_cents >= 0),
    entry_fee_refundable BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    soft_close_window_seconds INTEGER NOT NULL DEFAULT 180,    -- Last 3 mins
    soft_close_extension_seconds INTEGER NOT NULL DEFAULT 180, -- Extend by 3 mins
    highest_bid_id UUID,
    highest_bid_cents BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_at > starts_at)
);

CREATE TABLE auction_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    terms_markdown TEXT NOT NULL,
    terms_sha256_hash CHAR(64) NOT NULL, -- Cryptographic hash of exact T&C text
    earnest_deposit_percent NUMERIC(5, 2) NOT NULL DEFAULT 5.00,
    closing_window_days SMALLINT NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (auction_id, version)
);

-- Bidder Onboarding Gate: Entry Fee + Signed T&C Audit Record
CREATE TYPE payment_hold_status AS ENUM ('REQUIRES_PAYMENT', 'AUTHORIZED_HOLD', 'CAPTURED', 'REFUNDED', 'FAILED');

CREATE TABLE bidder_qualifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id),
    bidder_user_id UUID NOT NULL REFERENCES users(id),
    auction_terms_id UUID NOT NULL REFERENCES auction_terms(id),
    accepted_terms_sha256 CHAR(64) NOT NULL,
    signer_ip_address INET NOT NULL,
    signer_user_agent TEXT NOT NULL,
    signer_device_fingerprint VARCHAR(128) NOT NULL,
    terms_signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stripe_payment_intent_id VARCHAR(128) UNIQUE NOT NULL,
    entry_fee_status payment_hold_status NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    qualified_at TIMESTAMPTZ,
    UNIQUE (auction_id, bidder_user_id)
);

CREATE TABLE bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id),
    bidder_user_id UUID NOT NULL REFERENCES users(id),
    qualification_id UUID NOT NULL REFERENCES bidder_qualifications(id),
    bid_amount_cents BIGINT NOT NULL,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    source_ip INET NOT NULL,
    device_fingerprint VARCHAR(128) NOT NULL,
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    prev_bid_hash CHAR(64), -- Chained hash for tamper-evident audit log
    record_hash CHAR(64) NOT NULL
);

CREATE INDEX idx_bids_auction_amount ON bids (auction_id, bid_amount_cents DESC);
