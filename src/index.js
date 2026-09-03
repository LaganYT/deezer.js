import { Blowfish } from "egoroof-blowfish";

const TEXT_ENCODER = new TextEncoder();
const CBC_KEY = TEXT_ENCODER.encode("g4el58wc0zvf9na1");
const BLOWFISH_IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const ENTITY_TYPES = ["track", "album", "artist", "playlist"];
const MP3_FORMATS = ["MP3_320", "MP3_256", "MP3_128", "MP3_64"];
const SESSION_EXPIRE = 15 * 60 * 1000;
const STRIPE_SIZE = 2048;
const ANONYMOUS_SESSION_KEY = "anonymous";
const SESSION_CACHE = new Map();

function toHex(bytes) {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

async function sha256(value) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
	return toHex(new Uint8Array(digest));
}

function md5Hex(value) {
	const input = TEXT_ENCODER.encode(value);
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
	const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
	const constants = new Uint32Array(64);
	for (let i = 0; i < 64; i++) constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

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
			const sum = (a + f + constants[i] + word) >>> 0;
			const shift = shifts[(i >> 4) * 4 + (i & 3)];
			const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
			[a, b, c, d] = [d, (b + rotated) >>> 0, b, c];
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
	for (let i = 0; i < 16; i++) key[i] = md5[i] ^ md5[i + 16] ^ CBC_KEY[i];
	return key;
}

function decryptStripe(key, bytes) {
	const blowfish = new Blowfish(key, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
	blowfish.setIv(BLOWFISH_IV);
	return blowfish._decodeCBC(bytes);
}

class Deezer {
	#arl = null;
	#sessionCacheKeyPromise = Promise.resolve(ANONYMOUS_SESSION_KEY);
	#currentSessionTimestamp = 0;
	#sessionID = null;
	#apiToken = null;
	#isPremium = false;
	#licenseToken = null;
	#sessionPromise = null;

	constructor(arl) {
		if (typeof arl === "string" && arl.length) {
			this.#arl = arl;
			this.#sessionCacheKeyPromise = sha256(arl);
		}
	}

	async #request(url, options = {}) {
		const { buffer = false, ...requestOptions } = options;
		const response = await fetch(url, requestOptions);
		if (buffer) return new Uint8Array(await response.arrayBuffer());
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
		const data = await this.#request("https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=", {
			headers: this.#arl ? { cookie: `arl=${this.#arl}` } : undefined
		});
		const session = {
			timestamp: Date.now(),
			sessionID: data.results.SESSION_ID,
			apiToken: data.results.checkForm,
			isPremium: data.results.OFFER_NAME !== "Deezer Free",
			licenseToken: data.results.USER.OPTIONS.license_token
		};
		SESSION_CACHE.set(cacheKey, session);
		this.#applySession(session);
		return session;
	}

	async #ensureSession() {
		const now = Date.now();
		if (this.#currentSessionTimestamp + SESSION_EXPIRE > now) return;
		const cacheKey = await this.#sessionCacheKeyPromise;
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
		if (typeof method !== "string") throw new TypeError("`method` must be a string.");
		if (body?.constructor !== Object) throw new TypeError("`body` must be an object.");
		await this.#ensureSession();
		return this.#request(`https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${this.#apiToken}`, {
			method: "POST",
			headers: { cookie: `sid=${this.#sessionID}` },
			body: JSON.stringify(body)
		});
	}

	async search(query, type) {
		if (typeof query !== "string") throw new TypeError("`query` must be a string.");
		const normalizedType = type?.toLowerCase?.();
		type = ENTITY_TYPES.includes(normalizedType) ? normalizedType : "track";
		return (await this.api("deezer.pageSearch", { query, start: 0, nb: 200, top_tracks: true })).results[type.toUpperCase()].data;
	}

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

	async getAndDecryptTrack(track, flac = false) {
		if (track?.constructor !== Object) throw new TypeError("`track` must be an object.");
		await this.#ensureSession();
		if (!Number(track.FILESIZE) && track.FALLBACK) {
			console.info(`Audio is unavailable for track ${track.SNG_ID}. Using fallback track ${track.FALLBACK.SNG_ID}...`);
			track = track.FALLBACK;
		}
		if (flac) {
			if (!this.#isPremium) throw new Error("FLAC is only supported on Deezer Premium accounts. Please provide the Deezer ARL cookie to the constructor.");
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
		const bytes = await this.#request(url, { buffer: true });
		const key = createBlowfishKey(track.SNG_ID);
		for (let position = 0, stripe = 0; position + STRIPE_SIZE <= bytes.length; position += STRIPE_SIZE, stripe++) {
			if (stripe % 3 !== 0) continue;
			bytes.set(decryptStripe(key, bytes.subarray(position, position + STRIPE_SIZE)), position);
		}
		return bytes;
	}
}

export { Deezer };
export default Deezer;
