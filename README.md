# ClearedJobs Scraper

Extract security-cleared job listings from ClearedJobs.net with ease. Collect comprehensive job data including title, company, location, and clearance requirements at scale. Perfect for talent acquisition, market research, and competitive intelligence in the defense industry.

---

## Features

- **Comprehensive Data Extraction** — Capture titles, companies, locations, clearances, salaries, and full descriptions
- **Smart Filtering** — Search by specific keywords, locations, and remote work options
- **Automated Pagination** — Effortlessly navigate through multiple pages of job results
- **Stealth Mode** — Built-in browser fingerprinting and proxy rotation for reliable collection
- **Deep Extraction** — Automatically collects detailed job information from individual listings

---

## Use Cases

### Talent Acquisition
Identify and track job openings from major defense contractors. Build a database of hiring trends and skill requirements to optimize your technical recruiting strategies.

### Competitive Intelligence
Monitor competitor hiring activity in the cleared sector. Understand which companies are expanding their teams, what technologies they prioritize, and which clearance levels are in high demand.

### Market Analysis
Analyze salary trends and geographic hotspots for security-cleared positions. Identify emerging markets and shift in industry requirements across various clearance levels.

### Personal Job Monitoring
Automate your job search by monitoring specific keywords and locations. Stay ahead of the competition with the latest listings delivered through scheduled runs.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keywords` | String | No | `""` | Job search keywords (e.g., 'Engineer', 'Analyst') |
| `location` | String | No | `""` | Search location (City, State, or ZIP) |
| `sort` | String | No | `"date"` | Sort order: `date` (Recent) or `relevance` |
| `remote` | String | No | `""` | Filter: `remote` (Only), `hybrid`, or empty (All) |
| `results_wanted` | Integer | No | `20` | Maximum number of job listings to collect |
| `max_pages` | Integer | No | `3` | Maximum number of search pages to process |
| `startUrl` | String | No | `""` | Custom search URL to override default filters |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": true}` | Proxy settings (Residential recommended) |

---

## Output Data

Each item in the dataset contains detailed job information:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Internal job identifier |
| `url` | String | Direct link to the job listing |
| `title` | String | Job title |
| `company` | String | Employer or company name |
| `location` | String | Job location (City, State) |
| `security_clearance` | String | Required security clearance level |
| `salary` | String | Salary information if provided |
| `job_type` | String | Employment type (e.g., Full time, Contract) |
| `date_posted` | String | When the listing was published |
| `description_html` | String | Full job description in HTML format |
| `description_text` | String | Clean text version of the job description |

---

## Usage Examples

### Basic Job Search

Collect the latest engineering jobs in Virginia:

```json
{
    "keywords": "engineer",
    "location": "Virginia",
    "results_wanted": 50
}
```

### Remote & Hybrid Monitoring

Filter for remote-only software developer positions across the US:

```json
{
    "keywords": "software developer",
    "remote": "remote",
    "results_wanted": 100,
    "sort": "date"
}
```

### High-Volume Extraction

Large-scale collection using residential proxies for maximum reliability:

```json
{
    "keywords": "security clearance",
    "location": "Arlington, VA",
    "results_wanted": 250,
    "max_pages": 10,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Sample Output

```json
{
  "id": "1059802",
  "url": "https://clearedjobs.net/job/senior-software-engineer-aurora-colorado-1059802",
  "title": "Senior Software Engineer",
  "company": "Top Tier Defense",
  "location": "Aurora, Colorado",
  "security_clearance": "Top Secret / SCI",
  "salary": "$145,000 - $185,000",
  "job_type": "Full time",
  "date_posted": "2025-12-01T08:00:00Z",
  "description_html": "<h3>Job Summary</h3><p>We are seeking a highly skilled...</p>",
  "description_text": "Job Summary: We are seeking a highly skilled..."
}
```

---

## Tips for Best Results

### Optimize Your Search
- Use specific keywords like "TS/SCI" or "Polygraph" to narrow results
- Combine location and keywords for the most relevant matches
- Start with `results_wanted: 20` to verify your search criteria

### Reliability & Stealth
- **Residential Proxies** — Always use residential proxies for large-scale collection to avoid rate limiting
- **Page Limits** — Set a reasonable `max_pages` for your total result count to optimize performance
- **Sort Order** — Use `date` to ensure you are getting the most recent opportunities

---

## Integrations

Connect your cleared job data with your favorite tools:

- **Google Sheets** — Export directly to spreadsheets for analysis
- **Airtable** — Build a searchable talent pipeline
- **Slack** — Get notified of new executive openings
- **Make / Zapier** — Create fully automated hiring workflows

### Export Formats

- **JSON** — Ready for API integrations and custom apps
- **CSV** — Best for Excel and spreadsheet analysis
- **Excel** — Formatted business reports
- **XML** — For enterprise system ingestion

---

## Frequently Asked Questions

### Do I need an account on ClearedJobs.net?
No, this scraper extracts publicly available job listings without requiring any login or account.

### How fresh is the data?
The scraper can collect the very latest postings in real-time. Use the `sort: "date"` parameter to prioritize new listings.

### Can I collect full job descriptions?
Yes, the scraper automatically visits each job page to extract the full HTML and text descriptions.

### What proxies are recommended?
We highly recommend using Apify Residential proxies to ensure maximum reliability and avoid IP blocks during large runs.

### Is there a limit to how many jobs I can scrape?
The practical limit is set by the website's total results. You can use `results_wanted` to control your collection size.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect website rate limits.
