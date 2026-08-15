Here is your technical documentation formatted for **Confluence** (using Confluence Storage Format / Wiki Markup style structure with Info Macros, Code Blocks, and UI elements).

---

# 🎬 Architecture & Technical Specification: Totu & Kutu Cinema

| Document Status | Document Version | Target Audience | Key Contributor |
| --- | --- | --- | --- |
| **APPROVED** | `v1.0.0` | Engineering / Frontend / Ops | Lead Developer |

---

## 📄 Executive Summary

**Totu & Kutu Cinema** is a lightweight, serverless single-page application (SPA) designed to let users explore region-specific streaming catalog items across **Netflix**, **Amazon Prime Video**, and **JioHotstar**. Users can curate customized snack pairings and dynamically generate/export a downloadable, branded cinema ticket image directly in the client browser.

---

> ℹ️ **Confluence Info**
> **Key Architecture Choice:** Serverless Client-Side Rendering (CSR). The system uses zero dedicated backend servers, relying entirely on Cloudflare Workers at the edge for CORS control and secret injection, alongside in-browser DOM canvas rasterization for dynamic ticket production.

---

## 🏛️ System Architecture Overview

```
                                  +-------------------+
                                  |  TMDB API (v3)    |
                                  +---------+---------+
                                            ^
                                            | (Strict API Key)
                                            v
+------------------------+       +----------+----------+
|  Client (Browser)      | <---> | Cloudflare Worker   |
|  HTML5 / CSS3 / ES6    |       | Edge Proxy / CORS   |
+------------------------+       +---------------------+
           |
           v (HTML Canvas Rendering)
+------------------------+
| Client Ticket Generator|
|  (html2canvas Engine)  |
+------------------------+

```

---

## 🛠️ Technology Stack Breakdown

* **Frontend Frame:** Vanilla HTML5, CSS Variables, ES6 JavaScript.
* **Edge Proxy:** Cloudflare Workers (Serverless V8 isolate execution runtime).
* **Data Provider:** The Movie Database (TMDB v3 REST API).
* **Export Engine:** `html2canvas` v1.4.1 (DOM tree parsing to canvas element context).
* **UI Libraries:** FontAwesome 6.4 (Vector Icons), Google Fonts (Poppins).

---

## 🧩 Core Architectural Components

### 1. Cloudflare Worker Edge Proxy (`tmdb-proxy`)

To comply with client-side security standards and browser cross-origin limits:

* **API Key Obfuscation:** The private secret `TMDB_API_KEY` is maintained strictly within Cloudflare Worker environment variables, keeping it invisible to browser inspect tools.
* **CORS Preflight Handling:** Expressly handles `OPTIONS` HTTP preflight checks by injecting standard CORS control headers (`Access-Control-Allow-Origin: *`).
* **Route Normalization & Fallbacks:** Handles path matching from edge incoming paths (`/discover/movie`, `/search/tv`) directly to TMDB's base URL API (`[https://api.themoviedb.org/3](https://api.themoviedb.org/3)`), intercepting empty root calls (`/`) to avert standard 34 pathing errors.

```javascript
// Sample Edge Routing & Key Injection Logic
const url = new URL(request.url);
const params = new URLSearchParams(url.search);
params.set('api_key', env.TMDB_API_KEY);

const tmdbEndpoint = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
const tmdbUrl = `https://api.themoviedb.org/3${tmdbEndpoint}?${params.toString()}`;

```

---

### 2. Client Application Logic & Provider Mappings

Regional catalogs are filtered dynamically by passing TMDB provider IDs locked to region `IN` (India):

| Platform | Provider ID (`watch_region=IN`) | Color Code / Branding |
| --- | --- | --- |
| **Netflix** | `8` | `#E50914` |
| **Prime Video** | `119` | `#00A8E1` |
| **JioHotstar** | `2336` | `Linear Gradient` |

> ⚠️ **Warning: Avoid N+1 API Waterfalls**
> Do **not** fire individual provider verification requests (`/watch/providers`) sequentially inside the live search input event listener. Doing so will create an $N+1$ fetch waterfall, causing TMDB rate limiting and degradation in user input response. Use direct search queries (`/search/movie`) for live input filtering.

---

### 3. Client-Side Ticket Export Engine

The ticket generation flow executes without relying on backend canvas engines (like Node-Canvas or Puppeteer):

1. **State Injection:** Ticket data (`Movie Title`, `Snacks`, `Date`, `Spot`) populates a hidden DOM element `#ticket-wrapper`.
2. **CORS Image Hydration:** The TMDB poster source image requires `crossorigin="anonymous"` set on its DOM tag to prevent browser canvas security taint flags.
3. **Canvas Rasterization:** `html2canvas` converts computed CSS layout boxes into a 2D HTML5 canvas data buffer.
4. **File Pipeline Export:** The buffer converts to a PNG Base64 Data URI, prompting a clean programmatic download link click.

---

## ⚙️ Environment Configuration & Setup Guide

### Cloudflare Worker Configuration

1. Log in to your Cloudflare Dashboard $\rightarrow$ **Workers & Pages**.
2. Select or create your proxy worker named `tmdb-proxy`.
3. Under **Settings** $\rightarrow$ **Variables**, add the following entry:

| Variable Name | Type | Value |
| --- | --- | --- |
| `TMDB_API_KEY` | Secret (Encrypted) | `<YOUR_TMDB_V3_KEY>` |

---

### Local Frontend Setup

1. Clone your project code locally.
2. In `script.js`, update your API endpoint root:
```javascript
const WORKER_URL = 'https://tmdb-proxy.your-subdomain.workers.dev';

```


3. Run using any local development server (e.g., Live Server, `npx serve`, or deploy straight to GitHub Pages).