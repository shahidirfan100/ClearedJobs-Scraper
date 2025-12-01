// ClearedJobs.net scraper - JSON API first, clean HTML descriptions
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};

        const {
            keywords = '',
            location = '',
            clearance_level = '',
            /**
             * HARD LIMIT of jobs you want to save in the dataset.
             * Set high (e.g., 1000) if you want “everything”.
             */
            results_wanted: RESULTS_WANTED_RAW = 200,

            /**
             * Maximum number of API pages to fetch.
             * The API is paginated; this controls depth.
             */
            max_pages: MAX_PAGES_RAW = 50,

            /**
             * If true -> call /api/v1/jobs/{id} per job
             * for full description + metadata.
             */
            collectDetails = true,

            /**
             * Standard Apify proxyConfiguration input.
             * e.g. { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
             */
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;

        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 50;

        const BASE = 'https://clearedjobs.net';
        const API_LIST = `${BASE}/api/v1/jobs`;

        // Proxy + HTTP client (stealthy)
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        const client = gotScraping.extend({
            responseType: 'json',
            timeout: { request: 30000 },
            headers: {
                Accept: 'application/json,text/plain,*/*',
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            },
        });

        // Strip scripts / styles etc and return plain text
        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        // From the Web Scribble API "customBlockList"
        const extractCustom = (blocks = [], labelMatch) => {
            const match = blocks.find(
                (b) => b && b.label && labelMatch.test(String(b.label))
            );
            return match?.value || null;
        };

        const buildParams = (page) => {
            const params = new URLSearchParams();
            params.set('page', String(page));

            if (keywords && String(keywords).trim()) {
                params.set('keywords', String(keywords).trim());
            }

            if (location && String(location).trim()) {
                // This is how the Web Scribble job board on ClearedJobs
                // expects the location filter in their API
                params.set(
                    'job_location_filter',
                    String(location).trim().toLowerCase(),
                );
            }

            if (clearance_level && String(clearance_level).trim()) {
                // On this board, security clearance is modeled under "job_type"
                params.set(
                    'job_type_filter',
                    String(clearance_level).trim(),
                );
            }

            return params.toString();
        };

        const fetchListingPage = async (page) => {
            const url = `${API_LIST}?${buildParams(page)}`;
            log.debug(`Fetching list page ${page}: ${url}`);

            const res = await client.get(url, {
                proxyUrl: proxyConf?.newUrl(),
            });

            if (res.statusCode !== 200) {
                throw new Error(`List ${url} -> ${res.statusCode}`);
            }

            return res.body;
        };

        const fetchDetail = async (id) => {
            const url = `${BASE}/api/v1/jobs/${id}`;
            log.debug(`Fetching detail: ${url}`);

            const res = await client.get(url, {
                proxyUrl: proxyConf?.newUrl(),
            });

            if (res.statusCode !== 200) {
                throw new Error(`Detail ${url} -> ${res.statusCode}`);
            }

            return res.body?.data || {};
        };

        const seen = new Set(); // de-dup by URL
        let saved = 0;
        let pages = 0;

        let page = 1;
        while (saved < RESULTS_WANTED && page <= MAX_PAGES) {
            let body;
            try {
                body = await fetchListingPage(page);
            } catch (err) {
                log.warning(`Failed to fetch list page ${page}: ${err.message}`);
                break;
            }

            const jobs = Array.isArray(body?.data) ? body.data : [];
            if (!jobs.length) {
                log.warning(`Page ${page} returned no jobs, stopping pagination.`);
                break;
            }

            pages += 1;
            log.info(`API page ${page} -> ${jobs.length} jobs`);

            for (const job of jobs) {
                if (saved >= RESULTS_WANTED) break;

                const url = job.url || job.link || null;
                if (!url) {
                    // No URL, skip – can’t resolve detail page
                    continue;
                }

                if (seen.has(url)) {
                    continue;
                }
                seen.add(url);

                const clearance = extractCustom(
                    job.customBlockList,
                    /Security Clearance/i,
                );
                const posted =
                    extractCustom(job.customBlockList, /Posted/i) ||
                    job.posted_date ||
                    null;

                let descriptionHtml = job.shortDescription || null;
                let detail = {};

                if (collectDetails && job.id) {
                    try {
                        detail = await fetchDetail(job.id);
                        // Prefer full description from detail endpoint
                        descriptionHtml = detail.description || descriptionHtml;
                    } catch (err) {
                        log.debug(
                            `Detail fetch failed for ${url} (id=${job.id}): ${err.message}`,
                        );
                    }
                }

                const item = {
                    // Clean, correct title
                    title: detail.title || job.title || null,

                    company:
                        detail.company?.name ||
                        job.company?.name ||
                        job.company_name ||
                        null,

                    location:
                        detail.location ||
                        job.location ||
                        extractCustom(detail.customBlockList, /Location/i) ||
                        extractCustom(job.customBlockList, /Location/i) ||
                        null,

                    security_clearance:
                        clearance ||
                        extractCustom(detail.customBlockList, /Security Clearance/i) ||
                        null,

                    salary:
                        extractCustom(detail.customBlockList, /Salary/i) ||
                        extractCustom(job.customBlockList, /Salary/i) ||
                        null,

                    job_type:
                        extractCustom(detail.customBlockList, /(Job Type|Time Type)/i) ||
                        extractCustom(job.customBlockList, /(Job Type|Time Type)/i) ||
                        null,

                    date_posted:
                        posted ||
                        detail.posted_date ||
                        null,

                    // Raw HTML + cleaned text
                    description_html: descriptionHtml || null,
                    description_text: descriptionHtml
                        ? cleanText(descriptionHtml)
                        : null,

                    url,
                    job_id: job.id ?? null,

                    // for debugging / future enrichment
                    _source: 'api',
                    _raw_listing: job,
                    _raw_detail: detail,
                };

                await Dataset.pushData(item);
                saved += 1;
            }

            const hasNext = body?.links?.next;
            if (!hasNext) {
                log.info('No "next" link in API response; stopping pagination.');
                break;
            }

            page += 1;
        }

        log.info(
            `Finished. Saved ${saved} jobs from ${pages} API page(s). ` +
                `Requested up to ${RESULTS_WANTED} jobs and ${MAX_PAGES} page(s).`,
        );
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
