# Security and disclosure

Use this prototype only with test tokens. Contract tests and builds are not a security audit.

Private keys are accepted only by the server worker through process environment. Do not place them in frontend code, `VITE_*`, tickets, logs, screenshots or evidence files. The package excludes `.env` files, `.git`, private-key files and generated dependency folders. `.env.example` contains public configuration only. The original uploaded ZIP remains untouched and may contain credentials: review and rotate any credentials that were previously exposed before reusing them. Do not publish the original Git history without a separate secrets review.

The resolver is a trusted authority. A compromised resolver can choose a dishonest result within the allowed settlement window. The evidence digest is a commitment, not proof of factual truth, data availability or independent consensus. Use a separate funded testnet resolver account. There is no administrator sweep, token upgrade, resolver rotation or pause operation in this release. The refund path limits liveness failures, not dishonest resolution.

To report a vulnerability, use the repository owner's private reporting channel if configured, or contact the maintainer privately. No reporting email or GitHub security feature has been invented or configured by this work. Never include a live secret in a report. For payout, authorization or storage-restoration issues, provide a minimal reproduction using test identities.

The local profile backend stores public wallet identifiers, login times, session-token hashes and client-reported activity. Its data directory is private operational state and must not enter public source archives or static hosting. Sessions use explicit, short-lived message challenges and do not authorize any on-chain action. Reports must not be treated as verified transactions. Bind externally only after a separate deployment/authentication review; current defaults intentionally use loopback. Do not reuse resolver credentials for user sessions or future execution.
