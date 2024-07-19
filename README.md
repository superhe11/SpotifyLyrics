# SpotifyShowLyric
Extension for Spicetify that shows lyrics of current song.

![image](https://github.com/user-attachments/assets/19afd468-6ee4-4f25-96e3-ab5bc9843adc)


## Quick How-To-Guide
### 1) Setting up server
1. Download server.js and put it in C:\Users\ "Your User"
2. Download Node js (if you havn't already)
```
winget install -e --id OpenJS.NodeJS
```
3. Go for
```
npm install express puppeteer cors
```
4. Set up pm2. You can read about it [here](https://pm2.keymetrics.io/docs/usage/quick-start/)
5. Execute all this commands: 
   ```
   npm install pm2 -g
   npm install pm2-windows-startup -g
   pm2-startup install
   pm2 start server.js --name lyrics-server
   pm2 save
   ```
6. Run ```pm2 list```
   
   It should look like this:

   
   ![image_2024-07-18_12-36-42](https://github.com/user-attachments/assets/e5714707-75d9-403b-8f91-98efc2e7d874)

### 2) Setting up sctipt
1. Install Spicetify from [here](https://spicetify.app/docs/getting-started)
   
2. Go to C:\Users\ "Your User" \AppData\Local\spicetify\Extensions
   
3. Add lyrics.js file to **Extension** folder
   
4. Run in cmd
```
spicetify config extensions lyrics.js
```
5. Start spicetify with
```
spicetify apply
```

#Very Important note
Server is running on port 3000, if you need to change that, adjust line 4 (lyrics.js) and line 6 (server.js)

## Important note
I am using lyrics.ovh API, that has many, but not all songs. This method is very fast (<1sec)
If lyrics was not found script do manual search on Genius website, this can take 20-40sec
