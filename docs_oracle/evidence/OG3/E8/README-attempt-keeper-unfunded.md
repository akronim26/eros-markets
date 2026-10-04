# E8: fifteen markets sharing one T through Layer 1

Monad testnet, run started 2026-10-04T17:04:13.610Z. Status: **error: Error: 0xe371a2d5: timed out waiting for Final (state Open)**. Driven by `oracle/e2e` (`bun e2e/src/main.ts E8`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.

| Step | Market | Tx | Block | Time (UTC) |
| --- | --- | --- | --- | --- |
| listed e8-00 (truth YES) | `0xe371a2d5…` | `0xe6b41a2ed05cc4cbbf154100bf276a5d68ea64b25dc009f22db461580eca03fd` | 68170223 | 2026-10-04T17:04:49.000Z |
| listed e8-01 (truth YES) | `0x15771bae…` | `0x0006af0f6f80f3af14fe0e8d1ad2d73b9696cf973b0043579b92bfd4334d27b1` | 68170364 | 2026-10-04T17:05:32.000Z |
| listed e8-02 (truth YES) | `0x3615fc9a…` | `0x271d21c414bbbd3b2d01da5f146147f5e694cbb6fa024c8c0eba71769ebfc5f5` | 68170550 | 2026-10-04T17:06:28.000Z |
| listed e8-03 (truth YES) | `0xdf734039…` | `0x04f31d6ae2a5176ef8a2b67244c73212909ab69746fd5611ee20b66a1304adb7` | 68170699 | 2026-10-04T17:07:13.000Z |
| listed e8-04 (truth YES) | `0x1df69f84…` | `0x44a67f2d2f1f96a5a8d2c1e53f007568e8f9885b43f8742bf8c678e34d92cf03` | 68170859 | 2026-10-04T17:08:01.000Z |
| listed e8-05 (truth NO) | `0x8a581d0a…` | `0x59109413a4068fa03ce43dfb06c4f5ac7630663eefa6ed91c320c5659ac9614b` | 68171025 | 2026-10-04T17:08:51.000Z |
| listed e8-06 (truth NO) | `0x031f13f1…` | `0xe6f40c657bce28905a8fbfa0002d1831c72e1a2d54288a292c2d8a02585810e4` | 68171190 | 2026-10-04T17:09:41.000Z |
| listed e8-07 (truth NO) | `0xba261a82…` | `0x29ba2460335550aa094698613c11a66a5d17b7b2521c6c1e0fcc19653921b88e` | 68171348 | 2026-10-04T17:10:29.000Z |
| listed e8-08 (truth NO) | `0x9d19bc47…` | `0xa4a3fb0915a6fc9e5cb79f7443155be7aaf6f8de6abaded37e8c94b49409a08a` | 68171505 | 2026-10-04T17:11:16.000Z |
| listed e8-09 (truth NO) | `0x53e714aa…` | `0x8324856814db4513c776c8f660f5b9045f83a464914fe11cb57910db187de587` | 68171640 | 2026-10-04T17:11:57.000Z |
| listed e8-10 (truth NO) | `0x9004da74…` | `0xd438dc57c8a9624ec17d9a704f2ce319fd494d89a694148cf67ad1cccd4c8e20` | 68171789 | 2026-10-04T17:12:42.000Z |
| listed e8-11 (truth NO) | `0xfa4efc93…` | `0x1a334e6ffc76bb921605be098bbbd24480af5ebc3ba617eaa500e34e5977fbff` | 68171963 | 2026-10-04T17:13:34.000Z |
| listed e8-12 (truth NO) | `0x422ab2a1…` | `0x58521737d586109da41757b2ed4aae38e444cd1207f147580d3c09c83efd3d3c` | 68172124 | 2026-10-04T17:14:23.000Z |
| listed e8-13 (truth NO) | `0xd3439d77…` | `0x5770c3549677031d55bcace20e94d70846d2a54951d78227bbda7cba482595d1` | 68172282 | 2026-10-04T17:15:11.000Z |
| listed e8-14 (truth NO) | `0x5aac8ef0…` | `0xd3a9247bcaf111a7678d535fa37952fe8eb81aa526a4beb66069de9ad826cf15` | 68172432 | 2026-10-04T17:15:56.000Z |

| Result | Check | Detail |
| --- | --- | --- |
| PASS | all fifteen share one T | T 1791135900 |
