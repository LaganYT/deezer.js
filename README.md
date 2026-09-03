# @lagandevs/deezer.js

A lightweight Deezer API client with track decryption support. Version 4 is ESM-first and uses Web Platform APIs so it can be bundled for Cloudflare Workers, Vercel edge/serverless runtimes, browsers, and modern Node.js without Node runtime shims.

## Install

```bash
pnpm add @lagandevs/deezer.js
```

## Usage

```js
import Deezer from "@lagandevs/deezer.js";

const deezer = new Deezer(process.env.DEEZER_ARL);
const tracks = await deezer.search("A track name");
const mp3 = await deezer.getAndDecryptTrack(tracks[0]);
```

`getAndDecryptTrack()` returns a `Uint8Array` containing the same decrypted audio bytes previously returned in a Node `Buffer`. In Workers it can be passed directly to `Response`:

```js
return new Response(mp3, {
  headers: { "content-type": "audio/mpeg" }
});
```

## Cloudflare Workers

The package itself does not require `nodejs_compat`. Runtime code uses `fetch`, Web Crypto, `Uint8Array`, `TextEncoder`, and `TextDecoder`.

```js
import Deezer from "@lagandevs/deezer.js";

export default {
  async fetch(request, env) {
    const deezer = new Deezer(env.DEEZER_ARL);
    const entity = await deezer.get("3692935892", "track");
    if (!entity) return new Response("Not found", { status: 404 });

    const audio = await deezer.getAndDecryptTrack(entity.tracks[0]);
    return new Response(audio, {
      headers: { "content-type": "audio/mpeg" }
    });
  }
};
```

## API compatibility

The public class and method shapes are unchanged:

- `new Deezer(arl?)`
- `deezer.api(method, body)`
- `deezer.search(query, type?)`
- `deezer.get(idOrURL, type?)`
- `deezer.getAndDecryptTrack(track, flac?)`

Supported entity types remain `track`, `album`, `artist`, and `playlist`.

## Runtime notes

- HTTP uses the global `fetch()` API.
- Session-cache keys use Web Crypto SHA-256.
- Deezer's audio protocol requires MD5 for Blowfish key derivation. Web Crypto intentionally does not expose MD5, so that protocol-specific digest is implemented in pure JavaScript.
- Blowfish uses the ESM/browser-compatible `egoroof-blowfish` package and typed arrays.
- Runtime source contains no `require()`, `node:crypto`, `node:https`, `https.Agent`, Node streams, or `Buffer` usage.
