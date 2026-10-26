# Sync config corpus

Real PowerSync sync configs, and copies with a planted leak, for testing the sync config
parser, lint and audit against configs we did not write. Each file in `real/` is copied
byte for byte from PowerSync's public demos; nothing is reformatted or annotated.

## Real configs

| File | Source | Format | License |
| --- | --- | --- | --- |
| `powersync-js-todolist.yaml` | powersync-js `demos/react-supabase-todolist/sync-config.yaml` at [js-current] | streams | CC0 1.0 |
| `powersync-js-group-chat.yaml` | powersync-js `demos/react-native-supabase-group-chat/sync-config.yaml` at [js-current] | streams | Apache 2.0 |
| `powersync-js-group-chat-legacy.yaml` | powersync-js `demos/react-native-supabase-group-chat/sync-rules.yml` at [js-legacy] | bucket definitions | Apache 2.0 |
| `powersync-js-text-collab.yaml` | powersync-js `demos/yjs-react-supabase-text-collab/sync-config.yaml` at [js-current] | streams | CC0 1.0 |
| `powersync-js-text-collab-legacy.yaml` | powersync-js `demos/yjs-react-supabase-text-collab/sync-rules.yaml` at [js-legacy] | bucket definitions | CC0 1.0 |
| `powersync-js-nextjs.yaml` | powersync-js `demos/example-nextjs/powersync/sync-config.yaml` at [js-current] | streams | CC0 1.0 |
| `powersync-js-multi-client.yaml` | powersync-js `demos/react-multi-client/sync-config.yaml` at [js-current] | streams | CC0 1.0 |
| `powersync-js-multi-client-legacy.yaml` | powersync-js `demos/react-multi-client/sync-rules.yaml` at [js-legacy] | bucket definitions | CC0 1.0 |
| `powersync-js-nuxt.yaml` | powersync-js `demos/nuxt-supabase-todolist/sync-config.yaml` at [js-current] | streams | Apache 2.0 |
| `powersync-js-nuxt-legacy.yaml` | powersync-js `demos/nuxt-supabase-todolist/sync-rules.yaml` at [js-legacy] | bucket definitions | Apache 2.0 |
| `powersync-js-time-based.yaml` | powersync-js `demos/react-supabase-time-based-sync/powersync/sync-config.yaml` at [js-current] | streams | Apache 2.0 |
| `powersync-dart-trello-legacy.yaml` | powersync.dart `demos/supabase-trello/sync-rules-1.yaml` at [dart-current] | bucket definitions | CC0 1.0 |
| `powersync-dart-trello-global-legacy.yaml` | powersync.dart `demos/supabase-trello/sync-rules-0.yaml` at [dart-current] | bucket definitions | CC0 1.0 |

Commits:

- [js-current]: [powersync-ja/powersync-js@11a6bf36e86d02dbab6e77ee0e5d28ab6b0842ef](https://github.com/powersync-ja/powersync-js/tree/11a6bf36e86d02dbab6e77ee0e5d28ab6b0842ef)
- [js-legacy]: [powersync-ja/powersync-js@b3371bd1a30e85126d19adad94825dc3b7791459](https://github.com/powersync-ja/powersync-js/tree/b3371bd1a30e85126d19adad94825dc3b7791459), the last commit before these demos moved from sync rules to sync streams
- [dart-current]: [powersync-ja/powersync.dart@4eed9aaebd645e1ed198abaadd3d65f32446aead](https://github.com/powersync-ja/powersync.dart/tree/4eed9aaebd645e1ed198abaadd3d65f32446aead)

`powersync-js-todolist.yaml` is the same file `examples/audit-todolist` fetches and audits.

## Licenses

The CC0 1.0 files come from demos that carry their own CC0 `LICENSE`, which places them in
the public domain. The Apache 2.0 files come from demos with no license of their own, so
the powersync-js repository's license applies: [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt)
is a copy of it, and the repository has no NOTICE file. Copyright in those files belongs to
their authors at JourneyApps (PowerSync).

PowerSync's `self-host-demo` repository also has sync configs, but it publishes no license,
so none of its files are copied here.

## Hashes

SHA-256 of each file in `real/`, so a copy that drifts from its source shows up:

```text
cdb4c5da98be9618f80f0ce2a7e0f13ddc277647af523d9b933b7762080604cd  powersync-js-todolist.yaml
49cf7478767edcb59e6be8b83002340d8a935bdce0afb4e1805e2ed669af7855  powersync-js-group-chat.yaml
21c2d7f26e8a676acb3b8009426a793aebd16158ab091eac8e0993ca25c0a969  powersync-js-group-chat-legacy.yaml
58e38306364a7e24771e654906a732ddd6c950d647ef38d47a9cd033af702698  powersync-js-text-collab.yaml
4a4b2c7baa93c175548a50e4e4add3b7bc2a0074e57edd8ca9d3971516515f64  powersync-js-text-collab-legacy.yaml
11b3224db116fb141b2256f393dec472c3e47595cbbd9d755f0910847d439a9b  powersync-js-nextjs.yaml
2144f2d7e5744ae39c9f9d6c503fc120c4e5f5bddc909113c728c9914f99e375  powersync-js-multi-client.yaml
391bede27bbff63156c24a3d520508c6d2a00ff507b4287765567f684465a0cb  powersync-js-multi-client-legacy.yaml
53da764edc424b07fef950ac98e918196471f8af0931d43ae2b056b5b48814f1  powersync-js-nuxt.yaml
28fc82339ae91795f0b7b411b5ec67b5c9ac1dbadff8f4badf11fd2d7e7eed6e  powersync-js-nuxt-legacy.yaml
04e386500521cc34ed659d5ba3f0b233a84006a765f8d93b52bbb70a3bcca9f0  powersync-js-time-based.yaml
1f1f455c54b9ac50d76d035f997ea21936772f3a9a423dcc1b909e6e4d2a4e38  powersync-dart-trello-legacy.yaml
8c31fc3821370b374ccdccdf25a6efed63fb1fa381598df5cf61b793c3698bd3  powersync-dart-trello-global-legacy.yaml
```
