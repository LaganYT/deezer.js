# Benchmark suite

The benchmark suite compares the legacy decryption hot path against the optimized implementation without making network requests.

It benchmarks:

- Blowfish key derivation.
- Deezer BF_CBC_STRIPE decryption over synthetic 1 MB, 10 MB, and 50 MB track buffers by default.
- Median, mean, and p95 latency.
- Operations per second for key derivation.
- MB/s throughput for track decryption.
- Relative speedup of the optimized implementation.

Before each decryption benchmark is timed, the suite decrypts the same fixture with both implementations and requires their output buffers to be byte-for-byte identical.

## Run

```sh
pnpm benchmark
```

For a faster smoke benchmark:

```sh
pnpm benchmark:quick
```

## Custom runs

The CLI accepts cross-platform options:

```sh
node benchmark/decryption.js --sizes=5,25,100 --iterations=10 --warmup=3
```

- `--sizes`: comma-separated fixture sizes in MB.
- `--iterations`: measured iterations per implementation.
- `--warmup`: warmup iterations per implementation.

The equivalent environment variables are also supported:

- `BENCH_SIZES_MB`
- `BENCH_ITERATIONS`
- `BENCH_WARMUP`

Command-line options take precedence over environment variables.

## Interpreting results

The benchmark prints one table for key derivation and one table for each track size. For decryption, the most useful columns are `median ms`, `MB/s`, and `speedup`.

Run benchmarks on an otherwise idle machine and compare results from the same Node.js version and hardware. Network performance is deliberately excluded so the results measure CPU and memory overhead in the package itself.
