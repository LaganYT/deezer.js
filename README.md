# @lagandevs/deezer.js

A Cloudflare Workers-first Deezer API client with track decryption and the Worker-facing `DeezerAPI` helpers used by LTunes.

## Install

```bash
pnpm add @lagandevs/deezer.js
```

## Cloudflare Workers / LTunes

```js
import { DeezerAPI } from "@lagandevs/deezer.js";

const deezer = new DeezerAPI();

export default {
  async fetch(request, env) {
    return deezer.searchTracks({ query: "test" }, env);
  }
};
```

The Worker helper methods read the Deezer ARL from `env.DEEZER_API_KEY`, matching the existing LTunes API integration.

Worker-facing methods include:

- `searchTracks(params, env)`
- `searchAlbums(params, env)`
- `searchArtists(params, env)`
- `searchAll(params, env)`
- `getAudioURL(params, env, request)`
- `streamTrack(trackId, env)`
- `getArtist(artistId, env)`
- `getArtistAlbums(artistId, params, env)`
- `getAlbum(albumId, env)`
- `getTopCharts(params, env)`
- `downloadTrack(params, env)`
- `getLyrics(params, env)`
- `downloadWithCustomMetadata(params, env, request)`

## Core client API

The lower-level package API remains available too:

```js
import DeezerAPI, { Deezer } from "@lagandevs/deezer.js";

const deezer = new DeezerAPI("your-arl");
const entity = await deezer.get("3692935892", "track");
const audio = await deezer.getAndDecryptTrack(entity.tracks[0]);
```

`DeezerAPI`, `Deezer`, and the default export all refer to the same class, so both the old LTunes import and the newer package examples remain compatible.

Core methods:

- `new DeezerAPI(arl?)`
- `api(method, body)`
- `search(query, type?)`
- `get(idOrURL, type?)`
- `getAndDecryptTrack(track, flac?)`

`getAndDecryptTrack()` returns a `Uint8Array`. In a Worker it can be passed directly to `Response`:

```js
const audio = await deezer.getAndDecryptTrack(entity.tracks[0]);
return new Response(audio, {
  headers: { "content-type": "audio/mpeg" }
});
```

## Worker runtime

The package does not require `nodejs_compat` and runtime code does not import Node modules. It uses:

- global `fetch()` for HTTP
- `Uint8Array`, `DataView`, and `TextEncoder` for binary processing
- a small protocol-specific MD5 implementation for Deezer key derivation
- the ESM/browser-compatible `egoroof-blowfish` package for BF-CBC decryption

The package intentionally avoids `node:https`, `https.Agent`, Node streams, `Buffer`, `require()`, and `module.exports` in runtime source.

## Performance

The Worker implementation keeps a 15-minute in-memory session cache for warm isolates. Cold isolates continue to initialize normally, so the cache is only an optimization and is not required for correctness.

Track decryption is performed in-place and initializes the Blowfish key schedule once per track instead of once per encrypted 2 KB stripe, reducing CPU and allocation overhead in Workers.
