# API Discovery

## Audit Summary (Before Rewrite)
Existing actor output fields (11):
- id
- url
- title
- company
- location
- security_clearance
- salary
- job_type
- date_posted
- description_html
- description_text

Missing high-value fields for users:
- coordinates
- address
- experience
- education
- posted_date
- modified_time
- date_modified
- short_description
- is_sponsored
- is_backfilled
- can_view_local
- display_logo
- custom blocks metadata
- badge
- epp

## Discovery Notes
- URLScan public search was used for `clearedjobs.net` and `cjng.webscribble.com`.
- Existing public scans were homepage-centric and did not expose jobs search API calls.
- New scan submission from this environment returned 401 (Unauthorized), so endpoint discovery was completed by direct endpoint verification and schema profiling.

## Candidate Endpoints

### Candidate A (Selected)
- Endpoint: `https://clearedjobs.net/api/v1/jobs`
- Method: GET
- Auth: None
- Pagination: `page` parameter with response `links.next`
- Query params observed: `locale`, `sort`, `keywords`, `city_state_zip`, `location_remote_option_filter`, `page`
- Approx fields available (list payload):
  - id
  - title
  - location
  - coordinates
  - customBlockList
  - shortDescription
  - isSponsored
  - isBackfilled
  - alreadySaved
  - canViewLocal
  - url
  - company
  - omitted
  - cantSeeContent
  - epp
  - badge
  - posted_date
  - modified_time
  - display_logo

### Candidate B (Selected for Enrichment)
- Endpoint: `https://clearedjobs.net/api/v1/jobs/{id}`
- Method: GET
- Auth: None
- Pagination: Not needed (per-job detail)
- Approx fields available (detail payload):
  - id
  - title
  - description
  - location
  - address
  - salary
  - experience
  - education
  - positionType
  - isSponsored
  - isBackfilled
  - canViewLocal
  - time
  - url
  - status
  - jsonLd
  - cantSeeContent
  - customBlockTop
  - customBlockBottom
  - epp
  - badge

## Scoring

### Candidate A: `/api/v1/jobs`
- Returns JSON directly: +30
- Has >15 unique fields: +25
- No auth required: +20
- Has pagination support: +15
- Matches/extends current fields: +10
- Total: **100/100**

### Candidate B: `/api/v1/jobs/{id}`
- Returns JSON directly: +30
- Has >15 unique fields: +25
- No auth required: +20
- Has pagination support: +0
- Matches/extends current fields: +10
- Total: **85/100**

## Selected API
- Endpoint: `https://clearedjobs.net/api/v1/jobs`
- Method: GET
- Auth: None
- Pagination: `page` plus `links.next`
- Enrichment endpoint: `https://clearedjobs.net/api/v1/jobs/{id}`
- Fields available: 19+ (list) plus 20+ (detail)
- Fields currently missing in actor before update: 15+
- Field count comparison: ~11 (existing actor output) vs 25+ (updated output surface after merge and cleanup)
