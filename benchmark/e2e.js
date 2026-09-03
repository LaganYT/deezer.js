"use strict";

const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { writeFile } = require("node:fs/promises");
const DeezerOptimized = require("../src/index.js");
const DeezerLegacy = require("./legacy-deezer.js");

function parseArgs(argv) {
	const args = {
		trackId: null,
		iterations: 3,
		save: true,
		arl: process.env.DEEZER_ARL || undefined
	};

	for (const arg of argv) {
		if (!arg.startsWith("--") && !args.trackId) args.trackId = arg;
		else if (arg.startsWith("--iterations=")) args.iterations = Number.parseInt(arg.split("=")[1], 10);
		else if (arg === "--no-save") args.save = false;
	}

	if (!args.trackId || !/^\d+$/.test(args.trackId)) {
		throw new Error("Usage: pnpm benchmark:e2e -- <track-id> [--iterations=3] [--no-save]");
	}

	if (!Number.isSafeInteger(args.iterations) || args.iterations <= 0) throw new Error("--iterations must be a positive integer.");
	return args;
}

function summarize(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	const median = sorted[Math.floor(sorted.length / 2)];
	return { mean, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function mbps(bytes, ms) {
	return bytes / 1024 / 1024 / (ms / 1000);
}

async function runOnce(Implementation, trackId, arl) {
	const deezer = new Implementation(arl);
	const started = performance.now();
	const entity = await deezer.get(trackId, "track");
	if (!entity?.tracks?.[0]) throw new Error(`Track ${trackId} was not found.`);
	const metadataDone = performance.now();
	const buffer = await deezer.getAndDecryptTrack(entity.tracks[0]);
	const finished = performance.now();

	return {
		buffer,
		track: entity.tracks[0],
		metadataMs: metadataDone - started,
		downloadDecryptMs: finished - metadataDone,
		totalMs: finished - started
	};
}

async function main() {
	const { trackId, iterations, save, arl } = parseArgs(process.argv.slice(2));
	const samples = { legacy: [], optimized: [] };
	let lastLegacy;
	let lastOptimized;

	console.log("deezer.js end-to-end benchmark");
	console.log(`Track ID: ${trackId}`);
	console.log(`Iterations: ${iterations}`);
	console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
	console.log("Measures metadata lookup + media URL resolution + full download + decryption.");
	console.log("Order alternates each iteration to reduce CDN/cache bias.\n");

	for (let i = 0; i < iterations; i++) {
		const order = i % 2 === 0 ? [["legacy", DeezerLegacy], ["optimized", DeezerOptimized]] : [["optimized", DeezerOptimized], ["legacy", DeezerLegacy]];

		console.log(`Iteration ${i + 1}/${iterations} (${order.map(([name]) => name).join(" → ")})`);

		for (const [name, Implementation] of order) {
			const result = await runOnce(Implementation, trackId, arl);
			samples[name].push(result);
			if (name === "legacy") lastLegacy = result;
			else lastOptimized = result;

			console.log(
				`  ${name.padEnd(9)} total ${result.totalMs.toFixed(0)} ms | metadata ${result.metadataMs.toFixed(0)} ms | download+decrypt ${result.downloadDecryptMs.toFixed(0)} ms | ${mbps(result.buffer.length, result.downloadDecryptMs).toFixed(2)} MB/s`
			);
		}
	}

	const legacyHash = sha256(lastLegacy.buffer);
	const optimizedHash = sha256(lastOptimized.buffer);
	const equal = lastLegacy.buffer.equals(lastOptimized.buffer);

	console.log("\nOutput verification");
	console.log(`  Bytes: ${lastOptimized.buffer.length.toLocaleString("en-US")}`);
	console.log(`  Legacy SHA-256:    ${legacyHash}`);
	console.log(`  Optimized SHA-256: ${optimizedHash}`);
	console.log(`  Byte-for-byte identical: ${equal ? "YES" : "NO"}`);

	if (!equal) throw new Error("Legacy and optimized decrypted MP3 outputs differ.");

	const rows = ["legacy", "optimized"].map(name => {
		const total = summarize(samples[name].map(sample => sample.totalMs));
		const metadata = summarize(samples[name].map(sample => sample.metadataMs));
		const download = summarize(samples[name].map(sample => sample.downloadDecryptMs));
		return {
			implementation: name,
			"median total ms": total.median.toFixed(0),
			"mean total ms": total.mean.toFixed(0),
			"median metadata ms": metadata.median.toFixed(0),
			"median download+decrypt ms": download.median.toFixed(0),
			"median MB/s": mbps(lastOptimized.buffer.length, download.median).toFixed(2)
		};
	});

	console.log("\nSummary");
	console.table(rows);

	const legacyMedian = summarize(samples.legacy.map(sample => sample.totalMs)).median;
	const optimizedMedian = summarize(samples.optimized.map(sample => sample.totalMs)).median;
	console.log(`End-to-end speedup: ${(legacyMedian / optimizedMedian).toFixed(2)}x`);

	if (save) {
		await Promise.all([
			writeFile(`benchmark-${trackId}-legacy.mp3`, lastLegacy.buffer),
			writeFile(`benchmark-${trackId}-optimized.mp3`, lastOptimized.buffer)
		]);
		console.log(`\nSaved benchmark-${trackId}-legacy.mp3 and benchmark-${trackId}-optimized.mp3`);
	}
}

main().catch(error => {
	console.error(`\nBenchmark failed: ${error.message}`);
	process.exitCode = 1;
});
