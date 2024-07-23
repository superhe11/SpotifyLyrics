(function LyricsPlugin() {
    const proxyUrl = 'https://api.allorigins.win/raw?url=';
    const lyricsApiUrl = 'https://api.lyrics.ovh/v1/';
    const puppeteerServerUrl = 'http://localhost:3000/lyrics';
    const updateInterval = 1000;
    let currentSong = null;

    function fetchLyricsFromLyricsOvh(artist, title) {
        const encodedUrl = encodeURIComponent(`${lyricsApiUrl}${artist}/${title}`);
        return fetch(`${proxyUrl}${encodedUrl}`)
            .then(response => response.json())
            .then(data => data.lyrics)
            .catch(error => {
                console.error('Error:', error);
                return null;
            });
    }

    function fetchLyricsFromPuppeteer(artist, title) {
        return fetch(`${puppeteerServerUrl}?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`)
            .then(response => response.text())
            .catch(error => {
                console.error('Error fetching lyrics from server:', error);
                return null;
            });
    }

    function extractArtistAndTitle(nowPlaying) {
        const match = nowPlaying.match(/^Now playing: (.+) by (.+)$/);
        if (match) {
            const parts = nowPlaying.split(/ by (?!.* by )/);
            if (parts.length === 2) {
                const title = parts[0].replace(/^Now playing: /, '');
                const artist = parts[1].split(',')[0].trim();
                return { title, artist };
            }
        }
        return null;
    }

    function updateLyricsDisplay(lyrics) {
        const rightSidebar = document.querySelector('.Root__right-sidebar');
        if (rightSidebar) {
            let lyricsContainer = rightSidebar.querySelector('.lyrics-container');
            if (!lyricsContainer) {
                lyricsContainer = document.createElement('div');
                lyricsContainer.classList.add('lyrics-container');
                rightSidebar.appendChild(lyricsContainer);
            }

            if (!lyrics) {
                lyrics = 'Lyrics not found :(';
            } else {
                const lines = lyrics.split('\n');
                if (lines.length > 0 && lines[0].startsWith('Paroles de la chanson')) {
                    lines.shift();
                }
                lyrics = lines.join('\n'); 
            }

            lyricsContainer.textContent = lyrics;
            lyricsContainer.style.width = '70%';
            lyricsContainer.style.height = 'auto';
            lyricsContainer.style.overflow = 'auto';
            lyricsContainer.style.padding = '3%';
            lyricsContainer.style.lineHeight = '1.6';
            lyricsContainer.style.whiteSpace = 'pre-wrap';
            lyricsContainer.style.wordWrap = 'break-word';
            lyricsContainer.style.textAlign = 'left';
            lyricsContainer.style.fontFamily = 'Trebuchet MS, sans-serif';
            lyricsContainer.style.fontSize = '20px';

            lyricsContainer.scrollTop = 0;
        } else {
            console.log('Cannot find element .Root__right-sidebar');
        }

        console.log('Song name:', lyrics);
    }

    function updateNowPlaying() {
        const nowPlayingElement = document.querySelector('.main-nowPlayingWidget-nowPlaying[aria-label]');
        if (nowPlayingElement) {
            const nowPlaying = nowPlayingElement.getAttribute('aria-label');
            const songInfo = extractArtistAndTitle(nowPlaying);
            if (songInfo) {
                if (!currentSong || currentSong.title !== songInfo.title || currentSong.artist !== songInfo.artist) {
                    currentSong = songInfo;
                    fetchLyricsFromLyricsOvh(songInfo.artist, songInfo.title).then(lyrics => {
                        if (!lyrics) {
                            updateLyricsDisplay('Lyrics not found, trying different method, it could take a while(10-20sec)...');
                            fetchLyricsFromPuppeteer(songInfo.artist, songInfo.title).then(puppeteerLyrics => {
                                updateLyricsDisplay(puppeteerLyrics || 'Lyrics not found :(');
                            });
                        } else {
                            updateLyricsDisplay(lyrics);
                        }
                    });
                }
            } else {
                console.log('Cannot get song info');
            }
        } else {
            console.log('Cannot find aria-label element');
        }
    }

    setInterval(updateNowPlaying, updateInterval);
})();
