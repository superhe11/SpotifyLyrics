const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

const app = express();
const port = Number(process.env.PORT) || 3217;

app.use(cors());

const FETCH_TIMEOUT = 15000;
const LYRICS_NOT_FOUND = 'LYRICS_NOT_FOUND';
const GENIUS_BROWSER_IDLE_MS = 45000;
const INJECT_COOLDOWN_MS = 12000;
const CACHE_FILE_PATH = path.join(__dirname, 'lyrics-cache.csv');
const LEGACY_CACHE_FILE_PATH = path.join(__dirname, 'lyrics-cache.json');
const CACHE_COLUMNS = [
    'key',
    'source',
    'artist',
    'title',
    'album',
    'duration',
    'cachedAt',
    'lyrics',
    'syncedLyrics'
];
const lyricsCache = loadLyricsCache();
const inFlightLyricsRequests = new Map();
const lastInjectionAtByTarget = new Map();
let sharedGeniusBrowser = null;
let sharedGeniusBrowserPromise = null;
let sharedGeniusBrowserIdleTimer = null;

function loadLyricsCache() {
    try {
        if (fs.existsSync(CACHE_FILE_PATH)) {
            return parseLyricsCacheCsv(fs.readFileSync(CACHE_FILE_PATH, 'utf8'));
        }

        if (fs.existsSync(LEGACY_CACHE_FILE_PATH)) {
            const raw = fs.readFileSync(LEGACY_CACHE_FILE_PATH, 'utf8');
            const parsed = raw.trim() ? JSON.parse(raw) : {};
            if (parsed && typeof parsed === 'object') {
                saveLyricsCache(parsed);
                return parsed;
            }
        }

        return {};
    } catch (error) {
        console.warn(`[cache] Failed to load cache: ${error.message}`);
        return {};
    }
}

function encodeCacheValue(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n/g, '\\n');
}

function decodeCacheValue(value) {
    return String(value ?? '').replace(/\\n/g, '\n');
}

function escapeCsvValue(value) {
    const normalized = encodeCacheValue(value);
    if (/[",]/.test(normalized)) {
        return `"${normalized.replace(/"/g, '""')}"`;
    }

    return normalized;
}

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    values.push(current);
    return values;
}

function parseLyricsCacheCsv(raw) {
    if (!raw.trim()) {
        return {};
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
        return {};
    }

    const cache = {};

    for (const line of lines.slice(1)) {
        const values = parseCsvLine(line);
        const row = Object.fromEntries(CACHE_COLUMNS.map((column, index) => [column, decodeCacheValue(values[index] || '')]));
        if (!row.key) {
            continue;
        }

        cache[row.key] = {
            source: row.source || null,
            artist: row.artist || null,
            title: row.title || null,
            album: row.album || null,
            duration: row.duration ? Number(row.duration) : null,
            cachedAt: row.cachedAt || null,
            lyrics: row.lyrics || null,
            syncedLyrics: row.syncedLyrics || null
        };
    }

    return cache;
}

function serializeLyricsCacheCsv(cache) {
    const header = CACHE_COLUMNS.join(',');
    const rows = Object.entries(cache)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, payload]) => CACHE_COLUMNS.map(column => {
            if (column === 'key') {
                return escapeCsvValue(key);
            }

            return escapeCsvValue(payload[column] ?? '');
        }).join(','));

    return [header, ...rows].join('\n');
}

function saveLyricsCache(cache = lyricsCache) {
    try {
        fs.writeFileSync(CACHE_FILE_PATH, serializeLyricsCacheCsv(cache), 'utf8');
    } catch (error) {
        console.warn(`[cache] Failed to save cache: ${error.message}`);
    }
}

function stripDiacritics(value) {
    return (value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function slugifyForGenius(value) {
    return stripDiacritics(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
}

function normalizeSearchText(value) {
    return stripDiacritics(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripLrcTimestamps(value) {
    return (value || '')
        .replace(/^\[[0-9]{1,2}:[0-9]{2}(?:\.[0-9]{1,3})?\]/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildCacheKey(artist, title) {
    return `${normalizeSearchText(artist)}::${normalizeSearchText(title)}`;
}

function uniqueNonEmpty(values) {
    return [...new Set(values.map(value => (value || '').trim()).filter(Boolean))];
}

function buildArtistVariants(artist) {
    const base = (artist || '').trim();
    return uniqueNonEmpty([
        base,
        base.replace(/^the\s+/i, '').trim(),
        base.split(/\s*(?:,|&| and | x | feat\.?| ft\.?| with )\s*/i)[0].trim()
    ]);
}

function buildTitleVariants(title) {
    const base = (title || '').trim();
    return uniqueNonEmpty([
        base,
        base.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').trim(),
        base.replace(/[,:!?]/g, ' ').replace(/\s+/g, ' ').trim(),
        base.replace(/\s*[-:]\s*(feat|ft)\..*$/i, '').trim(),
        base.replace(/\s*\((feat|ft)\..*?\)/i, '').trim(),
        base.replace(/\s*\[(feat|ft)\..*?\]/i, '').trim()
    ]);
}

function buildGeniusCandidateUrls(artist, title) {
    const artistSlugs = buildArtistVariants(artist).map(slugifyForGenius);
    const titleSlugs = buildTitleVariants(title).map(slugifyForGenius);

    return uniqueNonEmpty(
        artistSlugs.flatMap(artistSlug =>
            titleSlugs.map(titleSlug => `https://genius.com/${artistSlug}-${titleSlug}-lyrics`)
        )
    );
}

function buildGeniusSearchUrl(artist, title) {
    const query = `${title} ${artist}`.trim();
    return `https://genius.com/search?q=${encodeURIComponent(query)}`;
}

function getCachedLyrics(artist, title) {
    const cacheKey = buildCacheKey(artist, title);
    return lyricsCache[cacheKey] || null;
}

function setCachedLyrics(artist, title, payload) {
    const cacheKey = buildCacheKey(artist, title);
    lyricsCache[cacheKey] = {
        ...payload,
        cachedAt: new Date().toISOString()
    };
    saveLyricsCache();
}

function resetGeniusBrowserIdleTimer() {
    if (sharedGeniusBrowserIdleTimer) {
        clearTimeout(sharedGeniusBrowserIdleTimer);
    }

    sharedGeniusBrowserIdleTimer = setTimeout(async () => {
        if (!sharedGeniusBrowser) {
            return;
        }

        try {
            await sharedGeniusBrowser.close();
        } catch {
            // Ignore browser close errors on idle cleanup.
        } finally {
            sharedGeniusBrowser = null;
            sharedGeniusBrowserPromise = null;
            sharedGeniusBrowserIdleTimer = null;
        }
    }, GENIUS_BROWSER_IDLE_MS);
}

function pauseGeniusBrowserIdleTimer() {
    if (sharedGeniusBrowserIdleTimer) {
        clearTimeout(sharedGeniusBrowserIdleTimer);
        sharedGeniusBrowserIdleTimer = null;
    }
}

async function getSharedGeniusBrowser() {
    if (sharedGeniusBrowser) {
        resetGeniusBrowserIdleTimer();
        return sharedGeniusBrowser;
    }

    if (!sharedGeniusBrowserPromise) {
        sharedGeniusBrowserPromise = puppeteer.launch({
            headless: false,
            args: [
                '--window-size=800,600',
                '--window-position=-10000,-10000',
                '--disable-backgrounding-occluded-windows',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=CalculateNativeWinOcclusion'
            ]
        }).then(browser => {
            sharedGeniusBrowser = browser;
            browser.on('disconnected', () => {
                sharedGeniusBrowser = null;
                sharedGeniusBrowserPromise = null;
                if (sharedGeniusBrowserIdleTimer) {
                    clearTimeout(sharedGeniusBrowserIdleTimer);
                    sharedGeniusBrowserIdleTimer = null;
                }
            });
            resetGeniusBrowserIdleTimer();
            return browser;
        }).catch(error => {
            sharedGeniusBrowser = null;
            sharedGeniusBrowserPromise = null;
            throw error;
        });
    }

    const browser = await sharedGeniusBrowserPromise;
    resetGeniusBrowserIdleTimer();
    return browser;
}

async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'spoty-extension/1.0',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`LRCLIB request failed with status ${response.status}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchTextWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            ...options
        });

        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }

        return await response.text();
    } finally {
        clearTimeout(timeout);
    }
}

function createLyricsNotFoundError(message) {
    const error = new Error(message);
    error.code = LYRICS_NOT_FOUND;
    return error;
}

function decodeHtmlEntities(value) {
    return value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function decodeEscapedJsonString(value) {
    try {
        return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    } catch {
        return value;
    }
}

function extractLyricsFromHtml(html) {
    const matches = [...html.matchAll(/<div[^>]*data-lyrics-container=["']true["'][^>]*>([\s\S]*?)<\/div>/gi)];

    if (matches.length > 0) {
        const text = matches
            .map(match => match[1])
            .join('\n')
            .replace(/<a\b[^>]*>/gi, '')
            .replace(/<\/a>/gi, '')
            .replace(/<[^>]+>/g, '')
            .trim();

        const decoded = decodeHtmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
        if (decoded) {
            return decoded;
        }
    }

    const escapedHtmlMatch =
        html.match(/"body"\s*:\s*\{\s*"html"\s*:\s*"((?:\\.|[^"])*)"/i) ||
        html.match(/"lyrics"\s*:\s*"((?:\\.|[^"])*)"/i);

    if (!escapedHtmlMatch) {
        return null;
    }

    const unescaped = decodeEscapedJsonString(escapedHtmlMatch[1]);
    const stripped = unescaped
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<a\b[^>]*>/gi, '')
        .replace(/<\/a>/gi, '')
        .replace(/<[^>]+>/g, '');

    const decoded = decodeHtmlEntities(stripped).replace(/\n{3,}/g, '\n\n').trim();
    return decoded || null;
}

function extractGeniusSongUrlsFromSearchHtml(html) {
    const urlMatches = [
        ...html.matchAll(/https:\/\/genius\.com\/([a-z0-9-]+-lyrics)/gi),
        ...html.matchAll(/href=["']\/([a-z0-9-]+-lyrics)["']/gi)
    ];

    return uniqueNonEmpty(
        urlMatches.map(match => `https://genius.com/${match[1]}`)
    );
}

function scoreGeniusSongUrl(url, artist, title) {
    const normalizedUrl = normalizeSearchText(url);
    let score = 0;

    for (const artistVariant of buildArtistVariants(artist)) {
        const normalizedArtistVariant = normalizeSearchText(artistVariant);
        if (normalizedArtistVariant && normalizedUrl.includes(normalizedArtistVariant)) {
            score += 4;
        }
    }

    for (const titleVariant of buildTitleVariants(title)) {
        const normalizedTitleVariant = normalizeSearchText(titleVariant);
        if (!normalizedTitleVariant) {
            continue;
        }

        if (normalizedUrl.includes(normalizedTitleVariant)) {
            score += 6;
        } else if (
            normalizedTitleVariant.split(' ').every(token => token && normalizedUrl.includes(token))
        ) {
            score += 3;
        }
    }

    return score;
}

function isIgnorableInjectionError(error) {
    const message = error && error.message ? error.message : '';
    return (
        message.includes('ETIMEDOUT') ||
        message.includes('ECONNREFUSED') ||
        message.includes('socket hang up') ||
        message.includes('WebSocket was closed before the connection was established')
    );
}

function scoreLrclibResult(item, artist, title) {
    const normalizedArtist = normalizeSearchText(artist);
    const normalizedTitle = normalizeSearchText(title);
    const itemArtist = normalizeSearchText(item.artistName);
    const itemTitle = normalizeSearchText(item.trackName);
    const itemAlbum = normalizeSearchText(item.albumName);
    let score = 0;

    if (itemTitle === normalizedTitle) {
        score += 8;
    } else if (itemTitle.includes(normalizedTitle) || normalizedTitle.includes(itemTitle)) {
        score += 4;
    }

    if (itemArtist === normalizedArtist) {
        score += 6;
    } else if (itemArtist.includes(normalizedArtist) || normalizedArtist.includes(itemArtist)) {
        score += 3;
    }

    if (itemAlbum && normalizedTitle.includes(itemAlbum)) {
        score -= 1;
    }

    if (item.syncedLyrics) {
        score += 1;
    }

    if (item.plainLyrics) {
        score += 1;
    }

    return score;
}

async function searchLrclibLyrics(artist, title) {
    const params = new URLSearchParams({
        track_name: title,
        artist_name: artist
    });
    const results = await fetchJsonWithTimeout(`https://lrclib.net/api/search?${params.toString()}`);

    if (!Array.isArray(results) || results.length === 0) {
        throw createLyricsNotFoundError(`No LRCLIB result matched for "${artist} - ${title}"`);
    }

    const bestMatch = [...results]
        .sort((a, b) => scoreLrclibResult(b, artist, title) - scoreLrclibResult(a, artist, title))[0];

    const lyrics = (bestMatch.plainLyrics || stripLrcTimestamps(bestMatch.syncedLyrics || '')).trim();

    if (!lyrics) {
        throw createLyricsNotFoundError(`No LRCLIB lyrics matched for "${artist} - ${title}"`);
    }

    return {
        source: 'lrclib',
        artist: bestMatch.artistName || artist,
        title: bestMatch.trackName || title,
        album: bestMatch.albumName || null,
        duration: bestMatch.duration || null,
        lyrics,
        syncedLyrics: bestMatch.syncedLyrics || null
    };
}

async function searchLyricsOvhLyrics(artist, title) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
            {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'spoty-extension/1.0',
                    'Accept': 'application/json'
                }
            }
        );

        if (response.status === 404) {
            throw createLyricsNotFoundError(`No lyrics.ovh result matched for "${artist} - ${title}"`);
        }

        if (!response.ok) {
            throw new Error(`lyrics.ovh request failed with status ${response.status}`);
        }

        const results = await response.json();
        const lyrics = (results?.lyrics || '').trim();
        if (!lyrics) {
            throw createLyricsNotFoundError(`No lyrics.ovh result matched for "${artist} - ${title}"`);
        }

        return {
            source: 'lyrics.ovh',
            artist,
            title,
            album: null,
            duration: null,
            lyrics,
            syncedLyrics: null
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function searchGeniusScrapeLyrics(artist, title) {
    let browser;
    let page;

    try {
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--window-size=800,600',
                '--window-position=-10000,-10000',
                '--start-minimized',
                '--disable-backgrounding-occluded-windows',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=CalculateNativeWinOcclusion'
            ]
        });

        page = await browser.newPage();
        const closeBrowserAfter = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Browser closed due to timeout')), 90000)
        );

        const fetchLyrics = async () => {
            const searchUrl = `https://genius.com/search?q=${encodeURIComponent(title)}%20${encodeURIComponent(artist)}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle2' });

            const firstSongSelector = 'search-result-section div[ng-if="$ctrl.section.hits.length > 0"] search-result-item a';
            await page.waitForSelector(firstSongSelector);
            const songPageUrl = await page.$eval(firstSongSelector, a => a.href);

            await page.goto(songPageUrl, { waitUntil: 'networkidle2' });

            const lyricsSelector = 'div[data-lyrics-container="true"]';
            await page.waitForSelector(lyricsSelector);

            const lyricsElements = await page.$$eval(lyricsSelector, elements => elements.map(el => el.innerText));
            return lyricsElements.join('\n');
        };

        const lyrics = await Promise.race([fetchLyrics(), closeBrowserAfter]);

        return {
            source: 'genius-scrape',
            artist,
            title,
            album: null,
            duration: null,
            lyrics,
            syncedLyrics: null
        };
    } catch (error) {
        const message = error && error.message ? error.message : '';
        const causeMessage = error && error.cause && error.cause.message ? error.cause.message : '';
        const fullMessage = `${message} ${causeMessage}`;

        if (
            fullMessage.includes('Waiting for selector') ||
            fullMessage.includes('Session closed') ||
            fullMessage.includes('TargetCloseError') ||
            fullMessage.includes('Browser closed due to timeout')
        ) {
            throw createLyricsNotFoundError(`No Genius lyrics page matched for "${artist} - ${title}"`);
        }

        throw error;
    } finally {
        if (page) {
            try {
                await page.close();
            } catch {
                // Ignore page close failures.
            }
        }

        if (browser) {
            try {
                await browser.close();
            } catch {
                // Ignore browser close failures.
            }
        }
    }
}

async function resolveLyrics(artist, title) {
    const cachedLyrics = getCachedLyrics(artist, title);
    if (cachedLyrics) {
        console.log(`[lyrics] cache hit: ${cachedLyrics.artist} - ${cachedLyrics.title}`);
        return { lyricsResult: cachedLyrics, fromCache: true };
    }

    try {
        return { lyricsResult: await searchLrclibLyrics(artist, title), fromCache: false };
    } catch (lrclibError) {
        if (lrclibError.code !== LYRICS_NOT_FOUND) {
            throw lrclibError;
        }

        console.warn(`[lyrics] ${lrclibError.message}, falling back to lyrics.ovh`);
        try {
            return { lyricsResult: await searchLyricsOvhLyrics(artist, title), fromCache: false };
        } catch (ovhError) {
            if (ovhError.code !== LYRICS_NOT_FOUND) {
                throw ovhError;
            }

            console.warn(`[lyrics] ${ovhError.message}, falling back to Genius scrape`);
            return { lyricsResult: await searchGeniusScrapeLyrics(artist, title), fromCache: false };
        }
    }
}

app.get('/lyrics', async (req, res) => {
    const { artist, title } = req.query;

    if (!artist || !title) {
        return res.status(400).send('Artist and title are required');
    }

    const requestKey = buildCacheKey(artist, title);
    let lyricsRequest = inFlightLyricsRequests.get(requestKey);

    if (!lyricsRequest) {
        lyricsRequest = resolveLyrics(artist, title)
            .then(({ lyricsResult, fromCache }) => {
                if (!fromCache && !getCachedLyrics(artist, title)) {
                    setCachedLyrics(artist, title, lyricsResult);
                }
                return { lyricsResult, fromCache };
            })
            .finally(() => {
                inFlightLyricsRequests.delete(requestKey);
            });

        inFlightLyricsRequests.set(requestKey, lyricsRequest);
    }

    try {
        const { lyricsResult, fromCache } = await lyricsRequest;
        if (!fromCache) {
            console.log(`[lyrics] ${lyricsResult.source}: ${lyricsResult.artist} - ${lyricsResult.title}`);
        }
        res.json(lyricsResult);
    } catch (error) {
        if (error.code === LYRICS_NOT_FOUND) {
            console.warn(`[lyrics] ${error.message}`);
            res.status(404).json({ error: 'Lyrics not found' });
            return;
        }

        console.error('Error:', error);
        res.status(500).json({ error: 'Failed to fetch lyrics' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

let spotifyInjectionInFlight = false;

function injectScriptViaCdp(webSocketDebuggerUrl, scriptSource) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(webSocketDebuggerUrl);
        const scriptVersion = crypto.createHash('sha1').update(scriptSource).digest('hex');
        const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error('CDP injection timed out'));
        }, 10000);

        const finish = (error, result) => {
            clearTimeout(timeout);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }

            if (error) {
                reject(error);
                return;
            }

            resolve(result);
        };

        socket.on('open', () => {
            const expression = `(() => {
                const version = ${JSON.stringify(scriptVersion)};
                const panelExists = !!document.getElementById('lyrics-panel');
                const runtimeAlive = !!(window.__lyricsPluginRuntime && window.__lyricsPluginRuntime.intervalId);
                if (window.__lyricsPluginVersion === version && (panelExists || runtimeAlive)) {
                    return 'already-injected';
                }

                const source = ${JSON.stringify(scriptSource)};
                const inject = () => {
                    const panelStillExists = !!document.getElementById('lyrics-panel');
                    const runtimeStillAlive = !!(window.__lyricsPluginRuntime && window.__lyricsPluginRuntime.intervalId);
                    if (window.__lyricsPluginVersion === version && (panelStillExists || runtimeStillAlive)) {
                        return 'already-injected';
                    }

                    window.__lyricsPluginVersion = version;
                    const script = document.createElement('script');
                    script.textContent = source;
                    (document.documentElement || document.body).appendChild(script);
                    script.remove();
                    return 'injected';
                };

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', inject, { once: true });
                    return 'scheduled';
                }

                return inject();
            })()`;

            socket.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression,
                    awaitPromise: true,
                    returnByValue: true
                }
            }));
        });

        socket.on('message', (rawMessage) => {
            try {
                const message = JSON.parse(rawMessage.toString());
                if (message.id !== 1) {
                    return;
                }

                if (message.error) {
                    finish(new Error(message.error.message));
                    return;
                }

                if (message.result && message.result.exceptionDetails) {
                    const text = message.result.exceptionDetails.text || 'Runtime.evaluate failed';
                    finish(new Error(text));
                    return;
                }

                finish(null, message.result?.result?.value || 'unknown');
            } catch (error) {
                finish(error);
            }
        });

        socket.on('error', (error) => {
            finish(error);
        });

        socket.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

function evaluateSpotifyPage(webSocketDebuggerUrl, expression) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error('CDP evaluation timed out'));
        }, 10000);

        const finish = (error, result) => {
            clearTimeout(timeout);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }

            if (error) {
                reject(error);
                return;
            }

            resolve(result);
        };

        socket.on('open', () => {
            socket.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression,
                    awaitPromise: true,
                    returnByValue: true
                }
            }));
        });

        socket.on('message', (rawMessage) => {
            try {
                const message = JSON.parse(rawMessage.toString());
                if (message.id !== 1) {
                    return;
                }

                if (message.error) {
                    finish(new Error(message.error.message));
                    return;
                }

                if (message.result && message.result.exceptionDetails) {
                    const text = message.result.exceptionDetails.text || 'Runtime.evaluate failed';
                    finish(new Error(text));
                    return;
                }

                finish(null, message.result?.result?.value);
            } catch (error) {
                finish(error);
            }
        });

        socket.on('error', (error) => {
            finish(error);
        });

        socket.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

app.get('/debug-spotify', async (req, res) => {
    http.get('http://127.0.0.1:9222/json', async (debugRes) => {
        let data = '';
        debugRes.on('data', chunk => data += chunk);
        debugRes.on('end', async () => {
            try {
                const targets = JSON.parse(data);
                const spotifyTarget = targets.find(t => t.type === 'page' && t.url && t.url.includes('spotify.com'));

                if (!spotifyTarget || !spotifyTarget.webSocketDebuggerUrl) {
                    res.status(404).json({ error: 'Spotify target not found' });
                    return;
                }

                const result = await evaluateSpotifyPage(
                    spotifyTarget.webSocketDebuggerUrl,
                    `(() => ({
                        readyState: document.readyState,
                        title: document.title,
                        url: location.href,
                        rightSidebarClassExists: !!document.querySelector('.Root__right-sidebar'),
                        rightSidebarTestIdExists: !!document.querySelector('[data-testid="right-sidebar"]'),
                        nowPlayingAriaExists: !!document.querySelector('.main-nowPlayingWidget-nowPlaying[aria-label]'),
                        nowPlayingBarExists: !!document.querySelector('[data-testid="now-playing-widget"]'),
                        playerBarText: document.querySelector('[data-testid="now-playing-widget"]')?.innerText || null,
                        allTestIds: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 40).map(el => el.getAttribute('data-testid'))
                    }))()`
                );

                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }).on('error', (error) => {
        res.status(500).json({ error: error.message });
    });
});

// --- Spotify Auto-Injector ---
// Checks every 5 seconds if Spotify is running with CDP and injects lyrics.js
setInterval(() => {
    if (spotifyInjectionInFlight) {
        return;
    }

    const req = http.get('http://127.0.0.1:9222/json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', async () => {
            try {
                const targets = JSON.parse(data);
                const spotifyTarget = targets.find(t => t.type === 'page' && t.url && t.url.includes('spotify.com'));

                if (!spotifyTarget || !spotifyTarget.webSocketDebuggerUrl) {
                    return;
                }

                const lastInjectionAt = lastInjectionAtByTarget.get(spotifyTarget.webSocketDebuggerUrl) || 0;
                if (Date.now() - lastInjectionAt < INJECT_COOLDOWN_MS) {
                    return;
                }

                spotifyInjectionInFlight = true;
                const lyricsCode = fs.readFileSync(path.join(__dirname, 'lyrics.js'), 'utf8');
                const result = await injectScriptViaCdp(spotifyTarget.webSocketDebuggerUrl, lyricsCode);
                lastInjectionAtByTarget.set(spotifyTarget.webSocketDebuggerUrl, Date.now());

                if (result === 'injected' || result === 'scheduled') {
                    console.log(`Spotify injection: ${result}`);
                }
            } catch (err) {
                if (!isIgnorableInjectionError(err)) {
                    console.error('Injection error:', err.message);
                }
            } finally {
                spotifyInjectionInFlight = false;
            }
        });
    });

    req.on('error', (e) => {
        // Spotify is not running or port 9222 is closed
        // console.error('CDP Error:', e.message); // Uncomment to debug connection
    });
}, 5000);
