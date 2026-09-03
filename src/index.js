const blowfish = require("blowfish-js");
const { createHash } = require("node:crypto");
const { Agent, request } = require("node:https");

const CBC_KEY = Buffer.from("g4el58wc0zvf9na1", "ascii");
const BLOWFISH_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const ENTITY_TYPES = ["track", "album", "artist", "playlist"];
const MP3_FORMATS = ["MP3_320", "MP3_256", "MP3_128", "MP3_64"];
const SESSION_EXPIRE = 15 * 60 * 1000;
const STRIPE_SIZE = 2048;
const MAX_REDIRECTS = 5;
const HTTPS_AGENT = new Agent({
	keepAlive: true,
	keepAliveMsecs: 1000,
	maxSockets: 32,
	maxFreeSockets: 8,
	scheduling: "lifo"
});

/**
 * @typedef {"track" | "album" | "artist" | "playlist"} EntityType An entity type
 */

/**
 * @typedef {Object} Entity An object with entity type, info, and resolved tracks
 * @property {EntityType} type The entity type
 * @property {Object} info The entity information
 * @property {Array} tracks An array of the entity's tracks
 */

class Deezer {
	#arl = null;
	#currentSessionTimestamp = 0;
	#sessionID = null;
	#apiToken = null;
	#isPremium = false;
	#licenseToken = null;
	#sessionPromise = null;

	/**
	 * Constructs the Deezer class.
	 * @param {string} [arl] The Deezer ARL cookie, for authenticating as a Deezer Premium account
	 * @returns {Object} The Deezer class instance
	 */
	constructor(arl) {
		if (typeof arl === "string") this.#arl = arl;
	}

	#request(url, options = {}, redirects = 0) {
		const { buffer = false, body, headers, ...requestOptions } = options;

		return new Promise((resolve, reject) => {
			const req = request(
				url,
				{
					...requestOptions,
					agent: HTTPS_AGENT,
					headers
				},
				res => {
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
						res.resume();

						if (redirects >= MAX_REDIRECTS) {
							reject(new Error(`Too many redirects while requesting ${url}`));
							return;
						}

						const redirectURL = new URL(res.headers.location, url).href;
						const redirectOptions = { ...options };

						if (res.statusCode === 303) {
							redirectOptions.method = "GET";
							delete redirectOptions.body;
						}

						this.#request(redirectURL, redirectOptions, redirects + 1).then(resolve, reject);
						return;
					}

					const chunks = [];
					let totalLength = 0;

					res.on("data", chunk => {
						chunks.push(chunk);
						totalLength += chunk.length;
					});

					res.on("end", () => {
						const responseBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLength);

						if (buffer) {
							resolve(responseBuffer);
							return;
						}

						try {
							resolve(JSON.parse(responseBuffer.toString("utf8")));
						} catch (error) {
							console.error(`Error parsing body as JSON: ${responseBuffer.toString("utf8")}`);
							reject(error);
						}
					});
				}
			);

			req.on("error", reject);
			if (body != null) req.end(body);
			else req.end();
		});
	}

	async #refreshSession() {
		const data = await this.#request("https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=", {
			headers: this.#arl ? { cookie: `arl=${this.#arl}` } : undefined
		});

		this.#currentSessionTimestamp = Date.now();
		this.#sessionID = data.results.SESSION_ID;
		this.#apiToken = data.results.checkForm;
		this.#isPremium = data.results.OFFER_NAME !== "Deezer Free";
		this.#licenseToken = data.results.USER.OPTIONS.license_token;
	}

	async #ensureSession() {
		if (this.#currentSessionTimestamp + SESSION_EXPIRE > Date.now()) return;

		if (!this.#sessionPromise) {
			this.#sessionPromise = this.#refreshSession().finally(() => {
				this.#sessionPromise = null;
			});
		}

		await this.#sessionPromise;
	}

	/**
	 * Does a request to the Deezer API.
	 * @param {string} method The Deezer API method
	 * @param {Object} body The JSON body
	 * @returns {Promise<Object>} The response
	 */
	async api(method, body) {
		if (typeof method !== "string") throw new TypeError("`method` must be a string.");
		if (body?.constructor !== Object) throw new TypeError("`body` must be an object.");

		await this.#ensureSession();

		return this.#request(`https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.#apiToken}`, {
			method: "POST",
			headers: { cookie: `sid=${this.#sessionID}` },
			body: JSON.stringify(body)
		});
	}

	/**
	 * Searches for entities.
	 * @param {string} query The query
	 * @param {EntityType} [type = "track"] The entity type
	 * @returns {Promise.<Array>} An array of search results, depending on the entity type
	 */
	async search(query, type) {
		if (typeof query !== "string") throw new TypeError("`query` must be a string.");

		const normalizedType = type?.toLowerCase?.();
		type = ENTITY_TYPES.includes(normalizedType) ? normalizedType : "track";

		return (await this.api("deezer.pageSearch", { query, start: 0, nb: 200, top_tracks: true })).results[type.toUpperCase()].data;
	}

	/**
	 * Gets an entity by ID or URL.
	 * @param {string} idOrURL The entity ID or URL
	 * @param {EntityType} [type] The entity type
	 * @returns {Promise.<Entity | null>} The {@link Entity} object, or null if no entity was found
	 */
	async get(idOrURL, type) {
		if (typeof idOrURL !== "string") throw new TypeError("`idOrURL` must be a string.");

		if (type) {
			if (typeof type !== "string") throw new TypeError("`type` must be a string.");

			const normalizedType = type.toLowerCase();
			type = ENTITY_TYPES.includes(normalizedType) ? normalizedType : "track";
		} else {
			while (idOrURL.endsWith("/")) idOrURL = idOrURL.slice(0, -1);

			const lowerCaseURL = idOrURL.toLowerCase();
			type = ENTITY_TYPES.find(entityType => lowerCaseURL.includes(entityType)) ?? "track";
			idOrURL = idOrURL.split("/").pop().split("?").shift();

			if (!/^[0-9]+$/.test(idOrURL)) return null;
		}

		const data = { type };

		switch (type) {
			case "track": {
				const track = (await this.api("song.getListData", { sng_ids: [idOrURL] })).results.data[0];
				Object.assign(data, { info: track, tracks: [track] });
				break;
			}

			case "album": {
				const album = (await this.api("deezer.pageAlbum", { alb_id: idOrURL, nb: 200, lang: "us" })).results;
				Object.assign(data, { info: album.DATA, tracks: album.SONGS?.data ?? [] });
				break;
			}

			case "artist": {
				const artist = (await this.api("deezer.pageArtist", { art_id: idOrURL, lang: "us" })).results;
				Object.assign(data, { info: artist.DATA, tracks: artist.TOP?.data ?? [] });
				break;
			}

			case "playlist": {
				const playlist = (await this.api("deezer.pagePlaylist", { playlist_id: idOrURL, nb: 200 })).results;
				Object.assign(data, { info: playlist.DATA, tracks: playlist.SONGS?.data ?? [] });
				break;
			}
		}

		return data.info ? data : null;
	}

	/**
	 * Gets a track buffer and decrypts it. By default, the track is in MP3.
	 * @param {Object} track The track object
	 * @param {boolean} [flac = false] Whether to get the track in FLAC. Only works for Deezer Premium accounts
	 * @returns {Promise.<Buffer>} The decrypted track buffer
	 */
	async getAndDecryptTrack(track, flac = false) {
		if (track?.constructor !== Object) throw new TypeError("`track` must be an object.");

		await this.#ensureSession();

		if (!Number(track.FILESIZE) && track.FALLBACK) {
			console.info(`Audio is unavailable for track ${track.SNG_ID}. Using fallback track ${track.FALLBACK.SNG_ID}...`);
			track = track.FALLBACK;
		}

		if (flac) {
			if (!this.#isPremium)
				throw new Error("FLAC is only supported on Deezer Premium accounts. Please provide the Deezer ARL cookie to the constructor.");

			if (!Number(track.FILESIZE_FLAC)) throw new Error(`FLAC audio is unavailable for track ${track.SNG_ID}.`);
		}

		const format = flac ? "FLAC" : MP3_FORMATS.find(candidate => Number(track[`FILESIZE_${candidate}`]));
		if (!format) throw new Error(`Audio is unavailable for track ${track.SNG_ID}.`);

		const data = await this.#request("https://media.deezer.com/v1/get_url", {
			method: "POST",
			body: JSON.stringify({
				license_token: this.#licenseToken,
				media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format }] }],
				track_tokens: [track.TRACK_TOKEN]
			})
		});
		const url = data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;

		if (!url) throw new Error(`Could not get track ${track.SNG_ID}'s audio source URL: ${data?.errors?.[0]?.message ?? "Unknown error"}`);

		const buffer = await this.#request(url, { buffer: true });
		const md5 = Buffer.from(createHash("md5").update(track.SNG_ID).digest("hex"), "ascii");
		const key = Buffer.allocUnsafe(16);

		for (let i = 0; i < key.length; i++) key[i] = md5[i] ^ md5[i + 16] ^ CBC_KEY[i];

		const blowfishKey = blowfish.key(key);

		// The downloaded buffer is private to this operation, so decrypting encrypted
		// stripes in place avoids a full-track copy without changing returned bytes.
		for (let position = 0, stripe = 0; position + STRIPE_SIZE <= buffer.length; position += STRIPE_SIZE, stripe++) {
			if (stripe % 3 !== 0) continue;

			const decrypted = blowfish.cbc(blowfishKey, BLOWFISH_IV, buffer.subarray(position, position + STRIPE_SIZE), true);
			buffer.set(decrypted, position);
		}

		return buffer;
	}
}

module.exports = Deezer;
