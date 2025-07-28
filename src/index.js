import blowfish from "blowfish-js";
import { createHash } from "crypto";
import fetch from "node-fetch";
import { config } from "dotenv";

// Constants
const CBC_KEY = "g4el58wc0zvf9na1";
const ENTITY_TYPES = ["track", "album", "artist", "playlist"];
const SESSION_EXPIRE = 60000 * 15;

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

	/**
	 * Constructs the Deezer class.
	 * @param {string} [arl] The Deezer ARL cookie, for authenticating as a Deezer Premium account
	 * @returns {Object} The Deezer class instance
	 */
	constructor(arl) {
		if (typeof arl === "string") this.#arl = arl;
	}

	async #request(url, options = {}) {
		const { buffer, ...fetchOptions } = options;
		if (this.#arl && !fetchOptions.headers?.cookie) {
			fetchOptions.headers = { ...fetchOptions.headers, cookie: `arl=${this.#arl}` };
		}
		const res = await fetch(url, fetchOptions);
		if (buffer) return Buffer.from(await res.arrayBuffer());
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch (e) {
			console.error(`Error parsing body as JSON: ${text}`);
			throw e;
		}
	}

	async #ensureSession() {
		if (this.#currentSessionTimestamp + SESSION_EXPIRE > Date.now()) return;

		const data = await this.#request("https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=");
		const results = data.results;
		this.#currentSessionTimestamp = Date.now();
		this.#sessionID = results.SESSION_ID;
		this.#apiToken = results.checkForm;
		this.#isPremium = results.OFFER_NAME !== "Deezer Free";
		this.#licenseToken = results.USER.OPTIONS.license_token;
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
		type = ENTITY_TYPES.includes(type?.toLowerCase?.()) ? type.toLowerCase() : "track";
		const res = await this.api("deezer.pageSearch", { query, start: 0, nb: 200, top_tracks: true });
		return res.results[type.toUpperCase()]?.data ?? [];
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
			type = ENTITY_TYPES.includes(type.toLowerCase()) ? type.toLowerCase() : "track";
		} else {
			idOrURL = idOrURL.replace(/\/+$/, "");
			type = ENTITY_TYPES.find(e => idOrURL.toLowerCase().includes(e)) ?? "track";
			idOrURL = idOrURL.split("/").pop().split("?")[0];
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

		const format = flac ? "FLAC" : ["MP3_320", "MP3_256", "MP3_128", "MP3_64"].find(e => Number(track[`FILESIZE_${e}`]));
		if (!format) throw new Error(`Audio is unavailable for track ${track.SNG_ID}.`);

		const data = await this.#request("https://media.deezer.com/v1/get_url", {
				method: "POST",
				body: JSON.stringify({
					license_token: this.#licenseToken,
					media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format }] }],
					track_tokens: [track.TRACK_TOKEN]
				})
			}),
			url = data?.data?.[0]?.media?.[0]?.sources?.[0]?.url;

		if (!url) throw new Error(`Could not get track ${track.SNG_ID}'s audio source URL: ${data?.errors?.[0]?.message ?? "Unknown error"}`);

		const buffer = await this.#request(url, { buffer: true }),
			md5 = createHash("md5").update(track.SNG_ID).digest("hex"),
			blowfishKey = blowfish.key(
				Array(16)
					.fill(0)
					.reduce((acc, _, i) => acc + String.fromCharCode(md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ CBC_KEY.charCodeAt(i)), "")
			),
			decryptedBuffer = Buffer.alloc(buffer.length);

		let i = 0,
			position = 0;

		while (position < buffer.length) {
			const chunkSize = Math.min(2048, buffer.length - position);

			let chunk = Buffer.alloc(chunkSize);
			buffer.copy(chunk, 0, position, position + chunkSize);

			chunk =
				i % 3 || chunkSize < 2048
					? chunk.toString("binary")
					: blowfish.cbc(blowfishKey, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), chunk, true).toString("binary");

			decryptedBuffer.write(chunk, position, chunk.length, "binary");

			position += chunkSize;
			i++;
		}

		return decryptedBuffer;
	}
}

// Load environment variables from .env file
config();

const deezer = new Deezer(process.env.DEEZER_API_KEY);

function sanitizeFilename(nameInput) {
	let str = typeof nameInput === 'string' ? nameInput : String(nameInput || "");

	// Explicitly replace U+2019 (Right Single Quotation Mark) with an underscore first.
	str = str.replace(/\u2019+/g, "_");
	// Replace typographic apostrophe ' with underscores, keeping ASCII '
	str = str.replace(/[']+/g, "_");
	// Normalize Unicode (e.g., "curly quotes" → plain quotes, accents → base letters)
	str = str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

	// Remove all non-ASCII characters
	str = str.replace(/[^\x00-\x7F]/g, "");

	// Replace anything not alphanumeric, hyphen, dot, comma, apostrophe, or space with _
	str = str.replace(/[^a-z0-9\-\.\,' ]/gi, "_");

	return str;
}

export default async function handler(req, res) {
	if (!res) {
		// If res is undefined, this is not an API route context; do nothing.
		return;
	}
	if (req.method !== "GET") {
		return res.status(405).json({ error: "Method not allowed" });
	}

	const { trackId } = req.query;
	if (!trackId) {
		return res.status(400).json({ error: "Track ID is required" });
	}

	try {
		const entity = await deezer.get(trackId, "track");
		if (!entity?.tracks?.length) {
			return res.status(404).json({ error: "Track not found" });
		}

		const track = entity.tracks[0];
		const trackBuffer = await deezer.getAndDecryptTrack(track);

		const artist = sanitizeFilename(track.ART_NAME || "Unknown Artist");
		const title = sanitizeFilename(track.SNG_TITLE || "Unknown Title");
		// Construct filename with underscores to ensure no spaces before encodeURIComponent
		const filename = `${artist} - ${title}.mp3`;

		console.log("Serving filename:", filename); // <-- This line will log the filename

		res.setHeader("Content-Type", "audio/mpeg");
		// Use a simpler Content-Disposition format.
		// The 'filename' variable is already sanitized.
		const cleanFilename = filename.replace(/[\r\n]+/g, "");
		res.setHeader(
			"Content-Disposition",
			`inline; filename="${cleanFilename}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`
		);
		res.setHeader("X-Track-Duration", track.DURATION || 0); // Duration in seconds

		return res.status(200).send(trackBuffer);
	} catch (error) {
		console.error("Error fetching MP3:", error.message);
		return res.status(500).json({ error: "Internal server error" });
	}
}

export { Deezer };