-- ============================================================================
-- Begility Lead Engine — initial schema
-- Target: Neon Postgres (>=15)
-- Run against DIRECT_URL, not the pooler endpoint.
-- ============================================================================

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "LeadStatus" AS ENUM (
  'new_lead',
  'enriching',
  'verifying',
  'verification_failed',
  'needs_review',
  'waiting_concierge',
  'draft_created',
  'exclude',
  'outreach_sent',
  'interested',
  'not_interested',
  'follow_up_queued',
  'follow_up_sent',
  'rejected',
  'suppressed'
);

CREATE TYPE "Tier" AS ENUM ('Tier1', 'Tier2', 'Exclude');

CREATE TYPE "DiscoverySource" AS ENUM (
  'google_maps',
  'linkedin',
  'job_board',
  'manual',
  'import'
);

CREATE TYPE "SuppressionReason" AS ENUM ('replied', 'bounced', 'manual');

CREATE TYPE "FollowUpStatus" AS ENUM ('pending', 'approved', 'rejected');

-- ── Lead ───────────────────────────────────────────────────────────────────
CREATE TABLE "Lead" (
  "id"                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "createdAt"             TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3)    NOT NULL,

  "status"                "LeadStatus"    NOT NULL DEFAULT 'new_lead',
  "enrichmentLock"        BOOLEAN         NOT NULL DEFAULT FALSE,

  "discoverySource"       "DiscoverySource" NOT NULL DEFAULT 'manual',
  "discoveryQuery"        TEXT,
  "discoveryRunId"        UUID,
  "googlePlaceId"         TEXT,

  "businessName"          TEXT            NOT NULL,
  "normalizedName"        TEXT,
  "websiteDomain"         TEXT,
  "city"                  TEXT,
  "country"               TEXT,
  "address"               TEXT,
  "googleRating"          DOUBLE PRECISION,
  "websiteUrl"            TEXT,
  "geminiResearchJson"    JSONB,
  "ownerName"             TEXT,
  "website"               TEXT,
  "email"                 TEXT,
  "phone"                 TEXT,
  "linkedin"              TEXT,
  "instagram"             TEXT,
  "sector"                TEXT,
  "employeeCountEstimate" TEXT,
  "techStackSignals"      TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
  "operationalSignals"    TEXT[]          NOT NULL DEFAULT ARRAY[]::TEXT[],
  "businessDescription"   TEXT,
  "searchConfidence"      INTEGER,

  "emailVerified"         BOOLEAN         NOT NULL DEFAULT FALSE,
  "emailVerifiedAt"       TIMESTAMP(3),
  "mxValid"               BOOLEAN,
  "smtpValid"             BOOLEAN,
  "isCatchAll"            BOOLEAN,
  "verificationScore"     INTEGER,

  "brandFitScore"         INTEGER,
  "brandFitRationale"     TEXT,
  "primaryPainHypothesis" TEXT,
  "suggestedLane"         TEXT,
  "tier"                  "Tier",
  "draftSubject"          TEXT,
  "draftBodyHtml"         TEXT,
  "outlookDraftId"        TEXT,

  "draftCreatedAt"        TIMESTAMP(3),
  "lastContactedAt"       TIMESTAMP(3),
  "sentBy"                TEXT,
  "replyReceived"         BOOLEAN         NOT NULL DEFAULT FALSE,
  "replyBody"             TEXT,
  "replySentiment"        TEXT,
  "replyReasoning"        TEXT,
  "lastReplyAt"           TIMESTAMP(3),

  "followUpDraftId"       TEXT,
  "followUpQueuedAt"      TIMESTAMP(3),

  "teamsCardActivityId"   TEXT,

  "notes"                 TEXT
);

CREATE UNIQUE INDEX "Lead_googlePlaceId_key"            ON "Lead"("googlePlaceId");
CREATE        INDEX "Lead_status_discoverySource_idx"  ON "Lead"("status", "discoverySource");
CREATE        INDEX "Lead_status_enrichmentLock_idx"   ON "Lead"("status", "enrichmentLock");
CREATE        INDEX "Lead_email_idx"                   ON "Lead"("email");
CREATE        INDEX "Lead_status_lastContactedAt_idx"  ON "Lead"("status", "lastContactedAt");
CREATE        INDEX "Lead_businessName_city_idx"       ON "Lead"("businessName", "city");
CREATE        INDEX "Lead_normalizedName_idx"          ON "Lead"("normalizedName");
CREATE        INDEX "Lead_websiteDomain_idx"           ON "Lead"("websiteDomain");
CREATE        INDEX "Lead_sector_idx"                  ON "Lead"("sector");
CREATE        INDEX "Lead_suggestedLane_idx"           ON "Lead"("suggestedLane");

-- ── Suppression ────────────────────────────────────────────────────────────
CREATE TABLE "Suppression" (
  "id"        UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "email"     TEXT               NOT NULL,
  "reason"    "SuppressionReason" NOT NULL,
  "leadId"    UUID,
  CONSTRAINT "Suppression_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Suppression_email_key" ON "Suppression"("email");
CREATE        INDEX "Suppression_email_idx" ON "Suppression"("email");

-- ── FollowUpQueue ──────────────────────────────────────────────────────────
CREATE TABLE "FollowUpQueue" (
  "id"              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  "queuedAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "leadId"          UUID             NOT NULL,
  "businessName"    TEXT             NOT NULL,
  "email"           TEXT             NOT NULL,
  "draftId"         TEXT,
  "draftPreview"    TEXT,
  "geminiReasoning" TEXT             NOT NULL,

  "status"          "FollowUpStatus" NOT NULL DEFAULT 'pending',
  "approvedBy"      TEXT,
  "approvedAt"      TIMESTAMP(3),

  CONSTRAINT "FollowUpQueue_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "FollowUpQueue_status_idx" ON "FollowUpQueue"("status");
CREATE INDEX "FollowUpQueue_leadId_idx" ON "FollowUpQueue"("leadId");

-- ── ErrorLog ───────────────────────────────────────────────────────────────
CREATE TABLE "ErrorLog" (
  "id"              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "scenarioName"    TEXT         NOT NULL,
  "moduleName"      TEXT,
  "errorCode"       TEXT         NOT NULL,
  "errorMessage"    TEXT         NOT NULL,
  "leadId"          UUID,
  "killSwitchFired" BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX "ErrorLog_errorCode_timestamp_idx" ON "ErrorLog"("errorCode", "timestamp");
CREATE INDEX "ErrorLog_timestamp_idx"            ON "ErrorLog"("timestamp");

-- ── DiscoveryRun ───────────────────────────────────────────────────────────
CREATE TABLE "DiscoveryRun" (
  "id"            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "ranAt"         TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "source"        "DiscoverySource" NOT NULL,
  "query"         TEXT              NOT NULL,
  "region"        TEXT,
  "leadsFound"    INTEGER           NOT NULL DEFAULT 0,
  "totalResults"  INTEGER,
  "nextPageToken" TEXT,
  "durationMs"    INTEGER
);

CREATE INDEX "DiscoveryRun_source_ranAt_idx" ON "DiscoveryRun"("source", "ranAt");
CREATE INDEX "DiscoveryRun_query_region_idx" ON "DiscoveryRun"("query", "region");

-- ── BotConversationRef ─────────────────────────────────────────────────────
CREATE TABLE "BotConversationRef" (
  "id"                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  "channelType"           TEXT         NOT NULL,
  "conversationReference" JSONB        NOT NULL
);

CREATE UNIQUE INDEX "BotConversationRef_channelType_key" ON "BotConversationRef"("channelType");

-- ── RuntimeConfig ──────────────────────────────────────────────────────────
CREATE TABLE "RuntimeConfig" (
  "key"         TEXT         PRIMARY KEY,
  "value"       TEXT         NOT NULL,
  "valueType"   TEXT         NOT NULL DEFAULT 'string',
  "description" TEXT,
  "updatedBy"   TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "RuntimeConfig_updatedAt_idx" ON "RuntimeConfig"("updatedAt");

-- ── ScrapeCache ────────────────────────────────────────────────────────────
CREATE TABLE "ScrapeCache" (
  "domain"       TEXT         PRIMARY KEY,
  "payload"      JSONB        NOT NULL,
  "fetchedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "pagesScraped" INTEGER      NOT NULL DEFAULT 0,
  "confidence"   TEXT
);

CREATE INDEX "ScrapeCache_expiresAt_idx" ON "ScrapeCache"("expiresAt");

-- ── updatedAt triggers ─────────────────────────────────────────────────────
-- Prisma fills updatedAt at the application layer, so no DB trigger is
-- required. If you ever bypass Prisma with raw SQL, set updatedAt manually.

-- ── Seed rows (optional) ───────────────────────────────────────────────────
-- Sensible defaults so the orchestrator and bot don't crash on first boot.
INSERT INTO "RuntimeConfig" ("key", "value", "valueType", "description")
VALUES
  ('outreach.paused',          'false', 'bool',   'Global kill-switch for outbound drafts'),
  ('followup.paused',          'false', 'bool',   'Global kill-switch for follow-ups'),
  ('discovery.dailyCap',       '200',   'int',    'Hard ceiling on new leads per UTC day'),
  ('scoring.minBrandFit',      '65',    'int',    'Floor score for auto-drafting (else needs_review)')
ON CONFLICT ("key") DO NOTHING;
