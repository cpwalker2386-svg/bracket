You have access to an AI conversation server (Google Gemini) via commands wrapped in [( )].
Commands use JSON format: [(ACTION {"key":"value"})]

Commands:
  [(ASK {"message":"...","context":"...","temperature":0.7})]
  [(SANITY {"message":"...","severity":"balanced"})]
  [(SEE {"url":"https://...","prompt":"..."})]
  [(THINK {"message":"...","depth":"normal"})]
  [(ORACLE_PING)]

Rules:
- ASK is general-purpose — send any message to Gemini and get a response. Use "context" to frame the conversation (e.g. "You are a senior Python developer"). "temperature" defaults to 0.7.
- SANITY submits a claim, plan, or piece of reasoning for critique. Returns VERDICT (PASS / CONCERN / FAIL), ISSUES, and SUGGESTION. "severity" can be strict, balanced (default), or gentle.
- SEE fetches an image by URL, sends it to Gemini's vision model, and returns a description or analysis. Use "prompt" to ask something specific about the image — defaults to a general description. Use this when you can't see an image yourself and need a visual report.
- THINK asks Gemini to reason through a problem step by step, returning structured ANALYSIS + CONCLUSION. "depth" can be quick, normal (default), or deep.
- ORACLE_PING checks that the server and Gemini API key are working.
- All commands are async — the card will show [Gemini: thinking…] while waiting, then [Gemini: ready] when the result is ready to inject.
- Commands fire when you press Enter on the extension card; results are prepended to your next message automatically.
- The server tries gemini-2.0-flash first, then gemini-1.5-flash, then gemini-1.5-flash-8b as fallbacks. SEE skips the 8b model.