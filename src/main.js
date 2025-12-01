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
            keywords = '', location = '', clearance_level = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://clearedjobs.net') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cl, page = 1) => {
            const u = new URL('https://clearedjobs.net/jobs');
            
            // Parse location string to extract components
            let country = '', state = '', city = '', zip = '';
            if (loc) {
                const locStr = String(loc).trim();
                // Try to parse common formats like "City, State", "State", "City, State, Country"
                const parts = locStr.split(',').map(p => p.trim());
                if (parts.length >= 2) {
                    city = parts[0];
                    state = parts[1];
                    if (parts.length >= 3) country = parts[2];
                } else if (parts.length === 1) {
                    // Single part - could be city, state, or country
                    if (parts[0].length === 2) {
                        state = parts[0]; // Assume 2-letter state code
                    } else {
                        city = parts[0]; // Assume city name
                    }
                }
            }
            
            u.searchParams.set('country', country);
            u.searchParams.set('state', state);
            u.searchParams.set('city', city);
            u.searchParams.set('zip', zip);
            u.searchParams.set('keywords', String(kw || '').trim());
            u.searchParams.set('latitude', '');
            u.searchParams.set('longitude', '');
            u.searchParams.set('location_autocomplete_data', '');
            u.searchParams.set('city_state_zip', '');
            u.searchParams.set('locale', 'en');
            u.searchParams.set('page', String(page));
            u.searchParams.set('sort', 'date'); // Default to date sorting
            if (cl) u.searchParams.set('clearance_level', String(cl).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keywords, location, clearance_level, 1));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        // Try to fetch JSON API first
        async function tryFetchJsonApi(pageUrl, proxyUrl) {
            try {
                // ClearedJobs might have an API endpoint - try common patterns
                const apiPatterns = [
                    pageUrl.replace('/jobs?', '/api/jobs?'),
                    pageUrl.replace('/jobs?', '/jobs.json?'),
                    pageUrl + '&format=json'
                ];

                for (const apiUrl of apiPatterns) {
                    try {
                        const response = await gotScraping({
                            url: apiUrl,
                            responseType: 'json',
                            proxyUrl,
                            timeout: { request: 30000 },
                            headers: {
                                'Accept': 'application/json',
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            }
                        });
                        
                        if (response.body && typeof response.body === 'object') {
                            return response.body;
                        }
                    } catch (e) {
                        // Try next pattern
                        continue;
                    }
                }
            } catch (e) {
                log.debug(`JSON API fetch failed: ${e.message}`);
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
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary?.value || e.baseSalary?.minValue || null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // ClearedJobs patterns: /job/title-location-id
                if (/\/job\//i.test(href) || /clearedjobs\.net\/job/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && abs.includes('/job/')) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, currentPageNo) {
            // ClearedJobs uses page parameter in URL
            const currentUrl = new URL(initial[0]);
            const nextPage = currentPageNo + 1;
            currentUrl.searchParams.set('page', String(nextPage));
            return currentUrl.href;
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

                if (label === 'LIST') {
                    // Try JSON API first
                    const jsonData = await tryFetchJsonApi(request.url, proxyInfo?.url);
                    
                    let links = [];
                    if (jsonData && jsonData.jobs && Array.isArray(jsonData.jobs)) {
                        crawlerLog.info(`LIST ${request.url} -> found ${jsonData.jobs.length} jobs via JSON API`);
                        // Process JSON data directly
                        if (!collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const jobs = jsonData.jobs.slice(0, Math.max(0, remaining));
                            for (const job of jobs) {
                                const item = {
                                    title: job.title || job.name || null,
                                    company: job.company || job.employer || null,
                                    location: job.location || null,
                                    security_clearance: job.clearance || job.security_clearance || null,
                                    salary: job.salary || null,
                                    job_type: job.job_type || job.type || null,
                                    date_posted: job.date_posted || job.posted || null,
                                    description_html: job.description || null,
                                    description_text: job.description ? cleanText(job.description) : null,
                                    url: toAbs(job.url || job.link, 'https://clearedjobs.net'),
                                };
                                await Dataset.pushData(item);
                                saved++;
                            }
                        } else {
                            // Enqueue detail pages from JSON
                            const remaining = RESULTS_WANTED - saved;
                            links = jsonData.jobs.slice(0, Math.max(0, remaining)).map(j => toAbs(j.url || j.link, 'https://clearedjobs.net')).filter(Boolean);
                        }
                    } else {
                        // Fallback to HTML parsing
                        links = findJobLinks($, request.url);
                        crawlerLog.info(`LIST ${request.url} -> found ${links.length} links via HTML`);
                    }

                    if (collectDetails && links.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else if (!collectDetails && links.length > 0) {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { 
                            await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'clearedjobs.net' }))); 
                            saved += toPush.length; 
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // ClearedJobs specific selectors
                        if (!data.title) data.title = $('h1').first().text().trim() || $('[class*="job-title"]').first().text().trim() || null;
                        if (!data.company) data.company = $('[class*="company"]').first().text().trim() || $('.employer').first().text().trim() || null;
                        if (!data.location) data.location = $('[class*="location"]').first().text().replace(/Location/gi, '').trim() || null;
                        
                        // Security clearance - unique to ClearedJobs
                        let security_clearance = $('*').filter((_, el) => /Security Clearance/i.test($(el).text())).first().parent().text().replace(/Security Clearance/gi, '').trim() || null;
                        if (!security_clearance) security_clearance = $('[class*="clearance"]').first().text().trim() || null;
                        
                        // Salary
                        let salary = $('*').filter((_, el) => /Salary|Compensation/i.test($(el).text())).first().text().replace(/Salary|Compensation/gi, '').trim() || null;
                        if (!salary) salary = $('[class*="salary"]').first().text().trim() || null;
                        
                        // Job type
                        let job_type = $('*').filter((_, el) => /Time Type|Job Type/i.test($(el).text())).first().text().replace(/Time Type|Job Type/gi, '').trim() || null;
                        if (!job_type) job_type = $('[class*="job-type"]').first().text().trim() || null;
                        
                        // Date posted
                        if (!data.date_posted) {
                            data.date_posted = $('*').filter((_, el) => /Posted/i.test($(el).text())).first().text().replace(/Posted/gi, '').trim() || null;
                        }
                        
                        // Description
                        if (!data.description_html) { 
                            const desc = $('[class*="description"]').first().length ? $('[class*="description"]').first() : $('.entry-content').first();
                            data.description_html = desc && desc.length ? String(desc.html()).trim() : null; 
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            location: data.location || null,
                            security_clearance: security_clearance || null,
                            salary: salary || data.salary || null,
                            job_type: job_type || data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
