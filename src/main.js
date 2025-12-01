// ClearedJobs.net scraper - API-first with HTML fallback
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keywords = '',
            location = '',
            clearance_level = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            collectDetails = true,
            startUrl,
            startUrls = [],
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;
        const BASE = 'https://clearedjobs.net';

        const toAbs = (href, base = BASE) => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const normalize = (txt) => (txt || '').replace(/\s+/g, ' ').trim();
        const stripLabel = (txt, re) => normalize((txt || '').replace(re, ''));

        const buildStartUrl = (page = 1) => {
            const u = new URL('/jobs', BASE);
            if (keywords) u.searchParams.set('keywords', String(keywords).trim());
            if (location) {
                // Site accepts plain location as city/state/zip via city_state_zip param; include raw for flexibility.
                u.searchParams.set('city_state_zip', String(location).trim());
                u.searchParams.set('location', String(location).trim());
            }
            if (clearance_level) u.searchParams.set('clearance_level', String(clearance_level).trim());
            u.searchParams.set('page', String(page));
            u.searchParams.set('sort', 'date');
            u.searchParams.set('locale', 'en');
            return u.href;
        };

        const startList = [];
        if (Array.isArray(startUrls)) startUrls.filter(Boolean).forEach((u) => startList.push(u));
        if (startUrl) startList.push(startUrl);
        if (url) startList.push(url);
        if (!startList.length) startList.push(buildStartUrl(1));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        let pagesHit = 0;
        let apiHits = 0;
        const seenJobs = new Set();

        async function fetchListingJson(pageUrl, proxyUrl) {
            const urlObj = new URL(pageUrl);
            const params = urlObj.searchParams.toString();
            const basePath = `${urlObj.origin}${urlObj.pathname}`.replace(/\/$/, '');
            const candidates = [
                `${basePath}.json${params ? `?${params}` : ''}`,
                `${basePath}/search.json${params ? `?${params}` : ''}`,
                `${urlObj.href}${urlObj.href.includes('?') ? '&' : '?'}format=json`,
                `${urlObj.origin}/api/jobs${params ? `?${params}` : ''}`,
            ];

            for (const apiUrl of candidates) {
                try {
                    const res = await gotScraping({
                        url: apiUrl,
                        responseType: 'json',
                        proxyUrl,
                        timeout: { request: 30000 },
                        headers: {
                            Accept: 'application/json,text/plain,*/*',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept-Language': 'en-US,en;q=0.9',
                        },
                    });
                    const body = res.body;
                    const jobsArray = Array.isArray(body?.jobs) ? body.jobs
                        : Array.isArray(body?.results) ? body.results
                            : Array.isArray(body?.data?.jobs) ? body.data.jobs
                                : Array.isArray(body) ? body : null;
                    if (jobsArray?.length) return { jobs: jobsArray, raw: body };
                } catch (e) {
                    // Try next candidate quietly
                }
            }
            return null;
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: e.jobLocation?.address?.addressLocality || e.jobLocation?.address?.addressRegion || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch {
                    // continue
                }
            }
            return null;
        }

        function parseListingHtml($, baseUrl) {
            const links = new Set();
            const selectors = [
                'a[href*="/job/"]',
                '[data-job-id] a[href]',
                '.search-result a[href]',
                '.job-title a[href]',
            ];
            for (const sel of selectors) {
                $(sel).each((_, el) => {
                    const href = $(el).attr('href');
                    if (!href) return;
                    const abs = toAbs(href, baseUrl);
                    if (abs && /\/job\//i.test(abs)) links.add(abs.split('#')[0]);
                });
            }
            return [...links];
        }

        function nextPageUrl(currentUrl) {
            try {
                const u = new URL(currentUrl);
                const current = Number(u.searchParams.get('page') || '1') || 1;
                u.searchParams.set('page', String(current + 1));
                return u.href;
            } catch {
                return null;
            }
        }

        async function pushItem(item) {
            await Dataset.pushData(item);
            saved += 1;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog, proxyInfo }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                if (saved >= RESULTS_WANTED) return;

                if (label === 'LIST') {
                    pagesHit += 1;
                    let links = [];
                    let viaApi = false;

                    const jsonData = await fetchListingJson(request.url, proxyInfo?.url);
                    if (jsonData?.jobs?.length) {
                        viaApi = true;
                        apiHits += 1;
                        crawlerLog.info(`LIST ${request.url} -> ${jsonData.jobs.length} jobs via JSON API`);
                        const mapped = jsonData.jobs.map((job) => ({
                            url: toAbs(job.url || job.link || job.canonical_url || job.job_url || (job.slug ? `/job/${job.slug}` : null), BASE),
                            title: job.title || job.name || null,
                            company: job.company || job.employer || job.hiring_organization || null,
                            location: job.location || job.city || job.state || null,
                            security_clearance: job.clearance || job.security_clearance || null,
                            salary: job.salary || job.compensation || null,
                            job_type: job.job_type || job.type || null,
                            date_posted: job.date_posted || job.posted || job.posted_at || null,
                            description_html: job.description || null,
                        })).filter((j) => j.url);

                        if (!collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            for (const job of mapped.slice(0, remaining)) {
                                if (seenJobs.has(job.url)) continue;
                                seenJobs.add(job.url);
                                await pushItem({
                                    ...job,
                                    description_text: job.description_html ? cleanText(job.description_html) : null,
                                    _source: 'json',
                                });
                            }
                        } else {
                            links = mapped.map((j) => j.url);
                        }
                    } else {
                        links = parseListingHtml($, request.url);
                        crawlerLog.info(`LIST ${request.url} -> ${links.length} links via HTML`);
                    }

                    if (collectDetails && links.length) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, remaining).filter((u) => !seenJobs.has(u));
                        toEnqueue.forEach((u) => seenJobs.add(u));
                        if (toEnqueue.length) {
                            await enqueueLinks({
                                urls: toEnqueue,
                                userData: { label: 'DETAIL' },
                            });
                        }
                    } else if (!collectDetails && links.length) {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, remaining).filter((u) => !seenJobs.has(u));
                        toPush.forEach((u) => seenJobs.add(u));
                        if (toPush.length) {
                            await Dataset.pushData(toPush.map((u) => ({ url: u, _source: viaApi ? 'json' : 'html' })));
                            saved += toPush.length;
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextUrl = nextPageUrl(request.url);
                        if (nextUrl) {
                            await enqueueLinks({
                                urls: [nextUrl],
                                userData: { label: 'LIST', pageNo: pageNo + 1 },
                            });
                        }
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    try {
                        const fromLd = extractFromJsonLd($) || {};
                        const title = fromLd.title || normalize($('h1').first().text()) || normalize($('[class*="job-title"]').first().text()) || null;
                        const company = fromLd.company || normalize($('.employer, [class*="company"]').first().text()) || null;
                        const locationText = fromLd.location || stripLabel($('[class*="location"]').first().text(), /Location/gi) || null;
                        const clearance = stripLabel($('*').filter((_, el) => /Security Clearance/i.test($(el).text())).first().parent().text(), /Security Clearance/gi)
                            || normalize($('[class*="clearance"]').first().text())
                            || fromLd.security_clearance || null;
                        const salary = stripLabel($('*').filter((_, el) => /Salary|Compensation/i.test($(el).text())).first().text(), /Salary|Compensation/gi)
                            || normalize($('[class*="salary"]').first().text()) || (fromLd.salary ? String(fromLd.salary) : null);
                        const jobType = stripLabel($('*').filter((_, el) => /Time Type|Job Type/i.test($(el).text())).first().text(), /Time Type|Job Type/gi)
                            || normalize($('[class*="job-type"]').first().text())
                            || fromLd.job_type || null;
                        const datePosted = fromLd.date_posted
                            || stripLabel($('*').filter((_, el) => /Posted/i.test($(el).text())).first().text(), /Posted/gi) || null;

                        let descriptionHtml = fromLd.description_html || null;
                        if (!descriptionHtml) {
                            const descNode = $('[class*="description"], .entry-content, [itemprop="description"]').first();
                            descriptionHtml = descNode.length ? String(descNode.html() || '').trim() : null;
                        }

                        await pushItem({
                            title,
                            company,
                            location: locationText,
                            security_clearance: clearance || null,
                            salary: salary || null,
                            job_type: jobType || null,
                            date_posted: datePosted || null,
                            description_html: descriptionHtml,
                            description_text: descriptionHtml ? cleanText(descriptionHtml) : null,
                            url: request.url,
                            _source: 'detail',
                        });
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            },
        });

        await crawler.run(startList.map((u) => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items. Pages: ${pagesHit}. JSON hits: ${apiHits}.`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
