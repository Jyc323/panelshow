# Security

PanelShow runs on your own computer and holds your API key, and it can share project folders with models. Please report security problems privately: open a [GitHub security advisory](https://github.com/Jyc323/panelshow/security/advisories/new) instead of a public issue.

## What PanelShow protects against
- **Other sites in your browser.** The server listens on `127.0.0.1` only and refuses requests with a foreign `Host` or `Origin`, and API requests the browser marks as cross-site.
- **Members reading outside a shared folder.** Only files found by the scan can be read; reads do not follow links and must open the same file the scan saw; the shared folder itself is re-checked; hard-linked files are skipped.
- **Secrets in shared folders and uploads.** Secret-named files and folders are skipped and credential-looking values are replaced by `[redacted]`.

## What it does not protect against
- **Anything a model reads is sent to the model provider:** GMI Cloud for cloud models, or your Ollama server for local models. Share only code and files you are allowed to send.
- **Redaction is best effort.** Use `.gitignore` or `.panelshowignore` to leave out files that must not be read.
- **Other programs on your computer** can call the local API, like any local app.
- **Text in pages and files can try to steer a model** (prompt injection). Members are told it is material, not instructions; this lowers the risk, it does not remove it.
