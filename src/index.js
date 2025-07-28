const blowfish = require("blowfish-js"),
	{ createHash } = require("crypto"),
	{ Agent } = require("https");

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
	static #CBC_KEY = "g4el58wc" + "0zvf9na1";
	static #ENTITY_TYPES = ["track", "album", "artist", "playlist"];
	static #SESSION_EXPIRE = 60000 * 15;
	static #HTTP_AGENT = new Agent({ keepAlive: true, maxSockets: 10 });
	static #URL_REGEX = /^[0-9]+$/;
	static #FORMAT_PRIORITIES = ["MP3_320", "MP3_256", "MP3_128", "MP3_64"];
	
	#arl = null;
	#currentSessionTimestamp = null;
	#sessionID = null;
	#apiToken = null;
	#isPremium = false;
	#licenseToken = null;
	#blowfishKeyCache = new Map();
	#entityTypeCache = new Map();

	/**
	 * Constructs the Deezer class.
	 * @param {string} [arl] The Deezer ARL cookie, for authenticating as a Deezer Premium account
	 * @returns {Object} The Deezer class instance
	 */
	constructor(arl) {
		if (typeof arl === "string") this.#arl = arl;
	}

	#request(url, options = {}) {
		return new Promise((resolve, reject) => {
			const { request } = require("https");
			const req = request(url, { 
				agent: Deezer.#HTTP_AGENT,
				...options 
			}, res => {
				const chunks = [];
				let totalLength = 0;

				res.on("data", chunk => {
					chunks.push(chunk);
					totalLength += chunk.length;
				});

				res.on("end", () => {
					const buffer = Buffer.concat(chunks, totalLength);

					try {
						resolve(options.buffer ? buffer : JSON.parse(buffer.toString()));
					} catch (error) {
						console.error(`Error parsing body as JSON: ${buffer.toString()}`);
						reject(error);
					}
				});
			});

			req.on("error", reject);
			
			if (options.body) {
				req.write(options.body);
			}
			req.end();
		});
	}

	async #ensureSession() {
		if (this.#currentSessionTimestamp + Deezer.#SESSION_EXPIRE > Date.now()) return;

		const data = await this.#request("https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=", {
			headers: this.#arl ? { cookie: `arl=${this.#arl}` } : null
		});

		this.#currentSessionTimestamp = Date.now();
		this.#sessionID = data.results.SESSION_ID;
		this.#apiToken = data.results.checkForm;
		this.#isPremium = data.results.OFFER_NAME !== "Deezer Free";
		this.#licenseToken = data.results.USER.OPTIONS.license_token;
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
			headers: { 
				"Content-Type": "application/json",
				cookie: `sid=${this.#sessionID}` 
			},
			body: JSON.stringify(body)
		});
	}

	#getEntityType(type, idOrURL) {
		if (type) {
			if (typeof type !== "string") throw new TypeError("`type` must be a string.");
			return Deezer.#ENTITY_TYPES.find(e => e === type.toLowerCase()) ?? "track";
		}

		// Check cache first
		const cacheKey = idOrURL.toLowerCase();
		if (this.#entityTypeCache.has(cacheKey)) {
			return this.#entityTypeCache.get(cacheKey);
		}

		// Clean URL
		let cleanURL = idOrURL;
		while (cleanURL.endsWith("/")) cleanURL = cleanURL.slice(0, -1);

		const foundType = Deezer.#ENTITY_TYPES.find(e => cleanURL.includes(e)) ?? "track";
		
		// Cache the result
		this.#entityTypeCache.set(cacheKey, foundType);
		return foundType;
	}

	#extractIdFromURL(idOrURL) {
		let cleanURL = idOrURL;
		while (cleanURL.endsWith("/")) cleanURL = cleanURL.slice(0, -1);
		return cleanURL.split("/").pop().split("?").shift();
	}

	/**
	 * Searches for entities.
	 * @param {string} query The query
	 * @param {EntityType} [type = "track"] The entity type
	 * @returns {Promise.<Array>} An array of search results, depending on the entity type
	 */
	async search(query, type) {
		if (typeof query !== "string") throw new TypeError("`query` must be a string.");
		type = Deezer.#ENTITY_TYPES.find(e => e === type?.toLowerCase?.()) ?? "track";
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

		type = this.#getEntityType(type, idOrURL);
		
		if (!type) {
			idOrURL = this.#extractIdFromURL(idOrURL);
			if (!Deezer.#URL_REGEX.test(idOrURL)) return null;
		}

		const data = { type };

		switch (type) {
			case "track":
				const track = (await this.api("song.getListData", { sng_ids: [idOrURL] })).results.data[0];
				Object.assign(data, { info: track, tracks: [track] });
				break;

			case "album":
				const album = (await this.api("deezer.pageAlbum", { alb_id: idOrURL, nb: 200, lang: "us" })).results;
				Object.assign(data, { info: album.DATA, tracks: album.SONGS?.data ?? [] });
				break;

			case "artist":
				const artist = (await this.api("deezer.pageArtist", { art_id: idOrURL, lang: "us" })).results;
				Object.assign(data, { info: artist.DATA, tracks: artist.TOP?.data ?? [] });
				break;

			case "playlist":
				const playlist = (await this.api("deezer.pagePlaylist", { playlist_id: idOrURL, nb: 200 })).results;
				Object.assign(data, { info: playlist.DATA, tracks: playlist.SONGS?.data ?? [] });
				break;
		}

		return data.info ? data : null;
	}

	#getBlowfishKey(trackId) {
		// Check cache first
		if (this.#blowfishKeyCache.has(trackId)) {
			return this.#blowfishKeyCache.get(trackId);
		}

		const md5 = createHash("md5").update(trackId).digest("hex");
		const key = blowfish.key(
			Array(16)
				.fill(0)
				.reduce((acc, _, i) => acc + String.fromCharCode(md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ Deezer.#CBC_KEY.charCodeAt(i)), "")
		);

		// Cache the key
		this.#blowfishKeyCache.set(trackId, key);
		return key;
	}

	#findBestFormat(track, flac) {
		if (flac) return "FLAC";
		
		for (const format of Deezer.#FORMAT_PRIORITIES) {
			if (Number(track[`FILESIZE_${format}`])) {
				return format;
			}
		}
		return null;
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

		const format = this.#findBestFormat(track, flac);
		if (!format) throw new Error(`Audio is unavailable for track ${track.SNG_ID}.`);

		const data = await this.#request("https://media.deezer.com/v1/get_url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					license_token: this.#licenseToken,
					media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format }] }],
					track_tokens: [track.TRACK_TOKEN]
				})
			}),
			url = data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;

		if (!url) throw new Error(`Could not get track ${track.SNG_ID}'s audio source URL: ${data?.errors?.[0]?.message ?? "Unknown error"}`);

		const buffer = await this.#request(url, { buffer: true });
		const blowfishKey = this.#getBlowfishKey(track.SNG_ID);
		const decryptedBuffer = Buffer.allocUnsafe(buffer.length);

		let i = 0;
		let position = 0;
		const chunkSize = 2048;
		const iv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);

		while (position < buffer.length) {
			const currentChunkSize = Math.min(chunkSize, buffer.length - position);
			const chunk = buffer.subarray(position, position + currentChunkSize);

			let decryptedChunk;
			if (i % 3 || currentChunkSize < chunkSize) {
				decryptedChunk = chunk;
			} else {
				decryptedChunk = blowfish.cbc(blowfishKey, iv, chunk, true);
			}

			decryptedChunk.copy(decryptedBuffer, position);
			position += currentChunkSize;
			i++;
		}

		return decryptedBuffer;
	}
}

module.exports = Deezer;