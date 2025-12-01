// ClearedJobs.net scraper - API-first with HTML fallback
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
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 3,
            collectDetails = true,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 3;
        const BASE = 'https://clearedjobs.net';
        const API_LIST = `${BASE}/api/v1/jobs`;

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
        const client = gotScraping.extend({
            responseType: 'json',
            timeout: { request: 30000 },
            headers: {
                Accept: 'application/json,text/plain,*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const seen = new Set();
        let saved = 0;
        let pages = 0;

        log.info(`Starting run`, {
            keywords,
            location,
            clearance_level,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
        });

        const buildParams = (page) => {
            const params = new URLSearchParams();
            params.set('page', String(page));
            if (keywords) params.set('keywords', String(keywords).trim());
            if (location) params.set('job_location_filter', String(location).trim().toLowerCase());
            if (clearance_level) params.set('job_type_filter', String(clearance_level).trim());
            return params.toString();
        };

        const fetchListingPage = async (page) => {
            const url = `${API_LIST}?${buildParams(page)}`;
            const res = await client.get(url, { proxyUrl: proxyConf?.newUrl() });
            if (res.statusCode !== 200) throw new Error(`List ${url} -> ${res.statusCode}`);
            return res.body;
        };

        const fetchDetail = async (id) => {
            const url = `${BASE}/api/v1/jobs/${id}`;
            const res = await client.get(url, { proxyUrl: proxyConf?.newUrl() });
            if (res.statusCode !== 200) throw new Error(`Detail ${url} -> ${res.statusCode}`);
            return res.body?.data || {};
        };

        const extractCustom = (blocks = [], labelMatch) => {
            const match = blocks.find((b) => b?.label && labelMatch.test(b.label));
            return match?.value || null;
        };

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
                log.warning(`Page ${page} returned no jobs, stopping.`);
                break;
            }

            pages += 1;
            log.info(`Page ${page} -> ${jobs.length} jobs`);

            for (const job of jobs) {
                if (saved >= RESULTS_WANTED) break;
                const url = job.url || job.link || null;
                if (!url || seen.has(url)) continue;
                seen.add(url);

                const clearance = extractCustom(job.customBlockList, /Security Clearance/i);
                const posted = extractCustom(job.customBlockList, /Posted/i) || job.posted_date || null;

                let descriptionHtml = job.shortDescription || null;
                let detail = {};
                if (collectDetails) {
                    try {
                        detail = await fetchDetail(job.id);
                        descriptionHtml = detail.description || descriptionHtml;
                    } catch (err) {
                        log.debug(`Detail fetch failed for ${url}: ${err.message}`);
                    }
                }

                const item = {
                    title: detail.title || job.title || null,
                    company: detail.company?.name || job.company?.name || null,
                    location: detail.location || job.location || null,
                    security_clearance: clearance || extractCustom(detail.customBlockList, /Security Clearance/i) || null,
                    salary: extractCustom(detail.customBlockList, /Salary/i) || null,
                    job_type: extractCustom(detail.customBlockList, /(Job Type|Time Type)/i) || null,
                    date_posted: posted || detail.posted_date || null,
                    description_html: descriptionHtml || null,
                    description_text: descriptionHtml ? cleanText(descriptionHtml) : null,
                    url,
                    id: job.id,
                    _source: 'api',
                };

                await Dataset.pushData(item);
                saved += 1;
            }

            const hasNext = body?.links?.next;
            if (!hasNext) break;
            page += 1;
        }

        if (saved === 0) {
            log.warning('Finished with 0 items. Check filters or endpoint availability.');
        }
        log.info(`Finished. Saved ${saved} items from ${pages} pages.`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
