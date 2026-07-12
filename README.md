# ClearedJobs.Net Job Scraper

Extract security-cleared job listings from ClearedJobs.net with ease. Collect comprehensive job data including title, company, location, clearance requirements, and full descriptions at scale. Perfect for talent acquisition, market research, and competitive intelligence in the defense and intelligence sector.

---

## Features

- **Comprehensive Data Extraction** - Capture titles, companies, locations, clearance levels, salaries, and full job descriptions
- **Smart Keyword Search** - Filter results by job title, skill, or any search term relevant to your needs
- **Location Filtering** - Narrow results to a specific city, state, or ZIP code
- **Automated Pagination** - Collect across multiple result pages without manual effort
- **Duplicate Removal** - Every dataset is automatically deduplicated so you get clean, unique listings
- **Deep Job Metadata** - Collect enriched hiring context including coordinates, education requirements, experience level, and reference IDs

---

## Use Cases

### Talent Acquisition and Recruiting
Build a real-time pipeline of open roles from the largest cleared-career platform. Track job openings from top defense contractors and identify which clearance levels are in demand before your competition does.

### Competitive Intelligence
Monitor competitor hiring activity across the cleared sector. Understand which companies are expanding, what technologies they prioritize, and where their operations are growing geographically.

### Market and Salary Analysis
Analyze salary trends, geographic hotspots, and experience requirements for security-cleared positions. Identify emerging roles and shifts in demand across Top Secret, SCI, and Polygraph-level positions.

### Automated Job Monitoring
Run the actor on a schedule to stay current with the latest postings. Receive fresh results each day and push them directly into your spreadsheet, CRM, or Slack channel without lifting a finger.

### Academic and Policy Research
Build structured datasets for workforce analysis, policy research, or labor market studies focused on the cleared professional community.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keywords` | String | No | `""` | Job search keywords (e.g., "Engineer", "Analyst", "Cyber") |
| `location` | String | No | `""` | Search location as City, State, or ZIP - leave blank for nationwide |
| `results_wanted` | Integer | No | `20` | Maximum number of job listings to collect |
| `max_pages` | Integer | No | `3` | Maximum number of result pages to process |
| `startUrl` | String | No | `""` | Paste a custom ClearedJobs.net search URL to override keyword and location filters |
| `proxyConfiguration` | Object | No | Apify Residential | Proxy settings; residential proxies are recommended for reliable access |

---

## Output Data

Each item in the dataset contains detailed job information:

| Field | Type | Description |
|-------|------|-------------|
| `id` | Number | Internal job identifier |
| `url` | String | Direct link to the job listing |
| `title` | String | Job title |
| `company` | String | Employer name |
| `company_details` | Object | Company metadata including profile URL and logo |
| `location` | String | Job location (City, State) |
| `coordinates` | Object | Latitude and longitude for the listing location |
| `address` | String | Street address when provided |
| `security_clearance` | String | Required clearance level (e.g., TS/SCI, Secret) |
| `salary` | String | Salary range when disclosed |
| `job_type` | String | Employment type (Full Time, Contract, etc.) |
| `experience` | String | Experience requirements |
| `education` | String | Education requirements |
| `posted_date` | String | Human-readable posting date from the listing card |
| `modified_time` | Number | Source modification timestamp |
| `date_posted` | String | Date the listing was published |
| `date_modified` | String | Last modified date when available |
| `job_reference_id` | String | Source job reference ID when available |
| `is_sponsored` | Boolean | Whether the listing is sponsored |
| `is_backfilled` | Boolean | Whether the role is marked as backfilled |
| `can_view_local` | Boolean | Local visibility eligibility flag |
| `display_logo` | Boolean | Whether a company logo is available |
| `short_description` | String | Brief summary shown in search results |
| `description_html` | String | Full job description in HTML format |
| `description_text` | String | Clean plain-text version of the job description |
| `badge` | String | Listing badge information when present |
| `epp` | String | Additional listing metadata |
| `source` | String | Source domain of the collected listing |

---

## Usage Examples

### Basic Keyword Search

Collect the latest engineering jobs listed nationally:

```json
{
    "keywords": "engineer",
    "results_wanted": 50
}
```

### Location-Specific Search

Find analyst roles in the Washington DC area:

```json
{
    "keywords": "intelligence analyst",
    "location": "Washington, DC",
    "results_wanted": 30
}
```

### Large-Scale Collection with Proxies

High-volume extraction using residential proxies for maximum reliability:

```json
{
    "keywords": "cybersecurity",
    "location": "Virginia",
    "results_wanted": 200,
    "max_pages": 10,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

### Custom Search URL

Paste any search URL directly from ClearedJobs.net to override all filters:

```json
{
    "startUrl": "https://clearedjobs.net/jobs?keywords=python&city_state_zip=Arlington%2C+VA",
    "results_wanted": 100
}
```

---

## Sample Output

```json
{
    "id": 1914497,
    "url": "https://clearedjobs.net/job/senior-site-content-manager-fort-belvoir-virginia-1914497",
    "title": "Senior Site Content Manager",
    "company": "Absolute Business Solutions Corp (ABSC)",
    "company_details": {
        "id": 352389,
        "name": "Absolute Business Solutions Corp (ABSC)",
        "logo": "https://wjm.s3.amazonaws.com/cjng/uploads/ABSC-100.png",
        "url": "https://clearedjobs.net/company/absolute-business-solutions-corp-absc-352389",
        "isFeatured": false
    },
    "location": "Fort Belvoir, Virginia",
    "coordinates": {
        "latitude": "38.7119000",
        "longitude": "-77.1458900"
    },
    "security_clearance": "TS/SCI",
    "job_type": "Full Time",
    "posted_date": "July 12, 2026",
    "date_posted": "June 24, 2026",
    "job_reference_id": "3686372",
    "is_sponsored": false,
    "is_backfilled": false,
    "can_view_local": true,
    "short_description": "ABSC is seeking a Senior Content Site Manager to support intelligence training initiatives at Fort Belvoir...",
    "description_text": "We are seeking a Senior Content Site Manager to support intelligence training initiatives...",
    "source": "https://clearedjobs.net"
}
```

---

## Tips for Best Results

### Refine Your Keywords
- Use clearance-specific terms like "TS/SCI", "Polygraph", or "Secret" to filter by clearance level
- Combine role and skill: "software engineer python" or "cybersecurity analyst CISSP"
- Start with `results_wanted: 20` to verify your search returns what you expect before scaling up

### Use Location for Precision
- Enter a city and state ("Arlington, VA") for tighter geographic targeting
- Leave location blank to collect results nationwide
- Use a ZIP code when targeting a very specific area around a base or facility

### Proxy Configuration
For large-scale or repeated runs, residential proxies significantly reduce the chance of access interruptions. Configure them like this:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your cleared job data with:

- **Google Sheets** - Export directly to spreadsheets for team analysis
- **Airtable** - Build a searchable and filterable talent pipeline
- **Slack** - Get notified instantly when new listings match your criteria
- **Make / Zapier** - Create fully automated hiring and monitoring workflows
- **Webhooks** - Push results to any custom endpoint in real time

### Export Formats

Download your dataset in multiple formats:

- **JSON** - Ready for API integrations and custom apps
- **CSV** - Best for Excel and spreadsheet analysis
- **Excel** - Formatted business reports
- **XML** - For enterprise system ingestion

---

## Frequently Asked Questions

### Do I need an account on ClearedJobs.net to use this?
No. This scraper collects publicly available job listings without requiring any login or account credentials.

### How recent is the data I'll collect?
Results are collected in real time each time the actor runs. You'll always get the most current listings available on the site at the moment of your run.

### Can I collect full job descriptions?
Yes. Each listing is enriched with the complete job description in both HTML and plain text formats, pulled from the individual job detail page.

### What clearance levels does ClearedJobs.net list?
The site covers the full spectrum of cleared positions including Secret, Top Secret, TS/SCI, TS/SCI with Polygraph, and other specialized government contractor roles.

### How many jobs can I collect in one run?
There's no hard limit built into the actor. You control the volume with `results_wanted` and `max_pages`. The practical ceiling is the number of results the site returns for your search.

### What proxies should I use for large runs?
Residential proxies via Apify Proxy are recommended for runs above a few hundred results. They provide the most reliable access without interruptions.

### What if some fields like salary or education are empty?
Those fields are optional on ClearedJobs.net. When a listing doesn't include that information, the field is omitted from the output rather than returning an empty value.

### Can I run this on a schedule?
Yes. Use Apify's built-in scheduler to run the actor daily, weekly, or at any interval you choose - ideal for continuous job market monitoring.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect rate limits.
