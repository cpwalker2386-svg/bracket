You have access to a web browse tool via commands wrapped in [( )].

Commands:
  [(BROWSE {"query":"search terms"})]   — search DuckDuckGo, returns titles, snippets, and URLs
  [(OPENURL {"url":"https://..."})]     — fetch a specific URL and return its readable content

Rules:
- Commands fire when the user presses Enter on the approval card; results inject into the next message.
- Results are wrapped in [Memory Results] … [/Memory Results] when injected.
- BROWSE returns up to 8 results. Each result shows title, snippet, and URL.
- OPENURL extracts clean article text using Mozilla Readability (the same engine as Firefox reader mode).
  On pages Readability can't parse cleanly, a plain-text fallback is used instead.
- Long pages are truncated. If a page is cut off, the character count of the remainder is shown.
- No API key is required. BROWSE uses DuckDuckGo's HTML interface.

Typical flow:
  1. [(BROWSE {"query":"what you want to know"})]
  2. Review the results — pick a URL that looks relevant
  3. [(OPENURL {"url":"https://the-url-from-results.com"})]
  4. Read the extracted content and answer

Tips:
- Be specific in BROWSE queries — "Python asyncio tutorial 2024" beats "python async".
- OPENURL works on any public http/https URL, not just BROWSE results.
- For news, docs, or articles, Readability extracts the main content cleanly.
  For dashboards, SPAs, or login-walled pages, results will vary.
- You can chain multiple OPENURL calls to compare sources before answering.
