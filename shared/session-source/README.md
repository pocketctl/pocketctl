# Session source core

Private, dependency-free runtime package shared by Relay and Memory. The archive codec, manifest/storage interfaces, grouped history reader, canonical JSON/hash and producer provenance parser have one implementation here. Original service paths re-export the same implementation for compatibility.

`SharedSourceReader` implements bounded heads/body resolution, canonical hash checking, scoped/versioned cursors and current authority checks before/after I/O. `PostgresRelaySourceStore` uses only the reviewed `shared.*` personal-source functions. Team and historical source kinds fail explicitly until their adapters exist. The work client provides bounded claims and atomic revision completion; acquire ordered authority/job fences in `guardBeforeLease` before the root row lock. Perform archive/model I/O before calling completion.

From the repository root:

```sh
node scripts/build-session-source.mjs
node scripts/build-session-source.mjs --check
```

The build produces identical `memory/packages/session-source-0.1.0.tgz` and `relay/packages/session-source-0.1.0.tgz`, including a source fingerprint, and updates only their lockfile integrity values. Both services install a local file dependency; their existing independent Docker build contexts therefore remain usable. After changing the package, refresh each service's installed local dependency before host tests. CI/service images use fresh `npm ci`.

R1 is dormant infrastructure. Business source consumers and publish capture are not wired. `activation_ready` defaults false and runtime startup refuses shared processing modes until those consumers are implemented. Installing this package does not migrate data, subscribe/unsubscribe feeds, call models, or authorize production activation.
