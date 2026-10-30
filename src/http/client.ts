import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import {
  readSessionState,
  writeSessionState,
} from "../storage/index.js";
import { cookiesToHeader, mergeSetCookies } from "../storage/cookies.js";
import { browserFetch } from "./cdp.js";

export type Headers = Record<string, string>;
export type QueryParams = Record<string, string | string[]>;

/** KIWERCLI_TRANSPORT=browser sends requests through the user's logged-in Chromium (see cdp.ts). */
export function useBrowser(): boolean {
  const t = process.env.KIWERCLI_TRANSPORT || "axios";
  if (t !== "axios" && t !== "browser") {
    throw new Error(`KIWERCLI_TRANSPORT must be "axios" or "browser", got "${t}".`);
  }
  return t === "browser";
}

function checkStatus(status: number, method: string, url: string, text: string): void {
  if (status < 400) return;
  if (status === 401 || status === 403) {
    throw new Error(
      useBrowser()
        ? `Auth error ${status} ${method} ${url}. Im Browser bei rewe.de einloggen.`
        : `Auth error ${status} ${method} ${url}. Session may be expired — re-run \`kiwercli import-cookies\` or set KIWERCLI_TRANSPORT=browser.`,
    );
  }
  throw new Error(`API error ${status} ${method} ${url}: ${text.slice(0, 500)}`);
}

const API_BASE = "https://www.rewe.de/shop/api";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function buildUrl(path: string, params?: QueryParams): string {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  const sp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (Array.isArray(val)) {
      for (const v of val) sp.append(key, v);
    } else {
      sp.append(key, val);
    }
  }
  return `${base}?${sp.toString()}`;
}

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/**
 * HTTP client for REWE API using axios.
 *
 * Reads cookies from session.json and injects them as Cookie header.
 * Updates stored cookies when Set-Cookie headers are received.
 */
export class ReweHttpClient {
  private ax: AxiosInstance;
  private cookies: StoredCookie[] = [];
  private loaded = false;

  constructor() {
    this.ax = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      // Don't follow redirects automatically — we need to handle cookies
      maxRedirects: 5,
      // Don't throw on non-2xx so we can handle errors ourselves
      validateStatus: () => true,
    });
  }

  /** Load cookies from disk on first use. */
  private async ensureCookies(): Promise<void> {
    if (this.loaded) return;
    const state = await readSessionState();
    if (state?.cookies) {
      this.cookies = state.cookies;
    }
    this.loaded = true;
  }

  /** Persist current cookies to disk. */
  async saveSession(): Promise<void> {
    await writeSessionState({ cookies: this.cookies, origins: [] });
  }

  /** Update cookies from Set-Cookie response headers. */
  private handleSetCookies(response: AxiosResponse): void {
    const setCookie = response.headers["set-cookie"];
    if (!setCookie) return;
    this.cookies = mergeSetCookies(this.cookies, setCookie);
  }

  private async request<T>(
    method: string,
    path: string,
    headers: Headers,
    params?: QueryParams,
    body?: unknown,
  ): Promise<T> {
    const url = buildUrl(path, params);
    if (body && !headers["Content-Type"] && !headers["content-type"]) {
      headers = { ...headers, "Content-Type": "application/json" };
    }

    if (useBrowser()) {
      const res = await browserFetch({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      checkStatus(res.status, method, url, res.body);
      try {
        return JSON.parse(res.body) as T;
      } catch {
        return res.body as T;
      }
    }

    await this.ensureCookies();
    const cookieHeader = cookiesToHeader(this.cookies, url);

    const response = await this.ax.request({
      method,
      url,
      headers: { ...headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      data: body,
    });

    this.handleSetCookies(response);
    checkStatus(
      response.status,
      method,
      url,
      typeof response.data === "string" ? response.data : JSON.stringify(response.data),
    );

    // Save cookies after successful requests
    await this.saveSession();

    return response.data as T;
  }

  async get<T>(
    path: string,
    headers: Headers = {},
    params?: QueryParams,
  ): Promise<T> {
    return this.request<T>("GET", path, headers, params);
  }

  async post<T>(
    path: string,
    headers: Headers = {},
    body?: unknown,
    params?: QueryParams,
  ): Promise<T> {
    return this.request<T>("POST", path, headers, params, body);
  }

  async patch<T>(
    path: string,
    headers: Headers = {},
    body?: unknown,
    params?: QueryParams,
  ): Promise<T> {
    return this.request<T>("PATCH", path, headers, params, body);
  }

  async delete<T>(
    path: string,
    headers: Headers = {},
    params?: QueryParams,
  ): Promise<T> {
    return this.request<T>("DELETE", path, headers, params);
  }

  async getBytes(
    path: string,
    headers: Headers = {},
    params?: QueryParams,
  ): Promise<Buffer> {
    const url = buildUrl(path, params);
    if (useBrowser()) {
      const res = await browserFetch({ method: "GET", url, headers, binary: true });
      checkStatus(res.status, "GET", url, "");
      return Buffer.from(res.body, "base64");
    }

    await this.ensureCookies();
    const cookieHeader = cookiesToHeader(this.cookies, url);

    const response = await this.ax.request({
      method: "GET",
      url,
      headers: { ...headers, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      responseType: "arraybuffer",
    });

    this.handleSetCookies(response);
    checkStatus(response.status, "GET", url, "");
    return Buffer.from(response.data);
  }

  /** No-op close for API compatibility. */
  async close(): Promise<void> {
    await this.saveSession();
  }
}
