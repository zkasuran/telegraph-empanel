# Panel eligibility

Generated 2026-09-04T12:06:37Z by `node data/build-data.mjs`. Counts are live, not hand-kept.

## The rule the app applies

A miner is seated as a juror on an intent when all five hold.

1. `activation_status` is active. 129 of 129 registered miners are.
2. `min_price_usdc` is exactly 10000, one cent a call. 127 miners sit on that floor.
3. It declares a `signal_mapping.label_field`, so there is a field to read the vote out of. 120 do.
4. Its `wallet_address` is not ours. 25 miners are ours, matched on the wallet in lowercase, never on an id range.
5. `adapters.json` carries an addressable endpoint for that exact intent, with every required param filled by a slot or a literal.

Above the floor, so excluded by rule 2:

- id 32 `bittensor-sn32-itsai` at 20000 (0.02 USDC a call)
- id 10001 `vulnfeed-onchain-security` at 100000 (0.10 USDC a call)

Rule 5 is the one that bites. A miner can pass the first four and still not be callable, because it declares no input_schema, or its required param is a pool address or a deal id that no claim carries. Those sit in the `needs_review` array of `adapters.json` with the reason. 26 of them would otherwise have been jurors.

## Jurors per intent

`declared` is the router's own miner_count. `jurors` is what survives the rule. `+geo` is jurors that need a geocode first, because the miner takes coordinates and no place name. `panel` is the largest odd panel the intent can seat.

| intent | declared | ours | adapters | jurors | +geo | panel |
| --- | --- | --- | --- | --- | --- | --- |
| CHAT_COMPLETION | 10 | 0 | 10 | 10 | 0 | 7 |
| LANGUAGE_GENERATION | 12 | 0 | 10 | 10 | 0 | 7 |
| ONCHAIN_TX_LOOKUP | 12 | 1 | 12 | 10 | 0 | 7 |
| TASK_COMPLETION | 11 | 0 | 10 | 10 | 0 | 7 |
| CRYPTO_PRICE | 14 | 1 | 11 | 9 | 0 | 7 |
| FRAUD_DETECTION | 15 | 0 | 9 | 9 | 0 | 7 |
| WALLET_BALANCE_CHECK | 10 | 1 | 10 | 8 | 0 | 7 |
| AGENT_TASK | 7 | 0 | 7 | 7 | 0 | 7 |
| URL_SCAN | 10 | 1 | 8 | 7 | 0 | 7 |
| GAS_PRICE | 9 | 1 | 8 | 6 | 0 | 3 |
| WEB_SEARCH | 10 | 0 | 6 | 6 | 0 | 3 |
| CURRENCY_EXCHANGE | 7 | 1 | 6 | 5 | 0 | 3 |
| RESEARCH_QUERY | 7 | 1 | 6 | 5 | 0 | 3 |
| TVL_LOOKUP | 10 | 1 | 6 | 5 | 0 | 3 |
| WEATHER_FORECAST | 14 | 1 | 13 | 5 | 7 | 3 |
| ACADEMIC_SEARCH | 6 | 1 | 5 | 4 | 0 | 3 |
| CVE_LOOKUP | 5 | 1 | 5 | 4 | 0 | 3 |
| FINANCIAL_DATA | 8 | 1 | 5 | 4 | 0 | 3 |
| IP_GEOLOCATION | 5 | 1 | 5 | 4 | 0 | 3 |
| NEWS_SEARCH | 5 | 1 | 5 | 4 | 0 | 3 |
| SSL_VERIFICATION | 6 | 1 | 5 | 4 | 0 | 3 |
| LANGUAGE_TRANSLATION | 4 | 1 | 4 | 3 | 0 | 3 |
| STOCK_PRICE | 5 | 1 | 4 | 3 | 0 | 3 |
| TOKEN_HOLDER_COUNT | 5 | 1 | 4 | 3 | 0 | 3 |
| WEATHER_CHECK | 11 | 1 | 10 | 3 | 6 | 3 |
| AI_TEXT_DETECTION | 4 | 0 | 2 | 2 | 0 | 1 |
| FACT_CHECK | 4 | 0 | 2 | 2 | 0 | 1 |
| GAME_RESULT | 3 | 1 | 3 | 2 | 0 | 1 |
| IMAGE_VERIFICATION | 2 | 0 | 2 | 2 | 0 | 1 |
| NEWS_HEADLINES | 3 | 1 | 3 | 2 | 0 | 1 |
| RESEARCH_SYNTHESIS | 4 | 1 | 3 | 2 | 0 | 1 |
| SPORTS_SCORE | 3 | 1 | 3 | 2 | 0 | 1 |
| STORM_ALERT | 7 | 1 | 7 | 2 | 4 | 1 |
| TELEGRAPH_KNOWLEDGE | 2 | 0 | 2 | 2 | 0 | 1 |
| TEXT_CLASSIFICATION | 3 | 0 | 2 | 2 | 0 | 1 |
| TEXT_GENERATION | 4 | 0 | 2 | 2 | 0 | 1 |
| CONTENT_EXTRACTION | 3 | 1 | 2 | 1 | 0 | 1 |
| CONTENT_MODERATION | 1 | 0 | 1 | 1 | 0 | 1 |
| CONTENT_VERIFICATION | 1 | 0 | 1 | 1 | 0 | 1 |
| DEEPFAKE_DETECTION | 1 | 0 | 1 | 1 | 0 | 1 |
| MEDIA_AUTHENTICITY_CHECK | 1 | 0 | 1 | 1 | 0 | 1 |
| SENTIMENT_ANALYSIS | 2 | 0 | 1 | 1 | 0 | 1 |
| TEXT_AUTHENTICITY_CHECK | 0 | 0 | 0 | 0 | 0 | none |
| TWITTER_SEARCH | 0 | 0 | 0 | 0 | 0 | none |
| VIDEO_VERIFICATION | 1 | 0 | 0 | 0 | 0 | none |

## What that seats

- 0 intents seat 11 independent jurors
- 9 seat 7
- 25 seat 3
- 17 seat only 1 or 2, so a panel there is a second opinion rather than a jury
- 3 seat none, including the two intents no miner declares at all

Totals: 222 (intent, miner) adapters, 176 of them eligible jurors, across 71 distinct miners.
