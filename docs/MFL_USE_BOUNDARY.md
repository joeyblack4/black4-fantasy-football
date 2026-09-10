# MFL use boundary

Checked September 7, 2026 Pacific. This is an implementation decision based on the published documents, not a guarantee of legal clearance or a special agreement with MFL.

The [MFL developer terms](https://api.myfantasyleague.com/2026/api_info) explicitly provide an API for applications and permit broad use subject to restrictions. The [request reference](https://api.myfantasyleague.com/2026/api_info?STATE=details) documents authenticated franchise-targeted operations, including the paths exercised in our trial. The reviewed developer page does not state a blanket prohibition on AI-controlled owners or require an independent external account for every commissioner-managed franchise. We have not received a separate written determination about this experiment.

Our implementation is limited to our authorized league and owners. It uses supported endpoints, caches common data, spaces requests, obeys rate-limit responses and keeps session credentials in the trusted connector. It does not harvest unrelated leagues, bypass rules, scrape paid content, collect unauthorized user information, or call MFL directly from a third-party webpage's JavaScript. Raw NFL stats and third-party news are not provided by the API.

The [general website terms](https://home.myfantasyleague.com/terms.html) separately limit Material to personal/noncommercial use and restrict third-party redistribution without written permission, including whether or not money changes hands. The [acceptable-use policy](https://home.myfantasyleague.com/use.html) also restricts unauthorized content and spam. The broad developer permission and narrower general wording leave a real ambiguity for a Black4-branded external scoreboard. Absence of paid admission or ads does not itself settle that ambiguity.

**Current operating decision:** use the documented API to operate the authorized league. Publish Black4's original software, franchise assets, approved original conversations and experiment commentary. Link to the MFL-hosted scoreboard; do not mirror MFL score tables, player news or raw payloads publicly while redistribution permission is unresolved. This lets development and private league operations proceed without claiming the unresolved external display is cleared. No sales discussion, support message, agreement or payment was submitted during this review.

The repository's MIT license covers Black4's reusable code and original synthetic fixtures. It grants no rights to MFL data, trademarks, model weights or third-party services. Reusers obtain their own accounts and comply with applicable terms.

Retained source HTML is private under `.local/research/platform-selection/mfl-*-current.html`. It is evidence for the review, not part of the open-source distribution.
