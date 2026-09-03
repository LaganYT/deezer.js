"use strict";

const blowfish = require("blowfish-js");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const CBC_KEY_STRING = "g4el58wc0zvf9na1";
const CBC_KEY_BUFFER = Buffer.from(CBC_KEY_STRING, "ascii");
const BLOWFISH_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const STRIPE_SIZE = 2048;
const DEFAULT_SIZES_MB = [1, 10, 50];
const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP_ITERATIONS = 2;
const TRACK_ID = "3135556";

function legacyKey(trackId) {
	const md5 = createHash("md5").update(trackId).digest("hex");

	return blowfish.key(
		Array(16)
			.fill(0)
			.reduce(
				(acc, _, i) => acc + String.fromCharCode(md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ CBC_KEY_STRING.charCodeAt(i)),
				""
			)
	);
}

function optimizedKey(trackId) {
	const md5 = Buffer.from(createHash("md5").update(trackId).digest("hex"), "ascii");
	const key = Buffer.allocUnsafe(16);

	for (let i = 0; i < key.length; i++) key[i] = md5[i] ^ md5[i + 16] ^ CBC_KEY_BUFFER[i];

	return blowfish.key(key);
}

function legacyDecrypt(buffer, trackId) {
	const blowfishKey = legacyKey(trackId);
	const decryptedBuffer = Buffer.alloc(buffer.length);
	let stripe = 0;
	let position = 0;

	while (position < buffer.length) {
		const chunkSize = Math.min(STRIPE_SIZE, buffer.length - position);
		let chunk = Buffer.alloc(chunkSize);
		buffer.copy(chunk, 0, position, position + chunkSize);

		chunk =
			stripe % 3 || chunkSize < STRIPE_SIZE
				? chunk.toString("binary")
				: blowfish.cbc(blowfishKey, BLOWFISH_IV, chunk, true).toString("binary");

		decryptedBuffer.write(chunk, position, chunk.length, "binary");
		position += chunkSize;
		stripe++;
	}

	return decryptedBuffer;
}

function optimizedDecrypt(buffer, trackId) {
	const blowfishKey = optimizedKey(trackId);
	const decryptedBuffer = Buffer.from(buffer);

	for (let position = 0, stripe = 0; position + STRIPE_SIZE <= buffer.length; position += STRIPE_SIZE, stripe++) {
		if (stripe % 3 !== 0) continue;

		const decrypted = blowfish.cbc(blowfishKey, BLOWFISH_IV, buffer.subarray(position, position + STRIPE_SIZE), true);
		decryptedBuffer.set(decrypted, position);
	}

	return decryptedBuffer;
}

function createFixture(sizeBytes) {
	const buffer = Buffer.allocUnsafe(sizeBytes);

	// Deterministic data keeps runs comparable without spending benchmark time on RNG.
	for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 31 + 17) & 0xff;

	return buffer;
}

function parseArgs(argv) {
	const options = {};

	for (const argument of argv) {
		const [flag, value] = argument.split("=", 2);
		if (!value) throw new Error(`Expected --name=value syntax, received: ${argument}`);

		switch (flag) {
			case "--sizes":
				options.sizes = value;
				break;
			case "--iterations":
				options.iterations = value;
				break;
			case "--warmup":
				options.warmup = value;
				break;
			default:
				throw new Error(`Unknown benchmark option: ${flag}`);
		}
	}

	return options;
}

function parsePositiveInteger(value, fallback, name) {
	if (value == null || value === "") return fallback;

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);

	return parsed;
}

function parseSizes(value) {
	if (!value) return DEFAULT_SIZES_MB;

	const sizes = value.split(",").map(item => Number(item.trim()));
	if (!sizes.length || sizes.some(size => !Number.isFinite(size) || size <= 0)) {
		throw new Error("Benchmark sizes must be a comma-separated list of positive numbers.");
	}

	return sizes;
}

function percentile(sorted, fraction) {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

function summarize(samples, bytesPerIteration = 0) {
	const sorted = [...samples].sort((a, b) => a - b);
	const total = samples.reduce((sum, value) => sum + value, 0);
	const meanMs = total / samples.length;
	const medianMs = percentile(sorted, 0.5);
	const p95Ms = percentile(sorted, 0.95);
	const result = { meanMs, medianMs, p95Ms };

	if (bytesPerIteration) result.throughputMBps = bytesPerIteration / 1024 / 1024 / (medianMs / 1000);
	else result.opsPerSecond = 1000 / medianMs;

	return result;
}

function runTimed(fn, iterations) {
	const samples = new Array(iterations);

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		fn();
		samples[i] = performance.now() - start;
	}

	return samples;
}

function warmUp(fn, iterations) {
	for (let i = 0; i < iterations; i++) fn();
}

function formatMs(value) {
	return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

function formatNumber(value) {
	return value >= 1000 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1);
}

function printComparison(name, legacy, optimized, throughput = false) {
	const speedup = legacy.medianMs / optimized.medianMs;
	const metric = throughput ? "MB/s" : "ops/s";
	const legacyRate = throughput ? legacy.throughputMBps : legacy.opsPerSecond;
	const optimizedRate = throughput ? optimized.throughputMBps : optimized.opsPerSecond;

	console.log(`\n${name}`);
	console.table([
		{
			implementation: "legacy",
			"median ms": formatMs(legacy.medianMs),
			"mean ms": formatMs(legacy.meanMs),
			"p95 ms": formatMs(legacy.p95Ms),
			[metric]: formatNumber(legacyRate),
			speedup: "1.00x"
		},
		{
			implementation: "optimized",
			"median ms": formatMs(optimized.medianMs),
			"mean ms": formatMs(optimized.meanMs),
			"p95 ms": formatMs(optimized.p95Ms),
			[metric]: formatNumber(optimizedRate),
			speedup: `${speedup.toFixed(2)}x`
		}
	]);
}

function benchmarkKeyDerivation(iterations, warmupIterations) {
	const batchSize = 1000;
	const legacy = () => {
		for (let i = 0; i < batchSize; i++) legacyKey(TRACK_ID);
	};
	const optimized = () => {
		for (let i = 0; i < batchSize; i++) optimizedKey(TRACK_ID);
	};

	warmUp(legacy, warmupIterations);
	warmUp(optimized, warmupIterations);

	const legacySummary = summarize(runTimed(legacy, iterations).map(ms => ms / batchSize));
	const optimizedSummary = summarize(runTimed(optimized, iterations).map(ms => ms / batchSize));
	printComparison("Blowfish key derivation", legacySummary, optimizedSummary);
}

function benchmarkDecryption(sizeMB, iterations, warmupIterations) {
	const sizeBytes = Math.round(sizeMB * 1024 * 1024);
	const fixture = createFixture(sizeBytes);

	const legacyResult = legacyDecrypt(fixture, TRACK_ID);
	const optimizedResult = optimizedDecrypt(fixture, TRACK_ID);
	if (!legacyResult.equals(optimizedResult)) throw new Error(`Correctness check failed for ${sizeMB} MB fixture.`);

	const legacy = () => legacyDecrypt(fixture, TRACK_ID);
	const optimized = () => optimizedDecrypt(fixture, TRACK_ID);

	warmUp(legacy, warmupIterations);
	warmUp(optimized, warmupIterations);

	const legacySummary = summarize(runTimed(legacy, iterations), sizeBytes);
	const optimizedSummary = summarize(runTimed(optimized, iterations), sizeBytes);
	printComparison(`Striped track decryption — ${sizeMB} MB`, legacySummary, optimizedSummary, true);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sizes = parseSizes(args.sizes ?? process.env.BENCH_SIZES_MB);
	const iterations = parsePositiveInteger(args.iterations ?? process.env.BENCH_ITERATIONS, DEFAULT_ITERATIONS, "iterations");
	const warmupIterations = parsePositiveInteger(args.warmup ?? process.env.BENCH_WARMUP, DEFAULT_WARMUP_ITERATIONS, "warmup");

	console.log("deezer.js benchmark suite");
	console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
	console.log(`Iterations: ${iterations} | Warmup: ${warmupIterations} | Sizes: ${sizes.join(", ")} MB`);
	console.log("Each decryption benchmark verifies legacy and optimized output equality before timing.\n");

	benchmarkKeyDerivation(iterations, warmupIterations);
	for (const size of sizes) benchmarkDecryption(size, iterations, warmupIterations);
}

main();
