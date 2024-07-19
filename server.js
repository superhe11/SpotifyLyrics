const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());

app.get('/lyrics', async (req, res) => {
    const { artist, title } = req.query;

    if (!artist || !title) {
        return res.status(400).send('Artist and title are required');
    }

    try {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        const searchUrl = `https://genius.com/search?q=${encodeURIComponent(title)}%20${encodeURIComponent(artist)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });

        const firstSongSelector = 'search-result-section div[ng-if="$ctrl.section.hits.length > 0"] search-result-item a';
        await page.waitForSelector(firstSongSelector);
        const songPageUrl = await page.$eval(firstSongSelector, a => a.href);

        await page.goto(songPageUrl, { waitUntil: 'networkidle2' });

        const lyricsSelector = 'div[data-lyrics-container="true"]';
        await page.waitForSelector(lyricsSelector);

        const lyricsElements = await page.$$eval(lyricsSelector, elements => elements.map(el => el.innerText));
        const lyrics = lyricsElements.join('\n');

        await browser.close();
        console.log(lyrics);
        res.send(lyrics);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Failed to fetch lyrics');
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
