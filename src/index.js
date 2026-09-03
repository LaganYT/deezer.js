import { Blowfish } from "egoroof-blowfish";

const TEXT_ENCODER = new TextEncoder();
const CBC_KEY = TEXT_ENCODER.encode("g4el58wc0zvf9na1");
const BLOWFISH_IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const ENTITY_TYPES = ["track", "album", "artist", "playlist"];
const MP3_FORMATS = ["MP3_320", "MP3_256", "MP3_128", "MP3_64"];
const SESSION_EXPIRE = 15 * 60 * 1000;
const STRIPE_SIZE = 2048;
const ANONYMOUS_SESSION_KEY = Symbol("anonymous-deezer-session");
const SESSION_CACHE = new Map();

const MD5_SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);
const MD5_CONSTANTS = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_CONSTANTS[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function toHex(bytes) {
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    output += bytes[i].toString(16).padStart(2, "0");
  }
  return output;
}

// Deezer's BF_CBC_STRIPE key derivation requires MD5. Web Crypto intentionally
// does not expose MD5, so keep this small protocol-specific implementation local.
function md5Hex(value) {
  const input = TEXT_ENCODER.encode(String(value));
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >>> 6) + 1) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;

  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }

      const word = view.getUint32(offset + g * 4, true);
      const sum = (a + f + MD5_CONSTANTS[i] + word) >>> 0;
      const shift = MD5_SHIFTS[i];
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      const nextB = (b + rotated) >>> 0;
      a = d;
      d = c;
      c = b;
      b = nextB;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0, true);
  digestView.setUint32(4, b0, true);
  digestView.setUint32(8, c0, true);
  digestView.setUint32(12, d0, true);
  return toHex(digest);
}

function createBlowfishKey(trackId) {
  const md5 = TEXT_ENCODER.encode(md5Hex(trackId));
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = md5[i] ^ md5[i + 16] ^ CBC_KEY[i];
  }
  return key;
}

class DeezerAPI {
  #arl = null;
  #sessionCacheKey = ANONYMOUS_SESSION_KEY;
  #currentSessionTimestamp = 0;
  #sessionID = null;
  #apiToken = null;
  #isPremium = false;
  #licenseToken = null;
  #sessionPromise = null;

  constructor(arl) {
    this.#setARL(arl);
  }

  #setARL(arl) {
    const normalized = typeof arl === "string" && arl.length ? arl : null;
    if (normalized === this.#arl) return;

    this.#arl = normalized;
    this.#sessionCacheKey = normalized ?? ANONYMOUS_SESSION_KEY;
    this.#currentSessionTimestamp = 0;
    this.#sessionID = null;
    this.#apiToken = null;
    this.#isPremium = false;
    this.#licenseToken = null;
    this.#sessionPromise = null;
  }

  async #request(url, options = {}) {
    const { buffer = false, ...fetchOptions } = options;
    const response = await fetch(url, fetchOptions);

    if (buffer) {
      return new Uint8Array(await response.arrayBuffer());
    }

    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch (error) {
      console.error(`Error parsing body as JSON: ${body}`);
      throw error;
    }
  }

  #applySession(session) {
    this.#currentSessionTimestamp = session.timestamp;
    this.#sessionID = session.sessionID;
    this.#apiToken = session.apiToken;
    this.#isPremium = session.isPremium;
    this.#licenseToken = session.licenseToken;
  }

  async #refreshSession(cacheKey) {
    const data = await this.#request(
      "https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=",
      { headers: this.#arl ? { cookie: `arl=${this.#arl}` } : undefined }
    );

    const results = data.results;
    const session = {
      timestamp: Date.now(),
      sessionID: results.SESSION_ID,
      apiToken: results.checkForm,
      isPremium: results.OFFER_NAME !== "Deezer Free",
      licenseToken: results.USER.OPTIONS.license_token,
    };

    SESSION_CACHE.set(cacheKey, session);
    this.#applySession(session);
    return session;
  }

  async #ensureSession() {
    const now = Date.now();
    if (this.#currentSessionTimestamp + SESSION_EXPIRE > now) return;

    const cacheKey = this.#sessionCacheKey;
    const cached = SESSION_CACHE.get(cacheKey);

    if (cached?.promise) {
      this.#applySession(await cached.promise);
      return;
    }

    if (cached?.timestamp + SESSION_EXPIRE > now) {
      this.#applySession(cached);
      return;
    }

    if (!this.#sessionPromise) {
      const promise = this.#refreshSession(cacheKey).finally(() => {
        const current = SESSION_CACHE.get(cacheKey);
        if (current?.promise) SESSION_CACHE.delete(cacheKey);
        this.#sessionPromise = null;
      });

      this.#sessionPromise = promise;
      SESSION_CACHE.set(cacheKey, { promise });
    }

    this.#applySession(await this.#sessionPromise);
  }

  async api(method, body) {
    if (typeof method !== "string") {
      throw new TypeError("`method` must be a string.");
    }
    if (body?.constructor !== Object) {
      throw new TypeError("`body` must be an object.");
    }

    await this.#ensureSession();

    return this.#request(
      `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.#apiToken}`,
      {
        method: "POST",
        headers: { cookie: `sid=${this.#sessionID}` },
        body: JSON.stringify(body),
      }
    );
  }

  async search(query, type) {
    if (typeof query !== "string") {
      throw new TypeError("`query` must be a string.");
    }

    const normalizedType = type?.toLowerCase?.();
    type = ENTITY_TYPES.includes(normalizedType) ? normalizedType : "track";
    const response = await this.api("deezer.pageSearch", {
      query,
      start: 0,
      nb: 200,
      top_tracks: true,
    });

    return response.results[type.toUpperCase()]?.data ?? [];
  }

  async get(idOrURL, type) {
    if (typeof idOrURL !== "string") {
      throw new TypeError("`idOrURL` must be a string.");
    }

    if (type) {
      if (typeof type !== "string") {
        throw new TypeError("`type` must be a string.");
      }
      const normalizedType = type.toLowerCase();
      type = ENTITY_TYPES.includes(normalizedType) ? normalizedType : "track";
    } else {
      idOrURL = idOrURL.replace(/\/+$/, "");
      const lowerCaseURL = idOrURL.toLowerCase();
      type = ENTITY_TYPES.find((entityType) => lowerCaseURL.includes(entityType)) ?? "track";
      idOrURL = idOrURL.split("/").pop().split("?")[0];
      if (!/^[0-9]+$/.test(idOrURL)) return null;
    }

    const data = { type };

    switch (type) {
      case "track": {
        const track = (
          await this.api("song.getListData", { sng_ids: [idOrURL] })
        ).results.data[0];
        Object.assign(data, { info: track, tracks: [track] });
        break;
      }
      case "album": {
        const album = (
          await this.api("deezer.pageAlbum", {
            alb_id: idOrURL,
            nb: 200,
            lang: "us",
          })
        ).results;
        Object.assign(data, {
          info: album.DATA,
          tracks: album.SONGS?.data ?? [],
        });
        break;
      }
      case "artist": {
        const artist = (
          await this.api("deezer.pageArtist", {
            art_id: idOrURL,
            lang: "us",
          })
        ).results;
        Object.assign(data, {
          info: artist.DATA,
          tracks: artist.TOP?.data ?? [],
        });
        break;
      }
      case "playlist": {
        const playlist = (
          await this.api("deezer.pagePlaylist", {
            playlist_id: idOrURL,
            nb: 200,
          })
        ).results;
        Object.assign(data, {
          info: playlist.DATA,
          tracks: playlist.SONGS?.data ?? [],
        });
        break;
      }
    }

    return data.info ? data : null;
  }

  async getAndDecryptTrack(track, flac = false) {
    if (track?.constructor !== Object) {
      throw new TypeError("`track` must be an object.");
    }

    await this.#ensureSession();

    if (!Number(track.FILESIZE) && track.FALLBACK) {
      console.info(
        `Audio is unavailable for track ${track.SNG_ID}. Using fallback track ${track.FALLBACK.SNG_ID}...`
      );
      track = track.FALLBACK;
    }

    if (flac) {
      if (!this.#isPremium) {
        throw new Error(
          "FLAC is only supported on Deezer Premium accounts. Please provide the Deezer ARL cookie to the constructor."
        );
      }
      if (!Number(track.FILESIZE_FLAC)) {
        throw new Error(`FLAC audio is unavailable for track ${track.SNG_ID}.`);
      }
    }

    const format = flac
      ? "FLAC"
      : MP3_FORMATS.find((candidate) => Number(track[`FILESIZE_${candidate}`]));

    if (!format) {
      throw new Error(`Audio is unavailable for track ${track.SNG_ID}.`);
    }

    const data = await this.#request("https://media.deezer.com/v1/get_url", {
      method: "POST",
      body: JSON.stringify({
        license_token: this.#licenseToken,
        media: [
          {
            type: "FULL",
            formats: [{ cipher: "BF_CBC_STRIPE", format }],
          },
        ],
        track_tokens: [track.TRACK_TOKEN],
      }),
    });

    const url = data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;
    if (!url) {
      throw new Error(
        `Could not get track ${track.SNG_ID}'s audio source URL: ${
          data?.errors?.[0]?.message ?? "Unknown error"
        }`
      );
    }

    const bytes = await this.#request(url, { buffer: true });
    const blowfish = new Blowfish(
      createBlowfishKey(track.SNG_ID),
      Blowfish.MODE.CBC,
      Blowfish.PADDING.NULL
    );
    blowfish.setIv(BLOWFISH_IV);

    // Deezer encrypts every third complete 2048-byte stripe. Reuse one key
    // schedule for the whole track and decrypt directly into the downloaded bytes.
    for (
      let position = 0, stripe = 0;
      position + STRIPE_SIZE <= bytes.length;
      position += STRIPE_SIZE, stripe++
    ) {
      if (stripe % 3 !== 0) continue;
      const decrypted = blowfish._decodeCBC(
        bytes.subarray(position, position + STRIPE_SIZE)
      );
      bytes.set(decrypted, position);
    }

    return bytes;
  }

  // API Methods
  async searchTracks(params, env) {
    const { query } = params;
    if (!query) {
      return new Response(
        JSON.stringify({ error: "Query parameter is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const tracks = await this.search(query, "track");
      if (!tracks?.length) {
        return new Response(JSON.stringify({ error: "No tracks found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify(tracks), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error searching for tracks:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async searchAlbums(params, env) {
    const { query } = params;
    if (!query) {
      return new Response(
        JSON.stringify({ error: "Query parameter is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const albums = await this.search(query, "album");
      return new Response(JSON.stringify(albums), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error searching for albums:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async searchArtists(params, env) {
    const { query } = params;
    if (!query) {
      return new Response(
        JSON.stringify({ error: "Query parameter is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const artists = await this.search(query, "artist");
      return new Response(JSON.stringify(artists), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error searching for artists:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async searchAll(params, env) {
    const { query } = params;
    if (!query) {
      return new Response(
        JSON.stringify({ error: "Query parameter is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const [tracks, albums, artists] = await Promise.all([
        this.search(query, "track"),
        this.search(query, "album"),
        this.search(query, "artist"),
      ]);

      return new Response(JSON.stringify({ tracks, albums, artists }), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error searching:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async getAudioURL(params, env, request) {
    const { artist, musicName, trackId } = params;

    if (!trackId && (!artist || !musicName)) {
      return new Response(
        JSON.stringify({
          error:
            "Either trackId or both artist and musicName parameters are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      const protocol = request.headers.get("x-forwarded-proto") || "https";
      const host = request.headers.get("host");
      const baseURL = `${protocol}://${host}`;

      let selectedTrack;

      if (trackId) {
        this.#setARL(env.DEEZER_API_KEY);
        const entity = await this.get(trackId, "track");

        if (!entity?.tracks?.length) {
          return new Response(JSON.stringify({ error: "Track not found" }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }

        selectedTrack = entity.tracks[0];
      } else {
        const formattedArtist = artist
          .split(",")
          .map((name) => name.trim())
          .join(" &");
        const formattedMusicName = musicName
          .replace(/\(with.*?\)|\(ft.*?\)|\(feat\..*?\)/gi, "")
          .replace(/\(explicit\)|\(clean\)/gi, "")
          .trim();

        this.#setARL(env.DEEZER_API_KEY);
        const searchData = await this.search(
          `${formattedMusicName} ${formattedArtist}`,
          "track"
        );

        if (!searchData?.length) {
          return new Response(
            JSON.stringify({ error: "No matching tracks found" }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }

        selectedTrack =
          searchData.find((track) => {
            return (
              track.ART_NAME.toLowerCase() === formattedArtist.toLowerCase() &&
              track.SNG_TITLE.toLowerCase() === formattedMusicName.toLowerCase()
            );
          }) || searchData[0];

        if (!selectedTrack) {
          return new Response(
            JSON.stringify({ error: "No tracks available" }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }
      }

      const songUrl = `${baseURL}/api/track/${selectedTrack.SNG_ID}.mp3`;
      return new Response(JSON.stringify({ audioURL: songUrl }), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error fetching track:", error.message);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async streamTrack(trackId, env) {
    if (!trackId) {
      return new Response(JSON.stringify({ error: "Track ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const entity = await this.get(trackId, "track");
      if (!entity?.tracks?.length) {
        return new Response(JSON.stringify({ error: "Track not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      const track = entity.tracks[0];
      const trackBuffer = await this.getAndDecryptTrack(track);

      const artist = this.#sanitizeFilename(track.ART_NAME || "Unknown Artist");
      const title = this.#sanitizeFilename(track.SNG_TITLE || "Unknown Title");
      const filename = `${artist} - ${title}.mp3`;

      const cleanFilename = filename.replace(/[\r\n]+/g, "");
      const asciiSafeFilename = cleanFilename.replace(/[^\x00-\x7F]/g, "");

      return new Response(trackBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `inline; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodeURIComponent(
            cleanFilename
          )}`,
          "X-Track-Duration": track.DURATION || 0,
        },
      });
    } catch (error) {
      console.error("Error fetching MP3:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  #sanitizeFilename(nameInput) {
    let str =
      typeof nameInput === "string" ? nameInput : String(nameInput || "");

    str = str.replace(/\u2019+/g, "_");
    str = str.replace(/[']+/g, "_");
    str = str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    str = str.replace(/[^\x00-\x7F]/g, "");
    str = str.replace(/[^a-z0-9\-\.\,' ]/gi, "_");
    str = str.replace(/[^\x00-\x7F]/g, "");

    return str;
  }

  async #addMetadataToTrack(audioBuffer, track) {
    try {
      const title = track.SNG_TITLE || "Unknown Title";
      const artist = track.ART_NAME || "Unknown Artist";
      const album = track.ALB_TITLE || "Unknown Album";

      const titleBytes = new TextEncoder().encode(title);
      const artistBytes = new TextEncoder().encode(artist);
      const albumBytes = new TextEncoder().encode(album);

      const id3Header = new Uint8Array([
        0x49,
        0x44,
        0x33,
        0x03,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);

      const tit2Frame = this.#createID3Frame("TIT2", titleBytes);
      const tpe1Frame = this.#createID3Frame("TPE1", artistBytes);
      const talbFrame = this.#createID3Frame("TALB", albumBytes);

      const tagSize = tit2Frame.length + tpe1Frame.length + talbFrame.length;
      const tagSizeBytes = this.#encodeSyncSafeInt(tagSize);

      id3Header.set(tagSizeBytes, 6);

      const taggedBuffer = new Uint8Array(
        id3Header.length + tagSize + audioBuffer.length
      );
      let offset = 0;

      taggedBuffer.set(id3Header, offset);
      offset += id3Header.length;
      taggedBuffer.set(tit2Frame, offset);
      offset += tit2Frame.length;
      taggedBuffer.set(tpe1Frame, offset);
      offset += tpe1Frame.length;
      taggedBuffer.set(talbFrame, offset);
      offset += talbFrame.length;
      taggedBuffer.set(audioBuffer, offset);

      return taggedBuffer;
    } catch (error) {
      console.error("Error adding metadata:", error);
      return audioBuffer;
    }
  }

  #createID3Frame(frameId, data) {
    const frameHeader = new Uint8Array([
      frameId.charCodeAt(0),
      frameId.charCodeAt(1),
      frameId.charCodeAt(2),
      frameId.charCodeAt(3),
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    const frameData = new Uint8Array(1 + data.length);
    frameData[0] = 0x03;
    frameData.set(data, 1);

    const frameSize = this.#encodeSyncSafeInt(frameData.length);
    frameHeader.set(frameSize, 4);

    const frame = new Uint8Array(frameHeader.length + frameData.length);
    frame.set(frameHeader);
    frame.set(frameData, frameHeader.length);

    return frame;
  }

  #encodeSyncSafeInt(value) {
    const bytes = new Uint8Array(4);
    bytes[0] = (value >>> 21) & 0x7f;
    bytes[1] = (value >>> 14) & 0x7f;
    bytes[2] = (value >>> 7) & 0x7f;
    bytes[3] = value & 0x7f;
    return bytes;
  }

  async getArtist(artistId, env) {
    try {
      this.#setARL(env.DEEZER_API_KEY);
      const artist = await this.get(artistId, "artist");
      return new Response(JSON.stringify(artist), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error fetching artist:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async getArtistAlbums(artistId, params, env) {
    try {
      this.#setARL(env.DEEZER_API_KEY);
      const artist = await this.get(artistId, "artist");
      const albums = artist?.tracks || [];
      return new Response(JSON.stringify(albums), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error fetching artist albums:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async getAlbum(albumId, env) {
    try {
      this.#setARL(env.DEEZER_API_KEY);
      const album = await this.get(albumId, "album");
      return new Response(JSON.stringify(album), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error fetching album:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async getTopCharts(params, env) {
    try {
      const topArtists = await this.#fetchTopArtists();

      this.#setARL(env.DEEZER_API_KEY);
      const allTracks = [];
      const tracksPerArtist = Math.floor(48 / topArtists.length);

      for (const artist of topArtists) {
        try {
          const artistTracks = await this.search(artist, "track");
          const shuffledTracks = artistTracks.sort(() => Math.random() - 0.5);
          const selectedTracks = shuffledTracks.slice(0, tracksPerArtist);
          allTracks.push(...selectedTracks);

          console.log(
            `Added ${selectedTracks.length} tracks for ${artist} (from ${artistTracks.length} available)`
          );
        } catch (error) {
          console.warn(
            `Failed to fetch tracks for artist ${artist}:`,
            error.message
          );
        }
      }

      const shuffledAllTracks = allTracks.sort(() => Math.random() - 0.5);
      const finalTracks = shuffledAllTracks.slice(0, 48);

      return new Response(
        JSON.stringify({
          topArtists,
          tracks: finalTracks,
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    } catch (error) {
      console.error("Error in topCharts handler:", error.message);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch top charts",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
  }

  async #fetchTopArtists() {
    try {
      const LAST_FM_API_KEY = "17a4c6ad843623d06368a710fa9f3bad";
      const response = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=chart.getTopArtists&api_key=${LAST_FM_API_KEY}&format=json`
      );
      const data = await response.json();
      return data.artists.artist.slice(0, 4).map((artist) => artist.name);
    } catch (error) {
      console.error("Error fetching artists from Last.fm:", error.message);
      throw new Error("Failed to fetch top artists");
    }
  }

  async downloadTrack(params, env) {
    const { trackId } = params;
    if (!trackId) {
      return new Response(JSON.stringify({ error: "Track ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const entity = await this.get(trackId, "track");
      if (!entity?.tracks?.length) {
        return new Response(JSON.stringify({ error: "Track not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      const track = entity.tracks[0];
      const trackBuffer = await this.getAndDecryptTrack(track);

      let finalBuffer = trackBuffer;
      if (track.ALB_PICTURE) {
        try {
          const iconResponse = await fetch(track.ALB_PICTURE);
          if (iconResponse.ok) {
            const iconBuffer = new Uint8Array(await iconResponse.arrayBuffer());
            finalBuffer = await this.#addMetadataWithArtwork(
              trackBuffer,
              track,
              iconBuffer
            );
          } else {
            finalBuffer = await this.#addMetadataToTrack(trackBuffer, track);
          }
        } catch (error) {
          console.warn(
            "Failed to fetch album art, proceeding without it:",
            error
          );
          finalBuffer = await this.#addMetadataToTrack(trackBuffer, track);
        }
      } else {
        finalBuffer = await this.#addMetadataToTrack(trackBuffer, track);
      }

      const artist = this.#sanitizeFilename(track.ART_NAME || "Unknown Artist");
      const title = this.#sanitizeFilename(track.SNG_TITLE || "Unknown Title");
      const filename = `${artist} - ${title}.mp3`;

      const cleanFilename = filename.replace(/[\r\n]+/g, "");
      const asciiSafeFilename = cleanFilename.replace(/[^\x00-\x7F]/g, "");

      return new Response(finalBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodeURIComponent(
            cleanFilename
          )}`,
          "X-Track-Duration": track.DURATION || 0,
          "X-Track-Artist": track.ART_NAME || "Unknown Artist",
          "X-Track-Title": track.SNG_TITLE || "Unknown Title",
        },
      });
    } catch (error) {
      console.error("Error downloading track:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async getLyrics(params, env) {
    const { trackId, musicName, artist } = params;

    if (!trackId && (!musicName || !artist)) {
      return new Response(
        JSON.stringify({
          error:
            "Either trackId or both musicName and artist parameters are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      let selectedTrack;

      if (trackId) {
        const entity = await this.get(trackId, "track");
        if (!entity?.tracks?.length) {
          return new Response(JSON.stringify({ error: "Track not found" }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          });
        }
        selectedTrack = entity.tracks[0];
      } else {
        const formattedArtist = artist
          .split(",")
          .map((name) => name.trim())
          .join(" &");
        const formattedMusicName = musicName
          .replace(/\(with.*?\)|\(ft.*?\)|\(feat\..*?\)/gi, "")
          .replace(/\(explicit\)|\(clean\)/gi, "")
          .trim();

        const searchResults = await this.search(
          `${formattedMusicName} ${formattedArtist}`,
          "track"
        );

        if (!searchResults || searchResults.length === 0) {
          return new Response(
            JSON.stringify({
              error: `Track not found on Deezer for query: "${formattedMusicName} ${formattedArtist}"`,
            }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }

        selectedTrack =
          searchResults.find(
            (track) =>
              track.ART_NAME.toLowerCase() === formattedArtist.toLowerCase() &&
              track.SNG_TITLE.toLowerCase() === formattedMusicName.toLowerCase()
          ) || searchResults[0];
      }

      if (!selectedTrack) {
        return new Response(
          JSON.stringify({
            error: "No suitable track identified from Deezer search results.",
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      let lyrics = selectedTrack.LYRICS_TEXT;
      let source = "deezer";

      if (!lyrics) {
        try {
          const lrcLibParams = {
            track_name: selectedTrack.SNG_TITLE,
            artist_name: selectedTrack.ART_NAME,
            duration: selectedTrack.DURATION,
          };

          if (selectedTrack.ALB_TITLE) {
            lrcLibParams.album_name = selectedTrack.ALB_TITLE;
          }

          const lrcLibUrl = new URL("https://lrclib.net/api/get");
          Object.keys(lrcLibParams).forEach((key) =>
            lrcLibUrl.searchParams.append(key, lrcLibParams[key])
          );

          const lyricsResponse = await fetch(lrcLibUrl.toString());

          if (lyricsResponse.ok) {
            const lyricsData = await lyricsResponse.json();

            if (
              lyricsData &&
              (lyricsData.plainLyrics || lyricsData.syncedLyrics)
            ) {
              return new Response(
                JSON.stringify({
                  trackInfo: {
                    title: selectedTrack.SNG_TITLE,
                    artist: selectedTrack.ART_NAME,
                    album: selectedTrack.ALB_TITLE || null,
                    deezerId: selectedTrack.SNG_ID,
                    duration: selectedTrack.DURATION,
                  },
                  lyrics: {
                    plainLyrics: lyricsData.plainLyrics || null,
                    syncedLyrics: lyricsData.syncedLyrics || null,
                  },
                  source: "lrclib.net",
                  retrievedLrcEntry: lyricsData,
                }),
                {
                  headers: {
                    "Content-Type": "application/json",
                  },
                }
              );
            }
          }
        } catch (lrcError) {
          console.error(
            `Error fetching lyrics from lrclib.net for "${selectedTrack.SNG_TITLE}":`,
            lrcError.message
          );
        }
      }

      if (lyrics) {
        return new Response(
          JSON.stringify({
            trackInfo: {
              title: selectedTrack.SNG_TITLE,
              artist: selectedTrack.ART_NAME,
              album: selectedTrack.ALB_TITLE || null,
              deezerId: selectedTrack.SNG_ID,
              duration: selectedTrack.DURATION,
            },
            lyrics: {
              plainLyrics: lyrics,
              syncedLyrics: null,
            },
            source: source,
          }),
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      } else {
        return new Response(
          JSON.stringify({
            error: "Lyrics not found for this track.",
            trackInfo: {
              title: selectedTrack.SNG_TITLE,
              artist: selectedTrack.ART_NAME,
              album: selectedTrack.ALB_TITLE || null,
            },
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
    } catch (error) {
      console.error("Error fetching lyrics:", error.message);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async downloadWithCustomMetadata(params, env, request) {
    const { trackId, songName, artist, iconUrl } = params;

    if (!trackId) {
      return new Response(JSON.stringify({ error: "Track ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    try {
      this.#setARL(env.DEEZER_API_KEY);
      const entity = await this.get(trackId, "track");
      if (!entity?.tracks?.length) {
        return new Response(JSON.stringify({ error: "Track not found" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      const track = entity.tracks[0];
      const trackBuffer = await this.getAndDecryptTrack(track);

      const finalSongName = songName || track.SNG_TITLE || "Unknown Title";
      const finalArtist = artist || track.ART_NAME || "Unknown Artist";
      const finalIconUrl = iconUrl || track.ALB_PICTURE;

      const customTrack = {
        ...track,
        SNG_TITLE: finalSongName,
        ART_NAME: finalArtist,
        ALB_PICTURE: finalIconUrl,
      };

      let finalBuffer = trackBuffer;
      if (finalIconUrl) {
        try {
          const iconResponse = await fetch(finalIconUrl);
          if (iconResponse.ok) {
            const iconBuffer = new Uint8Array(await iconResponse.arrayBuffer());
            finalBuffer = await this.#addMetadataWithArtwork(
              trackBuffer,
              customTrack,
              iconBuffer
            );
          } else {
            finalBuffer = await this.#addMetadataToTrack(
              trackBuffer,
              customTrack
            );
          }
        } catch (error) {
          console.warn(
            "Failed to fetch album art, proceeding without it:",
            error
          );
          finalBuffer = await this.#addMetadataToTrack(
            trackBuffer,
            customTrack
          );
        }
      } else {
        finalBuffer = await this.#addMetadataToTrack(trackBuffer, customTrack);
      }

      const filename = `${finalSongName} - ${finalArtist}.mp3`;
      const cleanFilename = filename.replace(/[\r\n]+/g, "");
      const asciiSafeFilename = cleanFilename.replace(/[^\x00-\x7F]/g, "");

      return new Response(finalBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodeURIComponent(
            cleanFilename
          )}`,
          "X-Track-Duration": track.DURATION || 0,
          "X-Track-Artist": finalArtist,
          "X-Track-Title": finalSongName,
        },
      });
    } catch (error) {
      console.error(
        "Error downloading audio with custom metadata:",
        error.message
      );
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  }

  async #addMetadataWithArtwork(audioBuffer, track, artworkBuffer) {
    try {
      const title = track.SNG_TITLE || "Unknown Title";
      const artist = track.ART_NAME || "Unknown Artist";
      const album = track.ALB_TITLE || "Unknown Album";

      const titleBytes = new TextEncoder().encode(title);
      const artistBytes = new TextEncoder().encode(artist);
      const albumBytes = new TextEncoder().encode(album);

      const id3Header = new Uint8Array([
        0x49,
        0x44,
        0x33,
        0x03,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);

      const tit2Frame = this.#createID3Frame("TIT2", titleBytes);
      const tpe1Frame = this.#createID3Frame("TPE1", artistBytes);
      const talbFrame = this.#createID3Frame("TALB", albumBytes);
      const apicFrame = this.#createAPICFrame(artworkBuffer);

      const tagSize =
        tit2Frame.length +
        tpe1Frame.length +
        talbFrame.length +
        apicFrame.length;
      const tagSizeBytes = this.#encodeSyncSafeInt(tagSize);
      id3Header.set(tagSizeBytes, 6);

      const taggedBuffer = new Uint8Array(
        id3Header.length + tagSize + audioBuffer.length
      );
      let offset = 0;

      taggedBuffer.set(id3Header, offset);
      offset += id3Header.length;
      taggedBuffer.set(tit2Frame, offset);
      offset += tit2Frame.length;
      taggedBuffer.set(tpe1Frame, offset);
      offset += tpe1Frame.length;
      taggedBuffer.set(talbFrame, offset);
      offset += talbFrame.length;
      taggedBuffer.set(apicFrame, offset);
      offset += apicFrame.length;
      taggedBuffer.set(audioBuffer, offset);

      return taggedBuffer;
    } catch (error) {
      console.error("Error adding metadata with artwork:", error);
      return audioBuffer;
    }
  }

  #createAPICFrame(artworkBuffer) {
    const frameHeader = new Uint8Array([
      0x41,
      0x50,
      0x49,
      0x43,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    const mime = new TextEncoder().encode("image/jpeg");
    const description = new TextEncoder().encode("Cover");

    const frameData = new Uint8Array(
      1 + mime.length + 1 + 1 + description.length + 1 + artworkBuffer.length
    );
    let offset = 0;

    frameData[offset++] = 0x03;
    frameData.set(mime, offset);
    offset += mime.length;
    frameData[offset++] = 0x00;
    frameData[offset++] = 0x03;
    frameData.set(description, offset);
    offset += description.length;
    frameData[offset++] = 0x00;
    frameData.set(artworkBuffer, offset);

    const frameSize = this.#encodeSyncSafeInt(frameData.length);
    frameHeader.set(frameSize, 4);

    const frame = new Uint8Array(frameHeader.length + frameData.length);
    frame.set(frameHeader);
    frame.set(frameData, frameHeader.length);

    return frame;
  }
}

const Deezer = DeezerAPI;

export { DeezerAPI, Deezer };
export default DeezerAPI;
