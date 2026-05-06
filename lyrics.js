(function LyricsPlugin() {
    if (window.__lyricsPluginRuntime && window.__lyricsPluginRuntime.intervalId) {
        clearInterval(window.__lyricsPluginRuntime.intervalId);
    }

    const lyricsServerUrl = 'http://localhost:3217/lyrics';
    const updateInterval = 1000; 
    const panelWidth = 360;
    const topChromeCoverExtra = 13;
    const headerHeightCap = 80;
    let currentSong = null;
    let requestToken = 0;
    let lyricsContainer = null;
    let lyricsHeader = null;
    let lyricsBody = null;
    let headerTitle = null;
    let headerMeta = null;

    function bindExistingPanelReferences() {
        lyricsContainer = document.getElementById('lyrics-panel');
        lyricsHeader = document.getElementById('lyrics-panel-header');
        lyricsBody = document.getElementById('lyrics-panel-body');
        headerTitle = document.getElementById('lyrics-panel-title');
        headerMeta = document.getElementById('lyrics-panel-meta');
    }

    function cleanupDuplicatePanels() {
        const panels = Array.from(document.querySelectorAll('#lyrics-panel'));
        if (panels.length <= 1) {
            bindExistingPanelReferences();
            return;
        }

        const [firstPanel, ...duplicatePanels] = panels;
        duplicatePanels.forEach(panel => panel.remove());
        lyricsContainer = firstPanel;
        lyricsHeader = firstPanel.querySelector('#lyrics-panel-header');
        lyricsBody = firstPanel.querySelector('#lyrics-panel-body');
        headerTitle = firstPanel.querySelector('#lyrics-panel-title');
        headerMeta = firstPanel.querySelector('#lyrics-panel-meta');
    }

    function cleanupLegacyToggleButtons() {
        document.querySelectorAll('#lyrics-global-toggle').forEach(button => button.remove());
    }

    function reserveSpaceForPanel() {
        document.documentElement.style.overflowX = 'hidden';
        document.body.style.overflowX = 'hidden';
        document.body.style.boxSizing = 'border-box';
        document.body.style.paddingRight = `${panelWidth}px`;

        const targets = [
            document.querySelector('#main'),
            document.querySelector('.Root')
        ].filter(Boolean);

        for (const target of targets) {
            target.style.boxSizing = 'border-box';
            target.style.maxWidth = `calc(100vw - ${panelWidth}px)`;
            target.style.width = `calc(100vw - ${panelWidth}px)`;
            target.style.minWidth = '0';
        }
    }

    function getTopChromeHeight() {
        const candidates = [
            document.querySelector('.main-topBar-topbarContentWrapper'),
            document.querySelector('.main-topBar-topbarContent'),
            document.querySelector('[data-testid="topbar-content"]')
        ].filter(Boolean);

        for (const element of candidates) {
            const rect = element.getBoundingClientRect();
            const height = Math.round(rect.height);
            if (height >= 40 && height <= 72) {
                return height;
            }
        }

        return 54;
    }

    function hasFullHeaderStructure() {
        return Boolean(
            lyricsContainer &&
            lyricsHeader &&
            lyricsBody &&
            headerTitle &&
            headerMeta
        );
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function updateHeader(songInfo = {}) {
        if (!headerTitle || !headerMeta) {
            return;
        }

        headerTitle.textContent = songInfo.title || 'Lyrics';
        headerMeta.textContent = songInfo.artist || 'Waiting for track';
    }

    function renderLoadingState(songInfo) {
        if (!lyricsBody) {
            return;
        }

        updateHeader(songInfo, 'Loading');
        lyricsBody.innerHTML = `
            <div id="lyrics-loading-state" style="display:flex;flex-direction:column;gap:12px;padding-top:4px;">
                <div style="height:14px;width:72%;border-radius:999px;background:linear-gradient(90deg,#1b1f26 25%,#2a3039 50%,#1b1f26 75%);background-size:200% 100%;animation:lyricsShimmer 1.3s linear infinite;"></div>
                <div style="height:14px;width:91%;border-radius:999px;background:linear-gradient(90deg,#1b1f26 25%,#2a3039 50%,#1b1f26 75%);background-size:200% 100%;animation:lyricsShimmer 1.3s linear infinite;"></div>
                <div style="height:14px;width:83%;border-radius:999px;background:linear-gradient(90deg,#1b1f26 25%,#2a3039 50%,#1b1f26 75%);background-size:200% 100%;animation:lyricsShimmer 1.3s linear infinite;"></div>
                <div style="height:14px;width:88%;border-radius:999px;background:linear-gradient(90deg,#1b1f26 25%,#2a3039 50%,#1b1f26 75%);background-size:200% 100%;animation:lyricsShimmer 1.3s linear infinite;"></div>
                <div style="height:14px;width:66%;border-radius:999px;background:linear-gradient(90deg,#1b1f26 25%,#2a3039 50%,#1b1f26 75%);background-size:200% 100%;animation:lyricsShimmer 1.3s linear infinite;"></div>
            </div>
        `;
    }

    function renderErrorState(message, songInfo) {
        if (!lyricsBody) {
            return;
        }

        updateHeader(songInfo, 'Not found');
        lyricsBody.innerHTML = `
            <div style="padding-top:4px;display:flex;flex-direction:column;gap:8px;">
                <div style="font-size:15px;font-weight:700;color:#ffffff;">Lyrics not found</div>
                <div style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.68);">${escapeHtml(message || 'This track did not return lyrics from the active sources.')}</div>
            </div>
        `;
    }

    function renderLyricsState(lyrics, songInfo, sourceLabel) {
        if (!lyricsBody) {
            return;
        }

        updateHeader(songInfo, sourceLabel);
        const content = document.createElement('div');
        content.style.whiteSpace = 'pre-wrap';
        content.style.wordBreak = 'break-word';
        content.style.lineHeight = '1.6';
        content.textContent = sanitizeLyrics(lyrics);
        lyricsBody.innerHTML = '';
        lyricsBody.appendChild(content);
        lyricsBody.scrollTop = 0;
    }

    function ensureLyricsContainer() {
        cleanupDuplicatePanels();
        cleanupLegacyToggleButtons();
        reserveSpaceForPanel();
        const topChromeHeight = getTopChromeHeight();
        const headerHeight = Math.min(headerHeightCap, topChromeHeight + topChromeCoverExtra);

        if (lyricsContainer && document.body.contains(lyricsContainer)) {
            if (!hasFullHeaderStructure()) {
                lyricsContainer.remove();
                lyricsContainer = null;
                lyricsHeader = null;
                lyricsBody = null;
                headerTitle = null;
                headerMeta = null;
            } else {
                if (lyricsHeader) {
                    lyricsHeader.style.height = `${headerHeight}px`;
                }
                if (lyricsBody) {
                    lyricsBody.style.paddingTop = '16px';
                }
                return lyricsContainer;
            }
        }

        if (lyricsContainer && !document.body.contains(lyricsContainer)) {
            lyricsContainer = null;
            lyricsHeader = null;
            lyricsBody = null;
            headerTitle = null;
            headerMeta = null;
        }

        lyricsContainer = document.createElement('div');
        lyricsContainer.id = 'lyrics-panel';
        lyricsContainer.className = 'lyrics-container';
        lyricsContainer.style.position = 'fixed';
        lyricsContainer.style.top = '0';
        lyricsContainer.style.right = '0';
        lyricsContainer.style.width = `${panelWidth}px`;
        lyricsContainer.style.minWidth = `${panelWidth}px`;
        lyricsContainer.style.maxWidth = `${panelWidth}px`;
        lyricsContainer.style.height = '100vh';
        lyricsContainer.style.boxSizing = 'border-box';
        lyricsContainer.style.overflow = 'hidden';
        lyricsContainer.style.background = '#111317';
        lyricsContainer.style.color = '#fff';
        lyricsContainer.style.borderLeft = '1px solid rgba(255, 255, 255, 0.08)';
        lyricsContainer.style.fontFamily = 'Trebuchet MS, sans-serif';
        lyricsContainer.style.fontSize = '16px';
        lyricsContainer.style.display = 'flex';
        lyricsContainer.style.flexDirection = 'column';
        lyricsContainer.style.overflowX = 'hidden';
        lyricsContainer.style.zIndex = '999999';

        lyricsHeader = document.createElement('div');
        lyricsHeader.id = 'lyrics-panel-header';
        lyricsHeader.style.position = 'sticky';
        lyricsHeader.style.top = '0';
        lyricsHeader.style.left = '0';
        lyricsHeader.style.right = '0';
        lyricsHeader.style.flex = '0 0 auto';
        lyricsHeader.style.height = `${headerHeight}px`;
        lyricsHeader.style.background = '#000';
        lyricsHeader.style.borderLeft = '1px solid rgba(255, 255, 255, 0.08)';
        lyricsHeader.style.borderBottom = '1px solid rgba(255, 255, 255, 0.18)';
        lyricsHeader.style.boxShadow = '0 10px 24px rgba(0, 0, 0, 0.35)';
        lyricsHeader.style.zIndex = '2';
        lyricsHeader.style.pointerEvents = 'auto';
        lyricsHeader.style.display = 'flex';
        lyricsHeader.style.alignItems = 'center';
        lyricsHeader.style.justifyContent = 'flex-start';
        lyricsHeader.style.padding = '0 9px 0 11px';
        lyricsHeader.style.boxSizing = 'border-box';
        lyricsHeader.style.position = 'sticky';

        const headerText = document.createElement('div');
        headerText.style.display = 'flex';
        headerText.style.flexDirection = 'column';
        headerText.style.justifyContent = 'center';
        headerText.style.alignItems = 'flex-start';
        headerText.style.textAlign = 'left';
        headerText.style.minWidth = '0';
        headerText.style.flex = '1 1 auto';

        headerTitle = document.createElement('div');
        headerTitle.id = 'lyrics-panel-title';
        headerTitle.style.fontSize = '14px';
        headerTitle.style.fontWeight = '700';
        headerTitle.style.lineHeight = '1.15';
        headerTitle.style.whiteSpace = 'nowrap';
        headerTitle.style.overflow = 'hidden';
        headerTitle.style.textOverflow = 'ellipsis';
        headerTitle.textContent = 'Lyrics';

        headerMeta = document.createElement('div');
        headerMeta.id = 'lyrics-panel-meta';
        headerMeta.style.fontSize = '11px';
        headerMeta.style.color = 'rgba(255,255,255,0.72)';
        headerMeta.style.whiteSpace = 'nowrap';
        headerMeta.style.overflow = 'hidden';
        headerMeta.style.textOverflow = 'ellipsis';
        headerMeta.style.minWidth = '0';
        headerMeta.style.maxWidth = '100%';
        headerMeta.style.textAlign = 'left';
        headerMeta.textContent = 'Waiting for track';

        headerText.appendChild(headerTitle);
        headerText.appendChild(headerMeta);

        lyricsHeader.appendChild(headerText);

        lyricsBody = document.createElement('div');
        lyricsBody.id = 'lyrics-panel-body';
        lyricsBody.style.position = 'relative';
        lyricsBody.style.zIndex = '1';
        lyricsBody.style.flex = '1 1 auto';
        lyricsBody.style.minHeight = '0';
        lyricsBody.style.overflowY = 'auto';
        lyricsBody.style.overflowX = 'hidden';
        lyricsBody.style.padding = '16px 20px 20px';
        lyricsBody.style.scrollbarGutter = 'stable';
        lyricsBody.style.scrollbarWidth = 'thin';
        lyricsBody.style.scrollbarColor = '#3b3f46 #111317';
        lyricsBody.style.boxSizing = 'border-box';

        lyricsContainer.appendChild(lyricsHeader);
        lyricsContainer.appendChild(lyricsBody);
        document.body.appendChild(lyricsContainer);
        updateHeader();
        return lyricsContainer;
    }

    function sanitizeLyrics(rawLyrics) {
        if (!rawLyrics) {
            return 'Lyrics not found :(';
        }

        const lines = rawLyrics.split('\n');
        const cleaned = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                cleaned.push('');
                continue;
            }

            if (/^\d+\s+Contributors?$/i.test(trimmed)) {
                continue;
            }

            if (/^Paroles de la chanson/i.test(trimmed)) {
                continue;
            }

            if (/^\d*Embed$/i.test(trimmed)) {
                continue;
            }

            cleaned.push(line);
        }

        while (cleaned.length > 0 && !cleaned[0].trim()) {
            cleaned.shift();
        }

        while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) {
            cleaned.pop();
        }

        return cleaned.join('\n');
    }

    function fetchLyricsFromServer(artist, title) {
        return fetch(`${lyricsServerUrl}?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`)
            .then(response => {
                if (!response.ok) {
                    return null;
                }

                return response.json();
            })
            .catch(error => {
                console.error('Error fetching lyrics from server:', error);
                return null;
            });
    }

    function normalizeSongInfo(title, artist) {
        if (!title || !artist) {
            return null;
        }

        return {
            title: title.trim(),
            artist: artist.split(',')[0].trim()
        };
    }

    function extractFromMediaSession() {
        const metadata = navigator.mediaSession && navigator.mediaSession.metadata;
        if (!metadata) {
            return null;
        }

        return normalizeSongInfo(metadata.title, metadata.artist);
    }

    function extractFromNowPlayingWidget() {
        const widget = document.querySelector('[data-testid="now-playing-widget"]');
        if (!widget) {
            return null;
        }

        const trackLink =
            widget.querySelector('a[href*="/track/"]') ||
            widget.querySelector('[data-testid="context-item-link"]');

        const artistLinks = Array.from(widget.querySelectorAll('a[href*="/artist/"]'));
        const artistText = artistLinks.map(link => link.textContent.trim()).filter(Boolean).join(', ');

        return normalizeSongInfo(trackLink && trackLink.textContent, artistText);
    }

    function extractFromAriaLabel() {
        const nowPlayingElement = document.querySelector('.main-nowPlayingWidget-nowPlaying[aria-label]');
        if (!nowPlayingElement) {
            return null;
        }

        const nowPlaying = nowPlayingElement.getAttribute('aria-label');
        const match = nowPlaying && nowPlaying.match(/^Now playing: (.+) by (.+)$/);
        if (!match) {
            return null;
        }

        return normalizeSongInfo(match[1], match[2]);
    }

    function getCurrentSongInfo() {
        return extractFromMediaSession() || extractFromNowPlayingWidget() || extractFromAriaLabel();
    }

    function updateLyricsDisplay(lyrics, songInfo = currentSong, sourceLabel = '') {
        const container = ensureLyricsContainer();
        if (!container || !lyricsBody) {
            return;
        }

        renderLyricsState(lyrics, songInfo, sourceLabel);
    }

    function ensureAnimationStyle() {
        if (document.getElementById('lyrics-panel-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'lyrics-panel-style';
        style.textContent = `
            @keyframes lyricsShimmer {
                0% { background-position: 200% 0; }
                100% { background-position: -200% 0; }
            }
            #lyrics-panel-body::-webkit-scrollbar {
                width: 10px;
            }
            #lyrics-panel-body::-webkit-scrollbar-track {
                background: #111317;
            }
            #lyrics-panel-body::-webkit-scrollbar-thumb {
                background: #333842;
                border-radius: 999px;
                border: 2px solid #111317;
            }
            #lyrics-panel-body::-webkit-scrollbar-thumb:hover {
                background: #454c58;
            }
        `;
        document.head.appendChild(style);
    }

    function updateNowPlaying() {
        const songInfo = getCurrentSongInfo();

        if (songInfo) {
            if (!currentSong || currentSong.title !== songInfo.title || currentSong.artist !== songInfo.artist) {
                currentSong = songInfo;
                requestToken += 1;
                const currentRequestToken = requestToken;
                renderLoadingState(songInfo);
                fetchLyricsFromServer(songInfo.artist, songInfo.title).then(payload => {
                    const sameSongStillActive =
                        currentSong &&
                        currentSong.title === songInfo.title &&
                        currentSong.artist === songInfo.artist;

                    if (currentRequestToken !== requestToken || !sameSongStillActive) {
                        return;
                    }

                    if (payload && payload.lyrics) {
                        updateLyricsDisplay(payload.lyrics, songInfo, payload.source || 'Unknown');
                        return;
                    }

                    renderErrorState('This track did not return lyrics from LRCLIB, lyrics.ovh or Genius.', songInfo);
                });
            }
        } else {
            ensureLyricsContainer();
            updateHeader({}, 'Idle');
        }
    }

    ensureAnimationStyle();
    ensureLyricsContainer();
    window.__lyricsPluginRuntime = {
        intervalId: setInterval(updateNowPlaying, updateInterval)
    };
    updateNowPlaying();
})();
