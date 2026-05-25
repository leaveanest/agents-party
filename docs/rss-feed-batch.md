# RSS Feed Batch

OSA-23 adds channel-scoped RSS feed subscriptions and a batch processor for LLM-generated Slack posts.

## Storage

RSS state is stored in PostgreSQL:

- `rss_feed_subscriptions`: enabled feeds per Slack team/channel.
- `rss_feed_fetch_cache`: RSS XML cache with `ETag` / `Last-Modified` conditional request metadata.
- `rss_processed_articles`: subscription/article processing log with a unique `(subscription_id, article_key)` constraint.

Slack workspace admins can add subscriptions from App Home. The add flow asks for a public
channel, feed URL, and RSS-specific posting prompt, verifies that the URL returns readable RSS/Atom
feed items, attempts to join the selected channel with `conversations.join`, then saves the
subscription. The prompt is stored in the subscription payload and applied when selecting items and
drafting Slack posts. Private channels still require inviting the app in Slack before RSS delivery.
Subscriptions can also be inserted through the repository or directly by operations tooling.

## Processing

Run one batch with:

```sh
vp run rss:batch
```

The packaged entrypoint is `dist/rssFeedWorker.mjs`, and the `Procfile` includes `rss_worker` for scheduler-style deployment.

Production scheduling is platform-specific:

- AWS uses EventBridge Scheduler to run `dist/rssFeedWorker.mjs` as a Fargate one-off task when
  `terraform/environments/aws` has `enable_rss_feed_schedule = true`.
- Heroku uses the Heroku Scheduler add-on provisioned by `terraform/environments/dev` when
  `enable_scheduler = true`; register the command `node dist/rssFeedWorker.mjs` in the Scheduler
  dashboard.

Batch behavior:

- loads enabled subscriptions
- fetches each RSS URL once per batch
- uses fresh DB cache without network access
- sends `If-None-Match` / `If-Modified-Since` when cache is stale
- does not fetch linked article pages in application code
- requires a `web_search` capable model and lets the provider-executed web search tool inspect or
  verify linked article URLs when drafting posts
- skips already processed `(subscription_id, article_key)` pairs
- resolves model as channel `default_model_id`, then workspace `default_model_id`
- asks the LLM once per subscription to choose feed items and draft Slack updates as JSON
- fails closed when no channel/workspace model is configured
- invokes the existing `ProviderRouter`
- posts through `src/slack/rssFeedPosts.ts`

The batch does not use an app-level OpenAI fallback. Provider API keys are resolved by the existing workspace credential path when the selected model provider requires credentials.
