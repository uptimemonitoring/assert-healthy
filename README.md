# assert-healthy

A GitHub Action that asserts one or more [uptimemonitoring.com](https://uptimemonitoring.com) monitors are healthy. Drop it into a workflow to gate a deploy, a canary, or any pipeline step on real-world reachability.

```yaml
- uses: uptimemonitoring/assert-healthy@v1
  with:
    api-key: ${{ secrets.UPTIMEMONITORING_API_KEY }}
    monitor-ids: ${{ vars.MONITOR_ID }}
```

If the monitor is healthy, the step exits 0. If it is `down`, the step exits 1 and prints the last evidence (region, HTTP status, latency, error). For multiple monitors, it evaluates each one and fails if any is unhealthy.

## Inputs

| Name                          | Required | Default | Description                                                                                                       |
| ----------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `api-key`                     | yes      | —       | An `umk_live_…` or `umk_test_…` API key. Pass it via a secret. The action calls `core.setSecret` to scrub it from logs. |
| `monitor-ids`                 | yes      | —       | One or more monitor IDs, comma- or newline-separated. Whitespace is ignored. Duplicates are de-duped.            |
| `strict-flapping`             | no       | `true`  | When `true`, a monitor in `flapping` state fails the step. Set to `false` to treat `flapping` as healthy.        |
| `unknown-retry-delay-seconds` | no       | `10`    | Brand-new or just-restarted monitors can sit in `unknown` for a few seconds. The action retries once after this delay; if still `unknown`, it fails. Max 600.  |

## Outputs

| Name              | Description                                                       |
| ----------------- | ----------------------------------------------------------------- |
| `unhealthy-count` | Number of monitors that were unhealthy.                           |
| `unhealthy-ids`   | Comma-separated IDs of unhealthy monitors. Empty on full success. |

## Status mapping

| Monitor status | Default behavior          | With `strict-flapping: false` |
| -------------- | ------------------------- | ----------------------------- |
| `up`           | pass                      | pass                          |
| `down`         | fail                      | fail                          |
| `flapping`     | fail                      | pass                          |
| `unknown`      | retry once, then fail     | retry once, then fail         |

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | All monitors healthy.                                                       |
| 1    | At least one monitor is unhealthy (the normal "deploy is bad" signal).      |
| 2    | Input error — missing or malformed `api-key` / `monitor-ids` / etc.         |
| 3    | Every monitor was unreachable due to transport errors (DNS, TLS, reset). The action could not get a verdict and is intentionally distinguishable from a down monitor. |

## Multi-monitor

```yaml
- uses: uptimemonitoring/assert-healthy@v1
  with:
    api-key: ${{ secrets.UPTIMEMONITORING_API_KEY }}
    monitor-ids: |
      111
      222
      333
```

Each monitor is checked independently. The step fails if any is unhealthy and lists the offenders in `unhealthy-ids`. A GitHub Step Summary table is rendered with one row per monitor.

## Pinning

| Pattern    | Behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `@v1`      | Auto-picks the latest 1.x.y release. Recommended for most workflows.      |
| `@v1.0.0`  | Frozen — never auto-upgrades. Use this when you need byte-stable behavior. |
| `@master`  | Bleeding edge. Not recommended.                                           |

When 1.x.y ships, the moving `v1` ref is force-updated to point at the new tag. A future `v2.0.0` will create a new `v2` ref and leave `v1` alone, so `@v1` users are never silently upgraded across major versions.

## Behavior on errors

- **HTTP 4xx (auth/permission/not-found)** — fails the step with the status and a one-line body excerpt. The API key is never echoed.
- **HTTP 5xx** — retried once internally before failing.
- **Transport errors (DNS, TLS, reset, timeout)** — fails the step. If every monitor in the run failed this way, the exit code is 3 instead of 1.

## Privacy

The action only contacts `https://api.uptimemonitoring.com`. It does not phone home, collect telemetry, or write outside the runner.

## License

MIT — see [LICENSE](LICENSE).
