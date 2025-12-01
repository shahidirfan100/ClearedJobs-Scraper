# ClearedJobs.Net Scraper

Extract security-cleared job listings from ClearedJobs.net with advanced filtering capabilities. This scraper efficiently collects job postings requiring security clearances, making it ideal for defense contractors, government agencies, and security-cleared professionals.

## Key Features

- **Comprehensive Data Extraction** - Captures job titles, company names, locations, security clearance requirements, salaries, job types, posting dates, and full descriptions
- **Advanced Filtering** - Search by keywords, location, and security clearance level
- **API-First Architecture** - Prioritizes JSON API extraction with intelligent HTML fallback for maximum reliability
- **Full Detail Scraping** - Optional deep extraction visits individual job pages for complete information
- **Smart Pagination** - Automatically navigates through multiple pages of results
- **Proxy Support** - Built-in support for Apify Proxy to ensure uninterrupted data collection

## Input Configuration

Configure the scraper using these parameters:

### Search Filters

<table>
<thead>
<tr>
<th>Parameter</th>
<th>Type</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>keywords</strong></td>
<td>String</td>
<td>Job search keywords (e.g., "Software Engineer", "Intelligence Analyst", "Cyber Security")</td>
</tr>
<tr>
<td><strong>location</strong></td>
<td>String</td>
<td>Filter jobs by location (city, state, or region). Leave empty for all locations.</td>
</tr>
<tr>
<td><strong>clearance_level</strong></td>
<td>String</td>
<td>Filter by security clearance level ("Top Secret", "Secret", "TS/SCI", "TS/SCI + Polygraph", "Public Trust", "DHS", "None")</td>
</tr>
</tbody>
</table>

### Scraper Controls

<table>
<thead>
<tr>
<th>Parameter</th>
<th>Type</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>collectDetails</strong></td>
<td>Boolean</td>
<td>Visit individual job pages for complete details. Default: true</td>
</tr>
<tr>
<td><strong>results_wanted</strong></td>
<td>Integer</td>
<td>Maximum number of jobs to collect. Default: 100</td>
</tr>
<tr>
<td><strong>max_pages</strong></td>
<td>Integer</td>
<td>Safety limit on search result pages. Default: 20</td>
</tr>
<tr>
<td><strong>startUrl</strong></td>
<td>String</td>
<td>Start from a specific ClearedJobs.net URL (bypasses search filters)</td>
</tr>
<tr>
<td><strong>proxyConfiguration</strong></td>
<td>Object</td>
<td>Apify Proxy settings. Residential proxies recommended</td>
</tr>
</tbody>
</table>

## Output Data

Each job listing includes the following fields:

```json
{
  "title": "Senior Software Engineer",
  "company": "Lockheed Martin",
  "location": "Fort Worth, Texas",
  "security_clearance": "Secret",
  "salary": "$120,000 - $150,000",
  "job_type": "Full time",
  "date_posted": "December 1, 2025",
  "description_html": "<p>Full HTML description...</p>",
  "description_text": "Plain text description...",
  "url": "https://clearedjobs.net/job/..."
}
```

### Output Fields

<table>
<thead>
<tr>
<th>Field</th>
<th>Type</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>title</strong></td>
<td>String</td>
<td>Job title</td>
</tr>
<tr>
<td><strong>company</strong></td>
<td>String</td>
<td>Employer name</td>
</tr>
<tr>
<td><strong>location</strong></td>
<td>String</td>
<td>Job location (city, state)</td>
</tr>
<tr>
<td><strong>security_clearance</strong></td>
<td>String</td>
<td>Required security clearance level</td>
</tr>
<tr>
<td><strong>salary</strong></td>
<td>String</td>
<td>Salary information (if available)</td>
</tr>
<tr>
<td><strong>job_type</strong></td>
<td>String</td>
<td>Employment type (Full time, Part time, Contract, etc.)</td>
</tr>
<tr>
<td><strong>date_posted</strong></td>
<td>String</td>
<td>Date the job was posted</td>
</tr>
<tr>
<td><strong>description_html</strong></td>
<td>String</td>
<td>Full job description in HTML format</td>
</tr>
<tr>
<td><strong>description_text</strong></td>
<td>String</td>
<td>Job description in plain text</td>
</tr>
<tr>
<td><strong>url</strong></td>
<td>String</td>
<td>Direct link to job posting</td>
</tr>
</tbody>
</table>

## Usage Examples

### Example 1: Search Top Secret Jobs in Virginia

```json
{
  "keywords": "engineer",
  "location": "Virginia",
  "clearance_level": "Top Secret",
  "results_wanted": 20,
  "collectDetails": true
}
```

### Example 2: Cyber Security Jobs with TS/SCI Clearance

```json
{
  "keywords": "cyber security",
  "clearance_level": "Top Secret / SCI",
  "results_wanted": 20,
  "max_pages": 3
}
```

### Example 3: Intelligence Analyst Jobs in Maryland

```json
{
  "keywords": "analyst",
  "location": "Fort Meade, Maryland",
  "results_wanted": 20,
  "collectDetails": true
}
```

### Example 4: Browse All Recent Jobs

```json
{
  "results_wanted": 20,
  "max_pages": 3,
  "collectDetails": false
}
```

## Performance & Best Practices

### Optimization Tips

- **Use Specific Keywords** - Narrow searches return faster and more relevant results
- **Enable Proxy** - Use Apify Proxy (residential) to avoid rate limiting
- **Adjust collectDetails** - Set to `false` for faster collection when full descriptions aren't needed
- **Set Reasonable Limits** - Use `results_wanted` and `max_pages` to control run time and compute units

### Expected Performance

<table>
<thead>
<tr>
<th>Results</th>
<th>Detail Mode</th>
<th>Estimated Time</th>
</tr>
</thead>
<tbody>
<tr>
<td>20 jobs</td>
<td>Off</td>
<td>30-60 seconds</td>
</tr>
<tr>
<td>20 jobs</td>
<td>On</td>
<td>1-2 minutes</td>
</tr>
<tr>
<td>50 jobs</td>
<td>Off</td>
<td>1-2 minutes</td>
</tr>
<tr>
<td>50 jobs</td>
<td>On</td>
<td>2-3 minutes</td>
</tr>
</tbody>
</table>

*Times may vary based on network conditions and proxy performance*

## Common Use Cases

### Defense Contractors & Recruiters
Find qualified candidates by extracting jobs matching specific clearance levels and technical skills. Export data for talent pipeline management.

### Job Seekers
Monitor new postings in your area and skill set. Set up scheduled runs to receive fresh opportunities automatically.

### Market Research
Analyze hiring trends in the cleared job market, including salary ranges, in-demand skills, and geographic hotspots.

### Competitive Intelligence
Track which companies are hiring, what positions are in demand, and required clearance levels across the industry.

## Troubleshooting

### Common Issues

<details>
<summary><strong>No results returned</strong></summary>

- Check your filter parameters are not too restrictive
- Verify the clearance level spelling matches available options
- Try broader keywords or remove location filters
- Ensure proxy is configured if IP is blocked
</details>

<details>
<summary><strong>Partial data in results</strong></summary>

- Enable `collectDetails: true` for complete information
- Some job listings may not include all fields (salary, clearance details)
- Check that the scraper completed successfully without errors
</details>

<details>
<summary><strong>Scraper runs slowly</strong></summary>

- Reduce `results_wanted` and `max_pages`
- Use more specific search filters to narrow results
- Ensure proxy configuration is optimal (residential recommended)
- Set `collectDetails: false` if full descriptions aren't required
</details>

<details>
<summary><strong>Rate limiting or blocks</strong></summary>

- Enable Apify Proxy with residential IPs
- Reduce scraping speed by decreasing concurrency in proxy settings
- Add delays between requests if running outside Apify platform
</details>

## Data Export Options

Export your scraped data in multiple formats:

- **JSON** - Structured data for programmatic processing
- **CSV** - Spreadsheet-compatible for analysis in Excel/Google Sheets
- **Excel** - Formatted spreadsheet with headers
- **HTML** - Human-readable table format
- **XML** - For integration with enterprise systems

Access exported data via:
- Direct download from Apify Console
- Apify API endpoints
- Webhook notifications
- Scheduled delivery to cloud storage

## Legal & Ethical Considerations

This scraper is designed for legal data extraction from publicly available job listings. Users are responsible for:

- Complying with ClearedJobs.net Terms of Service
- Respecting robots.txt and rate limits
- Using collected data ethically and legally
- Adhering to data privacy regulations (GDPR, CCPA, etc.)
- Not using data for spam or unauthorized purposes

## Support & Feedback

For issues, questions, or feature requests:

- Check the Apify Console logs for detailed error messages
- Review this documentation for configuration guidance
- Contact support through the Apify platform
- Rate and review to help improve this scraper

<p align="center">
<strong>Built for the Apify platform</strong><br>
Reliable • Scalable • Easy to Use
</p>
