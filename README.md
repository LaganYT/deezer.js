# deezer.js

A simple Node.js package to interact with the Deezer API with track decryption support.

## Installation

```bash
npm install @loganlatham/deezer.js
```

## Features

- Search for tracks, albums, artists, and playlists
- Get detailed information about entities by ID or URL
- Download and decrypt tracks (MP3 and FLAC)
- ARL cookie authentication required for all API requests
- Premium account ARL required for FLAC quality

## API Reference

### Constructor

```js
new Deezer(arl?: string)
```

- `arl` (optional): Deezer ARL cookie required for all API requests. Premium account ARL required for FLAC quality.

### Methods

#### `search(query: string, type?: EntityType): Promise<Array<Record<string, any>>>`

Searches for entities on Deezer. Requires ARL cookie authentication.

- `query`: Search query string
- `type` (optional): Entity type to search for (`"track"`, `"album"`, `"artist"`, `"playlist"`). Defaults to `"track"`

Returns an array of search results matching the entity type.

#### `get(idOrURL: string, type?: EntityType): Promise<Entity | null>`

Gets detailed information about an entity by ID or URL. Requires ARL cookie authentication.

- `idOrURL`: Entity ID or Deezer URL
- `type` (optional): Entity type. If not provided, will be inferred from the URL

Returns an `Entity` object with:
- `type`: The entity type
- `info`: Entity metadata
- `tracks`: Array of tracks (1 track for single tracks, multiple for albums/artists/playlists)

#### `getAndDecryptTrack(track: Record<string, any>, flac?: boolean): Promise<Buffer>`

Downloads and decrypts a track. Requires ARL cookie authentication.

- `track`: Track object from search or get results
- `flac` (optional): Whether to download in FLAC format (Premium account ARL required). Defaults to `false`

Returns a Buffer containing the decrypted audio data.

#### `api(method: string, body: Record<string, any>): Promise<Record<string, any>>`

Makes direct API calls to Deezer's internal API.

- `method`: Deezer API method name
- `body`: Request body object

## Examples

### Basic Usage

```js
const { writeFile } = require("fs/promises");
const Deezer = require("@loganlatham/deezer.js");

// Initialize with your ARL cookie (required for all API requests)
const deezer = new Deezer("your_arl_cookie_here");

(async () => {
    try {
        // Search for tracks
        const tracks = await deezer.search("Bohemian Rhapsody");
        console.log("Found tracks:", tracks.length);
        if (tracks[0]) {
            console.log("First track:", tracks[0].SNG_TITLE, "by", tracks[0].ART_NAME);
        }

        // Search for albums
        const albums = await deezer.search("A Night at the Opera", "album");
        console.log("Found albums:", albums.length);

        // Search for artists
        const artists = await deezer.search("Queen", "artist");
        console.log("Found artists:", artists.length);

        // Search for playlists
        const playlists = await deezer.search("Rock Classics", "playlist");
        console.log("Found playlists:", playlists.length);
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
```

### Getting Entity Details

```js
const Deezer = require("@loganlatham/deezer.js");

// Initialize with your ARL cookie (required for all API requests)
const deezer = new Deezer("your_arl_cookie_here");

(async () => {
    try {
        // Get track by ID
        const trackEntity = await deezer.get("3135556", "track");
        if (trackEntity) {
            console.log("Track:", trackEntity.info.SNG_TITLE);
            console.log("Artist:", trackEntity.info.ART_NAME);
            console.log("Tracks array length:", trackEntity.tracks.length); // Should be 1
        }

        // Get album by ID
        const albumEntity = await deezer.get("302127", "album");
        if (albumEntity) {
            console.log("Album:", albumEntity.info.ALB_TITLE);
            console.log("Artist:", albumEntity.info.ART_NAME);
            console.log("Number of tracks:", albumEntity.tracks.length);
        }

        // Get artist by ID
        const artistEntity = await deezer.get("412", "artist");
        if (artistEntity) {
            console.log("Artist:", artistEntity.info.ART_NAME);
            console.log("Top tracks:", artistEntity.tracks.length);
        }

        // Get playlist by ID
        const playlistEntity = await deezer.get("1234567890", "playlist");
        if (playlistEntity) {
            console.log("Playlist:", playlistEntity.info.PLAYLIST_TITLE);
            console.log("Number of tracks:", playlistEntity.tracks.length);
        }

        // Get entity from URL (type will be auto-detected)
        const entity = await deezer.get("https://www.deezer.com/en/album/302127");
        if (entity) {
            console.log("Entity type:", entity.type);
            console.log("Entity info:", entity.info.ALB_TITLE || entity.info.SNG_TITLE);
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
```

### Downloading Tracks

```js
const { writeFile } = require("fs/promises");
const Deezer = require("@loganlatham/deezer.js");

// Initialize with your ARL cookie (required for all API requests)
const deezer = new Deezer("your_arl_cookie_here");

(async () => {
    try {
        // Search for a track
        const tracks = await deezer.search("Bohemian Rhapsody");
        if (tracks.length === 0) {
            console.log("No tracks found");
            return;
        }

        const track = tracks[0];
        console.log(`Downloading: ${track.ART_NAME} - ${track.SNG_TITLE}`);

        // Download as MP3 (default)
        const trackBuffer = await deezer.getAndDecryptTrack(track);
        
        // Save to file
        const filename = `${track.ART_NAME} - ${track.SNG_TITLE}.mp3`;
        await writeFile(filename, trackBuffer);
        console.log(`Downloaded: ${filename}`);
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
```

### Premium Account Usage (FLAC Downloads)

```js
const { writeFile } = require("fs/promises");
const Deezer = require("@loganlatham/deezer.js");

// Initialize with your Premium account ARL cookie (required for all API requests, Premium for FLAC)
const deezer = new Deezer("your_premium_arl_cookie_here");

(async () => {
    try {
        const tracks = await deezer.search("Bohemian Rhapsody");
        if (tracks.length === 0) {
            console.log("No tracks found");
            return;
        }

        const track = tracks[0];
        console.log(`Downloading FLAC: ${track.ART_NAME} - ${track.SNG_TITLE}`);

        // Download as FLAC (Premium accounts only)
        const trackBuffer = await deezer.getAndDecryptTrack(track, true);
        
        // Save to file
        const filename = `${track.ART_NAME} - ${track.SNG_TITLE}.flac`;
        await writeFile(filename, trackBuffer);
        console.log(`Downloaded: ${filename}`);
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
```

### Error Handling

```js
const Deezer = require("@loganlatham/deezer.js");

// ARL cookie required for all API requests
const deezer = new Deezer("your_arl_cookie_here");

(async () => {
    try {
        // Handle search errors
        const tracks = await deezer.search("", "track"); // Empty query
        console.log("Search results:", tracks);

        // Handle invalid entity IDs
        const entity = await deezer.get("999999999999", "track");
        if (entity === null) {
            console.log("Entity not found");
        }

        // Handle FLAC download without Premium
        const track = await deezer.get("3135556", "track");
        if (track) {
            try {
                await deezer.getAndDecryptTrack(track.info, true); // Will throw error
            } catch (error) {
                console.log("FLAC error:", error.message);
            }
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
```

## How to Find Your ARL Cookie

The ARL cookie is required for all API requests. Here's how to find it:

1. **Login to deezer.com** in your browser
2. **Press Fn+F12** to open Developer Tools
3. **In the top bar** where it says "Elements", "Console", "Sources", etc., **click the arrow pointing to the right** and select **"Application"**
4. **On the left side**, under "Storage", look for the **"Cookies"** dropdown
5. **Click on the Cookies dropdown** and you'll find the ARL code there
6. **Copy the ARL value** - this is what you need for the library

### Important Notes

- **Keep your ARL cookie secure**: Don't share it publicly or commit it to version control
- **ARL expires**: The cookie may expire periodically, requiring you to get a new one
- **Premium accounts**: For FLAC downloads, you need an ARL from a Premium account
- **Account-specific**: Each account has its own unique ARL cookie

### Environment Variable (Recommended)

Store your ARL cookie in an environment variable for security:

```bash
# Add to your .env file or shell profile
export DEEZER_ARL="your_arl_cookie_here"
```

Then use it in your code:

```javascript
const deezer = new Deezer(process.env.DEEZER_ARL);
```

## Notes

- **ARL Cookie Required**: All API requests (search, get, download) require a Deezer ARL cookie. Provide it to the constructor.
- **Premium Account Required**: FLAC downloads require a Deezer Premium account ARL cookie.
- **Rate Limiting**: Be mindful of Deezer's rate limits when making multiple requests.
- **Audio Quality**: Available audio quality depends on your account type and the track's availability.
- **Fallback Tracks**: Some tracks may have fallback versions if the original is unavailable.

## Links

- [Docs](https://laganyt.github.io/deezer.js/)
- [npm](https://www.npmjs.com/package/@lagandevs/deezer.js)
- [GitHub](https://github.com/laganyt/deezer.js)
- [Original Package](https://www.npmjs.com/package/@flazepe/deezer.js)
